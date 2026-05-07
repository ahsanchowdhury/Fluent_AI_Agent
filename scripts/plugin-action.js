import { getConfig, loadEnv } from "../src/env.js";
import { changePluginStatus } from "../src/tools/wordpress.js";

loadEnv();
const config = getConfig();
const [action, pluginFile, approval] = process.argv.slice(2);

if (!["activate", "deactivate"].includes(action) || !pluginFile) {
  console.error("Usage: npm run wp:plugin -- <activate|deactivate> <plugin-file> --yes");
  process.exit(1);
}

if (approval !== "--yes") {
  console.error("Refusing to change plugin status without --yes.");
  process.exit(1);
}

const result = await changePluginStatus(config, pluginFile, action);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
