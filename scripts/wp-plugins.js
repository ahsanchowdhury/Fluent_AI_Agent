import { getConfig, loadEnv } from "../src/env.js";
import { wpCliPluginList } from "../src/tools/wordpress.js";

loadEnv();
const config = getConfig();
const result = await wpCliPluginList(config.pluginRoot);

console.log(`WordPress root: ${result.wordpressRoot}`);

if (!result.ok) {
  console.log("");
  console.log(result.message);
  process.exit(1);
}

for (const plugin of result.plugins) {
  console.log(`${plugin.name}\t${plugin.status}\t${plugin.version}`);
}
