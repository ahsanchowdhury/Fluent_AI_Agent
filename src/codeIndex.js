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
  ".csv",
  ".md",
  ".txt",
  ".xml",
  ".yml",
  ".yaml",
  ".sh",
]);
const DOC_BUNDLE_MAX_BYTES = 180 * 1024;

export function getIndexableFiles(config, options = {}) {
  const rootPath = options.path || ".";
  const maxFiles = options.maxFiles || config.indexMaxFiles || 300;
  return getIndexableFileEntries(config, { ...options, path: rootPath }).map((entry) => entry.path);
}

export function getIndexableFileEntries(config, options = {}) {
  const rootPath = options.path || ".";
  const maxFiles = options.maxFiles || config.indexMaxFiles || 300;
  const entries = [];

  if (shouldIncludeDocs(rootPath) && config.docsRoot && fs.existsSync(config.docsRoot)) {
    const maxDocs = options.maxDocs || config.indexMaxDocs || 500;
    const docsPath = docsPathFromIndexTarget(rootPath);
    const docs = maxDocs
      ? listFiles(config.docsRoot, { path: docsPath, maxFiles: maxDocs })
          .filter((file) => INDEXABLE_EXTENSIONS.has(path.extname(file).toLowerCase()))
          .map((file) => ({
            source: "docs",
            root: config.docsRoot,
            path: file,
            displayPath: `docs/${file}`,
          }))
      : [];
    entries.push(...docs);
  }

  if (!isDocsOnlyTarget(rootPath)) {
    const files = listFiles(config.pluginRoot, { path: rootPath, maxFiles });
    entries.push(
      ...files
        .filter((file) => INDEXABLE_EXTENSIONS.has(path.extname(file).toLowerCase()))
        .map((file) => ({
          source: "plugin",
          root: config.pluginRoot,
          path: file,
          displayPath: file,
        }))
    );
  }

  return entries;
}

export function buildIndexManifest(config, options = {}) {
  const files = getIndexableFileEntries(config, options);
  const skipped = [];
  const entries = [];

  for (const fileEntry of files) {
    try {
      const file = readTextFile(fileEntry.root, fileEntry.path);
      entries.push({
        path: fileEntry.displayPath,
        source: fileEntry.source,
        bytes: file.bytes,
        sha256: crypto.createHash("sha256").update(file.content).digest("hex"),
      });
    } catch (error) {
      skipped.push({
        path: fileEntry.displayPath,
        reason: error.message,
      });
    }
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    pluginRoot: config.pluginRoot,
    docsRoot: config.docsRoot || "",
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
  const files = getIndexableFileEntries(config, options);

  if (!files.length) {
    throw new Error("No indexable code or doc files found.");
  }

  const vectorStore = await client.vectorStores.create({
    name: options.name || "Local WordPress Plugin and Docs Memory",
    description:
      "Local WordPress plugin code and company documentation memory for the Fluent AI Agent development environment.",
    metadata: {
      plugin_root: config.pluginRoot.slice(0, 512),
      docs_root: String(config.docsRoot || "").slice(0, 512),
      indexed_path: options.path || ".",
    },
  });

  const uploadables = [];
  const uploadDocuments = buildUploadDocuments(files);
  for (const document of uploadDocuments) {
    uploadables.push(
      await toFile(Buffer.from(document.content, "utf8"), safeUploadName(document.name), {
        type: document.mimeType,
      })
    );
  }

  const batches = [];
  const uploadBatchSize = options.uploadBatchSize || 500;
  for (let index = 0; index < uploadables.length; index += uploadBatchSize) {
    const batchFiles = uploadables.slice(index, index + uploadBatchSize);
    batches.push(
      await client.vectorStores.fileBatches.uploadAndPoll(
        vectorStore.id,
        { files: batchFiles },
        { maxConcurrency: options.maxConcurrency || 3 }
      )
    );
  }

  const readyStore = await client.vectorStores.retrieve(vectorStore.id);

  return {
    vectorStore: readyStore,
    batch: batches.at(-1) || null,
    batches,
    files,
  };
}

function buildUploadDocuments(fileEntries) {
  const documents = [];
  const docGroups = new Map();

  for (const fileEntry of fileEntries) {
    let file;
    try {
      file = readTextFile(fileEntry.root, fileEntry.path);
    } catch (_error) {
      continue;
    }

    const section = [
      `Source: ${fileEntry.source}`,
      `Relative path: ${fileEntry.displayPath}`,
      `Bytes: ${file.bytes}`,
      "",
      file.content,
      "",
    ].join("\n");

    if (fileEntry.source !== "docs") {
      documents.push({
        name: fileEntry.displayPath,
        mimeType: mimeTypeForPath(fileEntry.displayPath),
        content: section,
      });
      continue;
    }

    const groupName = docBundleGroupName(fileEntry.displayPath);
    if (!docGroups.has(groupName)) {
      docGroups.set(groupName, []);
    }
    docGroups.get(groupName).push({
      path: fileEntry.displayPath,
      section,
    });
  }

  for (const [groupName, sections] of docGroups) {
    let part = 1;
    let content = [`Documentation bundle: ${groupName}`, ""].join("\n");

    for (const item of sections) {
      if (Buffer.byteLength(content) + Buffer.byteLength(item.section) > DOC_BUNDLE_MAX_BYTES && content.trim()) {
        documents.push({
          name: `docs/${groupName}-part-${part}.md`,
          mimeType: "text/markdown",
          content,
        });
        part += 1;
        content = [`Documentation bundle: ${groupName}`, ""].join("\n");
      }

      content += [
        `---`,
        `Document path: ${item.path}`,
        "",
        item.section,
      ].join("\n");
    }

    if (content.trim()) {
      documents.push({
        name: `docs/${groupName}-part-${part}.md`,
        mimeType: "text/markdown",
        content,
      });
    }
  }

  return documents;
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
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".xml": "application/xml",
    ".yml": "application/x-yaml",
    ".yaml": "application/x-yaml",
    ".sh": "application/x-sh",
  };

  return map[ext] || "text/plain";
}

function shouldIncludeDocs(rootPath) {
  return rootPath === "." || rootPath === "" || rootPath === "docs" || rootPath.startsWith("docs/");
}

function isDocsOnlyTarget(rootPath) {
  return rootPath === "docs" || rootPath.startsWith("docs/");
}

function docsPathFromIndexTarget(rootPath) {
  if (rootPath.startsWith("docs/")) {
    return rootPath.slice("docs/".length) || ".";
  }

  return ".";
}

function docBundleGroupName(displayPath) {
  const parts = displayPath.split("/");
  if (parts[0] === "docs" && parts[1] === "wpmanageninja-all-docs" && parts[2]) {
    return parts[2].replace(/[^a-zA-Z0-9._-]+/g, "-");
  }

  if (parts[0] === "docs" && parts[1]) {
    return parts[1].replace(/[^a-zA-Z0-9._-]+/g, "-");
  }

  return "company-docs";
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
