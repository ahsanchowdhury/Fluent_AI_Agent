import {
  buildIndexManifest,
  diffManifests,
  readSavedManifest,
  syncCodeVectorStore,
} from "../src/codeIndex.js";
import { getConfig, loadEnv } from "../src/env.js";
import { createOpenAIClient } from "../src/openaiClient.js";

loadEnv();
const config = getConfig();
const args = process.argv.slice(2);
const shouldUpload = args.includes("--yes");
const targetPath = args.find((arg) => !arg.startsWith("--")) || ".";
const current = buildIndexManifest(config, { path: targetPath });
const previous = readSavedManifest();
const diff = diffManifests(previous, current);

printSummary(current, diff, previous);

if (!diff.changed) {
  console.log("");
  console.log("Index is already in sync.");
  process.exit(0);
}

if (!shouldUpload) {
  console.log("");
  console.log("Dry run only. Add --yes to create a fresh vector store for the current plugin code and docs.");
  process.exit(0);
}

const client = createOpenAIClient(config);
const result = await syncCodeVectorStore(client, config, { path: targetPath });

console.log("");
console.log("Dynamic index sync complete.");
console.log(`Changed: ${result.changed ? "yes" : "no"}`);
console.log(`Vector store ID: ${result.vectorStoreId}`);
console.log(`Manifest: ${result.manifestPath}`);

function printSummary(manifest, change, previousManifest) {
  console.log(`Index target: ${manifest.indexedPath}`);
  console.log(`Current files: ${manifest.fileCount}`);
  console.log(`Skipped files: ${manifest.skippedCount || 0}`);
  console.log(`Current bytes: ${manifest.totalBytes}`);
  console.log(`Previous vector store: ${previousManifest?.vectorStoreId || "none"}`);
  console.log("");
  console.log(`Added: ${change.added.length}`);
  console.log(`Changed: ${change.changedFiles.length}`);
  console.log(`Removed: ${change.removed.length}`);

  for (const label of ["added", "changedFiles", "removed"]) {
    const files = change[label];
    if (!files.length) {
      continue;
    }

    console.log("");
    console.log(`${label}:`);
    for (const file of files.slice(0, 40)) {
      console.log(`- ${file}`);
    }
    if (files.length > 40) {
      console.log(`...and ${files.length - 40} more`);
    }
  }

  if (manifest.skipped?.length) {
    console.log("");
    console.log("skipped:");
    for (const file of manifest.skipped.slice(0, 20)) {
      console.log(`- ${file.path}: ${file.reason}`);
    }
    if (manifest.skipped.length > 20) {
      console.log(`...and ${manifest.skipped.length - 20} more`);
    }
  }
}
