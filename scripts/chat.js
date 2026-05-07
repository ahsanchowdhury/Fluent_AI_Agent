import readline from "readline";
import { stdin as input, stdout as output } from "process";
import { maybeAutoIndex } from "../src/autoIndex.js";
import { collectDebugContext, analyzeDebugContext, saveDebugContext } from "../src/debugWorkflow.js";
import { getConfig, loadEnv, maskSecret } from "../src/env.js";
import { createAgentResponse, createOpenAIClient } from "../src/openaiClient.js";
import { listFiles, listPluginDirectories, readTextFile } from "../src/tools/filesystem.js";

loadEnv();
const config = getConfig();
const client = createOpenAIClient(config);
const rl = readline.createInterface({
  input,
  output,
  prompt: "\nYou> ",
});
let previousResponseId = null;
const isInteractive = Boolean(input.isTTY);

printHeader();
if (config.autoIndexOnChat) {
  console.log("Checking dynamic code memory before chat...");
  const result = await maybeAutoIndex(config, "chat");
  console.log(result.message);
}
if (isInteractive) {
  rl.prompt();
}

for await (const line of rl) {
  const message = line.trim();

  if (!message) {
    promptAgain();
    continue;
  }

  if (["/exit", "/quit", "exit", "quit"].includes(message.toLowerCase())) {
    console.log("Bye.");
    break;
  }

  if (message === "/help") {
    printHelp();
    promptAgain();
    continue;
  }

  if (message === "/reset") {
    previousResponseId = null;
    console.log("Conversation reset.");
    promptAgain();
    continue;
  }

  try {
    if (message === "/plugins") {
      printPlugins();
      promptAgain();
      continue;
    }

    if (message.startsWith("/files")) {
      printFiles(message);
      promptAgain();
      continue;
    }

    if (message.startsWith("/read")) {
      printFile(message);
      promptAgain();
      continue;
    }

    if (message.startsWith("/debug")) {
      await runDebug(message);
      previousResponseId = null;
      promptAgain();
      continue;
    }

    const result = await createAgentResponse(client, {
      input: message,
      config,
      previousResponseId,
    });
    previousResponseId = result.responseId;
    console.log(`\nAgent> ${result.text}`);
  } catch (error) {
    console.error(`\nError: ${error.message}`);
  }

  promptAgain();
}

rl.close();

function printHeader() {
  console.log("Local WP AI Agent Chat");
  console.log("======================");
  console.log(`Site: ${config.localSiteUrl}`);
  console.log(`Model: ${config.openaiModel}`);
  console.log(`Code memory: ${config.openaiVectorStoreId || "not indexed"}`);
  console.log(`OpenAI key: ${config.openaiApiKey ? maskSecret(config.openaiApiKey) : "missing"}`);
  printHelp();
}

function printHelp() {
  console.log("");
  console.log("Commands:");
  console.log("  /help                 Show this help");
  console.log("  /plugins              List local plugins");
  console.log("  /files <path>         List readable files, e.g. /files my-shop");
  console.log("  /read <file>          Print a safe file, e.g. /read my-shop/my-shop-loyalty.php");
  console.log("  /debug [path]         Run guided debug workflow, e.g. /debug wp-admin");
  console.log("  /reset                Reset conversation memory");
  console.log("  /exit                 Quit");
}

function printPlugins() {
  const plugins = listPluginDirectories(config.pluginRoot);
  for (const plugin of plugins) {
    const main = plugin.mainFiles
      .map((file) => file.replace(`${config.pluginRoot}/`, ""))
      .join(", ") || "No plugin header found";
    console.log(`- ${plugin.name}: ${main}`);
  }
}

function printFiles(message) {
  const target = message.replace(/^\/files\s*/, "").trim() || ".";
  const files = listFiles(config.pluginRoot, { path: target, maxFiles: 300 });
  console.log(`Files under ${target}: ${files.length}`);
  for (const file of files) {
    console.log(file);
  }
}

function printFile(message) {
  const target = message.replace(/^\/read\s*/, "").trim();

  if (!target) {
    console.log("Usage: /read <relative-file-path>");
    return;
  }

  const file = readTextFile(config.pluginRoot, target);
  console.log(`Path: ${file.path}`);
  console.log(`Bytes: ${file.bytes}`);
  console.log("");
  console.log(file.content);
}

async function runDebug(message) {
  const target = message.replace(/^\/debug\s*/, "").trim();
  console.log("Collecting diagnostics...");
  const context = await collectDebugContext(config, {
    path: target,
    logLines: 120,
  });
  const contextPath = saveDebugContext(context);
  console.log(`Saved diagnostic context: ${contextPath}`);
  console.log("Analyzing diagnostics...");
  const answer = await analyzeDebugContext(
    client,
    config,
    context,
    target ? `Debug local WordPress target: ${target}` : "Debug the configured local WordPress homepage."
  );
  console.log(`\nAgent> ${answer}`);
}

function promptAgain() {
  if (isInteractive) {
    rl.prompt();
  }
}
