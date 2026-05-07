import { getConfig, loadEnv, maskSecret } from "./env.js";
import { askModel, createOpenAIClient } from "./openaiClient.js";

loadEnv();
const config = getConfig();
const prompt = process.argv.slice(2).join(" ").trim();

async function main() {
  console.log("Local WP AI Agent");
  console.log("=================");
  console.log(`Plugin root: ${config.pluginRoot}`);
  console.log(`Local site: ${config.localSiteUrl}`);
  console.log(`Model: ${config.openaiModel}`);
  console.log(`Code memory: ${config.openaiVectorStoreId || "not indexed"}`);
  console.log(`OpenAI key: ${config.openaiApiKey ? maskSecret(config.openaiApiKey) : "missing"}`);
  console.log("");

  if (!prompt) {
    console.log("Usage:");
    console.log('  npm start -- "What can you inspect right now?"');
    console.log("");
    console.log("Run `npm run doctor` to check the local environment.");
    return;
  }

  const client = createOpenAIClient(config);
  const answer = await askModel(client, { input: prompt, config });
  console.log(answer);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
