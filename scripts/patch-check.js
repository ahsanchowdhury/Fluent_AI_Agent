import { checkPatchFile } from "../src/patchWorkflow.js";
import { getConfig, loadEnv } from "../src/env.js";

loadEnv();
const config = getConfig();
const patchPath = process.argv[2];

if (!patchPath) {
  console.error("Usage: npm run patch:check -- <memory/patches/file.patch>");
  process.exit(1);
}

try {
  const result = await checkPatchFile(config, patchPath);
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(`Patch rejected: ${error.message}`);
  process.exitCode = 1;
}
