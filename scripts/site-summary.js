import { getConfig, loadEnv } from "../src/env.js";
import { getWordPressSiteSummary } from "../src/tools/wordpress.js";

loadEnv();
const config = getConfig();
const result = await getWordPressSiteSummary(config);

if (!result.ok) {
  console.error(result.message);
  process.exit(1);
}

console.log(JSON.stringify(result.summary, null, 2));
