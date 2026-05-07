import { getConfig, loadEnv } from "../src/env.js";
import { tailDebugLog } from "../src/tools/wordpress.js";

loadEnv();
const config = getConfig();
const lines = Number(process.argv[2] || 120);
const result = tailDebugLog(config.wpDebugLog, lines);

if (!result.exists) {
  console.log(result.message);
  process.exit(0);
}

console.log(`Path: ${result.path}`);
console.log(`Bytes: ${result.bytes}`);
console.log(`Lines: ${result.lines}`);
console.log("");
console.log(result.content);
