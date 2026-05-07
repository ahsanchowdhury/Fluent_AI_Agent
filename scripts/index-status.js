import { buildIndexManifest, diffManifests, readSavedManifest } from "../src/codeIndex.js";
import { getConfig, loadEnv } from "../src/env.js";

loadEnv();
const config = getConfig();
const current = buildIndexManifest(config, { path: "." });
const previous = readSavedManifest();
const diff = diffManifests(previous, current);

console.log(`Configured vector store: ${config.openaiVectorStoreId || "none"}`);
console.log(`Saved manifest vector store: ${previous?.vectorStoreId || "none"}`);
console.log(`Current files: ${current.fileCount}`);
console.log(`Skipped files: ${current.skippedCount || 0}`);
console.log(`Current bytes: ${current.totalBytes}`);
console.log(`Manifest exists: ${previous ? "yes" : "no"}`);
console.log(`In sync: ${!diff.changed && Boolean(previous) ? "yes" : "no"}`);
console.log("");
console.log(`Added: ${diff.added.length}`);
console.log(`Changed: ${diff.changedFiles.length}`);
console.log(`Removed: ${diff.removed.length}`);
