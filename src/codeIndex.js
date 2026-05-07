import fs from "fs";
import path from "path";
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
