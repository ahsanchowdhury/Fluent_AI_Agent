import fs from "fs";
import { getConfig, loadEnv, maskSecret } from "../src/env.js";
import {
  checkUrl,
  commandVersion,
  getNodeMajorVersion,
  pathExists,
} from "../src/tools/system.js";

function line(status, label, detail) {
  const marker = status === "ok" ? "OK" : status === "warn" ? "WARN" : "FAIL";
  console.log(`[${marker}] ${label}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  const env = loadEnv();
  const config = getConfig();

  console.log("Local WP AI Agent Doctor");
  console.log("========================");

  line(env.loaded ? "ok" : "warn", ".env", env.loaded ? env.envPath : "Missing. Copy .env.example to .env when ready.");

  const nodeMajor = getNodeMajorVersion();
  line(
    nodeMajor >= 18 ? "ok" : "warn",
    "Node.js",
    `${process.version}${nodeMajor >= 18 ? "" : " detected. Node 18+ is recommended for later OpenAI and Playwright steps."}`
  );

  line(
    config.openaiApiKey ? "ok" : "warn",
    "OPENAI_API_KEY",
    config.openaiApiKey ? maskSecret(config.openaiApiKey) : "Missing. Needed when we add the OpenAI agent brain."
  );

  line(
    pathExists(config.pluginRoot) ? "ok" : "fail",
    "PLUGIN_ROOT",
    config.pluginRoot
  );

  line(
    pathExists(config.wpDebugLog) ? "ok" : "warn",
    "WP_DEBUG_LOG",
    pathExists(config.wpDebugLog)
      ? config.wpDebugLog
      : `${config.wpDebugLog} does not exist yet. This is normal if WP_DEBUG_LOG is off or no errors were logged.`
  );

  const site = await checkUrl(config.localSiteUrl);
  line(site.ok ? "ok" : "warn", "LOCAL_SITE_URL", `${config.localSiteUrl} (${site.message})`);

  const php = await commandVersion("php", ["-v"]);
  line(php.ok ? "ok" : "warn", "PHP", php.ok ? php.message.split("\n")[0] : php.message);

  const wp = await commandVersion("wp", ["--info"]);
  line(wp.ok ? "ok" : "warn", "WP-CLI", wp.ok ? "Available" : wp.message);

  const readable = fs.existsSync(config.pluginRoot);
  process.exitCode = readable ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
