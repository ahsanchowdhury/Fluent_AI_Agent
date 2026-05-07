import { getConfig, loadEnv } from "../src/env.js";
import { listFiles } from "../src/tools/filesystem.js";

loadEnv();
const config = getConfig();
const target = process.argv[2] || ".";
const files = listFiles(config.pluginRoot, { path: target, maxFiles: 1000 });

console.log(`Found ${files.length} text/code files under ${target}`);
console.log("");

for (const file of files) {
  console.log(file);
}
