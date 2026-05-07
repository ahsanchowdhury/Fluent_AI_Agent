import { getConfig, loadEnv } from "../src/env.js";
import { debugPage } from "../src/tools/browser.js";

loadEnv();
const config = getConfig();
const target = process.argv[2] || "";
const result = await debugPage(config, { path: target });

console.log(JSON.stringify(result, null, 2));
