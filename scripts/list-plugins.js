import { getConfig, loadEnv } from "../src/env.js";
import { listPluginDirectories } from "../src/tools/filesystem.js";

loadEnv();
const config = getConfig();
const plugins = listPluginDirectories(config.pluginRoot);

console.log(`Found ${plugins.length} plugin directories`);
console.log("");

for (const plugin of plugins) {
  const mainFiles = plugin.mainFiles.length
    ? plugin.mainFiles.map((file) => file.replace(`${config.pluginRoot}/`, "")).join(", ")
    : "No plugin header found";

  console.log(`- ${plugin.name}`);
  console.log(`  Main: ${mainFiles}`);
}
