import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { spawn } from "child_process";
import { getConfig, loadEnv, maskSecret } from "../src/env.js";
import { listPluginDirectories } from "../src/tools/filesystem.js";

loadEnv();
const config = getConfig();
const scriptedAnswers = input.isTTY ? [] : await readAllInput();
const rl = input.isTTY ? readline.createInterface({ input, output }) : null;

while (true) {
  printMenu();
  const choice = await ask("Choose an option: ");

  try {
    if (choice === "1") {
      await runNpm(["run", "chat"]);
    } else if (choice === "2") {
      await runNpm(["run", "debug"]);
    } else if (choice === "3") {
      const target = await ask("Path to debug, e.g. wp-admin: ");
      await runNpm(["run", "debug", "--", target]);
    } else if (choice === "4") {
      await runNpm(["run", "index:status"]);
    } else if (choice === "5") {
      await runNpm(["run", "index:sync"]);
      const answer = (await ask("Run sync now with --yes if changes were found? (y/N): ")).toLowerCase();
      if (answer === "y" || answer === "yes") {
        await runNpm(["run", "index:sync", "--", "--yes"]);
      }
    } else if (choice === "6") {
      printPlugins();
    } else if (choice === "7") {
      const request = await ask("Describe the patch you want proposed: ");
      if (request) {
        await runNpm(["run", "patch:propose", "--", request]);
      }
    } else if (choice === "8") {
      await runNpm(["run", "doctor"]);
    } else if (choice === "9" || choice.toLowerCase() === "q") {
      console.log("Bye.");
      break;
    } else {
      console.log("Unknown option.");
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
  }

  await ask("\nPress Enter to return to the menu...");
}

rl?.close();

function printMenu() {
  console.clear();
  console.log("Local WP AI Agent");
  console.log("=================");
  console.log(`Site: ${config.localSiteUrl}`);
  console.log(`Model: ${config.openaiModel}`);
  console.log(`Code memory: ${config.openaiVectorStoreId || "not indexed"}`);
  console.log(`OpenAI key: ${config.openaiApiKey ? maskSecret(config.openaiApiKey) : "missing"}`);
  console.log("");
  console.log("1. Chat");
  console.log("2. Debug homepage");
  console.log("3. Debug path");
  console.log("4. Show index status");
  console.log("5. Sync code memory");
  console.log("6. List plugins");
  console.log("7. Propose patch");
  console.log("8. Doctor check");
  console.log("9. Exit");
  console.log("");
}

function printPlugins() {
  const plugins = listPluginDirectories(config.pluginRoot);
  console.log("");
  for (const plugin of plugins) {
    const main = plugin.mainFiles
      .map((file) => file.replace(`${config.pluginRoot}/`, ""))
      .join(", ") || "No plugin header found";
    console.log(`- ${plugin.name}: ${main}`);
  }
}

async function ask(question) {
  if (scriptedAnswers.length) {
    const answer = scriptedAnswers.shift();
    output.write(`${question}${answer}\n`);
    return answer;
  }

  if (!rl) {
    return "";
  }

  return (await rl.question(question)).trim();
}

function readAllInput() {
  return new Promise((resolve) => {
    let raw = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      raw += chunk;
    });
    input.on("end", () => {
      resolve(raw.split(/\r?\n/).map((line) => line.trim()));
    });
  });
}

function runNpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed: npm ${args.join(" ")}`));
    });
  });
}
