import fs from "fs";
import path from "path";
import { debugPage } from "./tools/browser.js";
import {
  getWordPressRoot,
  tailDebugLog,
  wpCliPluginList,
} from "./tools/wordpress.js";
import { listPluginDirectories } from "./tools/filesystem.js";

export async function collectDebugContext(config, options = {}) {
  const pagePath = options.path || "";
  const [browser, wpCli] = await Promise.all([
    debugPage(config, { path: pagePath }),
    wpCliPluginList(config.pluginRoot),
  ]);

  const debugLog = tailDebugLog(config.wpDebugLog, options.logLines || 120);
  const plugins = listPluginDirectories(config.pluginRoot).map((plugin) => ({
    name: plugin.name,
    mainFiles: plugin.mainFiles.map((file) => file.replace(`${config.pluginRoot}/`, "")),
  }));

  return {
    createdAt: new Date().toISOString(),
    target: {
      path: pagePath || "/",
      localSiteUrl: config.localSiteUrl,
      wordpressRoot: getWordPressRoot(config.pluginRoot),
      pluginRoot: config.pluginRoot,
    },
    browser,
    debugLog,
    wpCli,
    plugins,
  };
}

export async function analyzeDebugContext(client, config, context, userRequest) {
  const response = await client.responses.create({
    model: config.openaiModel,
    instructions: [
      "You are a senior WordPress plugin debugging assistant.",
      "Analyze the provided diagnostic context. It was collected from browser automation, WordPress debug.log, WP-CLI, and plugin discovery.",
      config.openaiVectorStoreId
        ? "You also have indexed code memory through file_search. Use it if it helps connect an error to known code."
        : "No indexed code memory is available.",
      "Do not claim files were edited. This workflow is read-only.",
      "Stay WordPress-specific. Do not suggest Laravel, artisan, or non-WordPress commands unless the diagnostic context explicitly shows that stack.",
      "Be specific: mention URLs, statuses, plugin names, log errors, likely causes, and next checks.",
      "If WP-CLI fails, treat that as a diagnostic signal, not as a total workflow failure.",
      "Keep the answer practical and ordered by importance.",
    ].join("\n"),
    tools: buildMemoryTools(config),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              `User request: ${userRequest}`,
              "",
              "Diagnostic context JSON:",
              JSON.stringify(context, null, 2),
            ].join("\n"),
          },
        ],
      },
    ],
  });

  return response.output_text || "";
}

export function saveDebugContext(context) {
  const diagnosticsDir = path.resolve(process.cwd(), "memory", "diagnostics");
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const filePath = path.join(diagnosticsDir, `${Date.now()}-debug-context.json`);
  fs.writeFileSync(filePath, JSON.stringify(context, null, 2), "utf8");
  return filePath;
}

function buildMemoryTools(config) {
  if (!config.openaiVectorStoreId) {
    return [];
  }

  return [
    {
      type: "file_search",
      vector_store_ids: [config.openaiVectorStoreId],
      max_num_results: 8,
    },
  ];
}
