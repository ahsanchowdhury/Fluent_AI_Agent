import fs from "fs";
import path from "path";
import crypto from "crypto";
import { toFile } from "openai";
import { listFiles, readTextFile } from "./tools/filesystem.js";

const INDEXABLE_EXTENSIONS = new Set([
  ".php",
  ".js",
  ".ts",
  ".css",
  ".html",
  ".json",
  ".md",
  ".txt",
  ".sh",
]);

export function getIndexableFiles(config, options = {}) {
  const rootPath = options.path || ".";
  const maxFiles = options.maxFiles || config.indexMaxFiles || 300;
  const files = listFiles(config.pluginRoot, { path: rootPath, maxFiles });

  return files.filter((file) => INDEXABLE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

export function buildIndexManifest(config, options = {}) {
  const files = getIndexableFiles(config, options);
  const skipped = [];
  const entries = [];

  for (const relativePath of files) {
    try {
      const file = readTextFile(config.pluginRoot, relativePath);
      entries.push({
        path: relativePath,
        bytes: file.bytes,
        sha256: crypto.createHash("sha256").update(file.content).digest("hex"),
      });
    } catch (error) {
      skipped.push({
        path: relativePath,
        reason: error.message,
      });
    }
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    pluginRoot: config.pluginRoot,
    indexedPath: options.path || ".",
    fileCount: entries.length,
    skippedCount: skipped.length,
    totalBytes,
    files: entries,
    skipped,
  };
}

export function readSavedManifest() {
  const manifestPath = getManifestPath();
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

export function saveManifest(manifest, vectorStore) {
  const manifestPath = getManifestPath();
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        ...manifest,
        vectorStoreId: vectorStore.id,
        vectorStoreStatus: vectorStore.status,
        indexedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
  return manifestPath;
}

export function diffManifests(previous, current) {
  if (!previous) {
    return {
      changed: true,
      added: current.files.map((file) => file.path),
      changedFiles: [],
      removed: [],
    };
  }

  const previousByPath = new Map(previous.files.map((file) => [file.path, file]));
  const currentByPath = new Map(current.files.map((file) => [file.path, file]));
  const added = [];
  const changedFiles = [];
  const removed = [];

  for (const file of current.files) {
    const oldFile = previousByPath.get(file.path);
    if (!oldFile) {
      added.push(file.path);
    } else if (oldFile.sha256 !== file.sha256) {
      changedFiles.push(file.path);
    }
  }

  for (const file of previous.files) {
    if (!currentByPath.has(file.path)) {
      removed.push(file.path);
    }
  }

  return {
    changed: Boolean(added.length || changedFiles.length || removed.length),
    added,
    changedFiles,
    removed,
  };
}

export async function createCodeVectorStore(client, config, options = {}) {
  const files = getIndexableFiles(config, options);

  if (!files.length) {
    throw new Error("No indexable code files found.");
  }

  const vectorStore = await client.vectorStores.create({
    name: options.name || "Local WordPress Plugin Code",
    description:
      "Local WordPress plugin code memory for the Fluent AI Agent development environment.",
    metadata: {
      plugin_root: config.pluginRoot.slice(0, 512),
      indexed_path: options.path || ".",
    },
  });

  const uploadables = [];

  for (const relativePath of files) {
    const file = readTextFile(config.pluginRoot, relativePath);
    const content = [
      `Relative path: ${file.path}`,
      `Bytes: ${file.bytes}`,
      "",
      file.content,
    ].join("\n");

    uploadables.push(
      await toFile(Buffer.from(content, "utf8"), safeUploadName(relativePath), {
        type: mimeTypeForPath(relativePath),
      })
    );
  }

  const batch = await client.vectorStores.fileBatches.uploadAndPoll(
    vectorStore.id,
    { files: uploadables },
    { maxConcurrency: options.maxConcurrency || 3 }
  );

  const readyStore = await client.vectorStores.retrieve(vectorStore.id);

  return {
    vectorStore: readyStore,
    batch,
    files,
  };
}

export async function syncCodeVectorStore(client, config, options = {}) {
  const currentManifest = buildIndexManifest(config, options);
  const previousManifest = readSavedManifest();
  const diff = diffManifests(previousManifest, currentManifest);

  if (!diff.changed && config.openaiVectorStoreId) {
    return {
      changed: false,
      diff,
      manifest: previousManifest,
      vectorStoreId: config.openaiVectorStoreId,
    };
  }

  const result = await createCodeVectorStore(client, config, options);
  saveVectorStoreId(config, result.vectorStore.id);
  const manifestPath = saveManifest(currentManifest, result.vectorStore);

  return {
    changed: true,
    diff,
    manifest: currentManifest,
    manifestPath,
    vectorStoreId: result.vectorStore.id,
    vectorStore: result.vectorStore,
  };
}

export function saveVectorStoreId(config, vectorStoreId) {
  const memoryPath = path.resolve(process.cwd(), "memory", "vector-store-id.txt");
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  fs.writeFileSync(memoryPath, `${vectorStoreId}\n`, "utf8");
  upsertEnvValue(path.resolve(process.cwd(), ".env"), "OPENAI_VECTOR_STORE_ID", vectorStoreId);
  return memoryPath;
}

function safeUploadName(relativePath) {
  return relativePath.replace(/[^a-zA-Z0-9._-]+/g, "__");
}

function getManifestPath() {
  return path.resolve(process.cwd(), "memory", "index-manifest.json");
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".php": "text/x-php",
    ".js": "text/javascript",
    ".ts": "application/typescript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".sh": "application/x-sh",
  };

  return map[ext] || "text/plain";
}

function upsertEnvValue(envPath, key, value) {
  const line = `${key}=${value}`;

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${line}\n`, "utf8");
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const index = lines.findIndex((existing) => existing.startsWith(`${key}=`));

  if (index === -1) {
    const suffix = lines.at(-1) === "" ? "" : "\n";
    fs.appendFileSync(envPath, `${suffix}${line}\n`, "utf8");
    return;
  }

  lines[index] = line;
  fs.writeFileSync(envPath, lines.join("\n"), "utf8");
}
