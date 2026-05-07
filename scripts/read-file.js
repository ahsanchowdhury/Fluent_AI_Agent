import { getConfig, loadEnv } from "../src/env.js";
import { readTextFile } from "../src/tools/filesystem.js";

loadEnv();
const config = getConfig();
const target = process.argv[2];

if (!target) {
  console.error("Usage: npm run read:file -- <relative-file-path>");
  process.exit(1);
}

const file = readTextFile(config.pluginRoot, target);

console.log(`Path: ${file.path}`);
console.log(`Bytes: ${file.bytes}`);
console.log("");
console.log(file.content);
