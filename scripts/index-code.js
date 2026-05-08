import { createCodeVectorStore, getIndexableFiles, saveVectorStoreId } from "../src/codeIndex.js";
import { getConfig, loadEnv } from "../src/env.js";
import { createOpenAIClient } from "../src/openaiClient.js";

loadEnv();
const config = getConfig();
const args = process.argv.slice(2);
const shouldUpload = args.includes("--yes");
const targetPath = args.find((arg) => !arg.startsWith("--")) || ".";
const files = getIndexableFiles(config, { path: targetPath });

console.log(`Index target: ${targetPath}`);
console.log(`Indexable code/doc files: ${files.length}`);
console.log("");

for (const file of files.slice(0, 80)) {
  console.log(file);
}

if (files.length > 80) {
  console.log(`...and ${files.length - 80} more`);
}

if (!shouldUpload) {
  console.log("");
  console.log("Dry run only. Add --yes to create an OpenAI vector store and upload these code/doc files.");
  process.exit(0);
}

const client = createOpenAIClient(config);
const result = await createCodeVectorStore(client, config, { path: targetPath });
const memoryPath = saveVectorStoreId(config, result.vectorStore.id);

console.log("");
console.log("Vector store created and indexed.");
console.log(`Vector store ID: ${result.vectorStore.id}`);
console.log(`Status: ${result.vectorStore.status}`);
console.log(`Files total: ${result.vectorStore.file_counts?.total ?? files.length}`);
console.log(`Files completed: ${result.vectorStore.file_counts?.completed ?? "unknown"}`);
console.log(`Saved ID: ${memoryPath}`);
console.log("The .env file was updated with OPENAI_VECTOR_STORE_ID.");
