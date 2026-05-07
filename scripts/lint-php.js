import { getConfig, loadEnv } from "../src/env.js";
import { lintPhpFile } from "../src/tools/wordpress.js";

loadEnv();
const config = getConfig();
const target = process.argv[2];

if (!target) {
  console.error("Usage: npm run lint:php -- <relative-php-file>");
  process.exit(1);
}

const result = await lintPhpFile(config.pluginRoot, target);

console.log(`Path: ${result.path}`);
console.log(result.message);
process.exitCode = result.ok ? 0 : 1;
