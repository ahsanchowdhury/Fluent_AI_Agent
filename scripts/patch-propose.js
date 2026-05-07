import { getConfig, loadEnv } from "../src/env.js";
import { createOpenAIClient } from "../src/openaiClient.js";
import { proposePatch } from "../src/patchWorkflow.js";

loadEnv();
const config = getConfig();
const requestText = process.argv.slice(2).join(" ").trim();

if (!requestText) {
  console.error('Usage: npm run patch:propose -- "Describe the change"');
  process.exit(1);
}

const client = createOpenAIClient(config);
try {
  const result = await proposePatch(client, config, requestText);

  console.log(result.text);
  console.log("");
  console.log("Generated validated patch:");
  console.log("```diff");
  console.log(result.patch.trim());
  console.log("```");
  console.log("");
  console.log(`Saved patch: ${result.savedPath}`);
  console.log("");
  console.log("Review the patch carefully. To apply it, run:");
  console.log(`npm run patch:apply -- ${result.savedPath}`);
} catch (error) {
  console.error(`Patch proposal failed: ${error.message}`);
  process.exitCode = 1;
}
