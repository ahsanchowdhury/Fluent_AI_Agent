import { analyzeDebugContext, collectDebugContext, saveDebugContext } from "../src/debugWorkflow.js";
import { maybeAutoIndex } from "../src/autoIndex.js";
import { getConfig, loadEnv } from "../src/env.js";
import { createOpenAIClient } from "../src/openaiClient.js";

loadEnv();
const config = getConfig();
const args = process.argv.slice(2);
const targetPath = args.find((arg) => !arg.startsWith("--")) || "";
const userRequest = args.length
  ? `Debug local WordPress target: ${targetPath || "/"}`
  : "Debug the configured local WordPress homepage.";

if (config.autoIndexOnDebug) {
  console.log("Checking dynamic code memory before debug...");
  const result = await maybeAutoIndex(config, "debug");
  console.log(result.message);
}

console.log("Collecting diagnostics...");
const context = await collectDebugContext(config, {
  path: targetPath,
  logLines: 120,
});
const contextPath = saveDebugContext(context);

console.log(`Saved diagnostic context: ${contextPath}`);
console.log("Analyzing diagnostics with OpenAI...");
console.log("");

const client = createOpenAIClient(config);
const answer = await analyzeDebugContext(client, config, context, userRequest);
console.log(answer);
