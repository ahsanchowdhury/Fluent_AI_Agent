import {
  listFiles,
  listPluginDirectories,
  readTextFile,
  searchTextFiles,
} from "./tools/filesystem.js";
import {
  lintPhpFile,
  getWordPressSiteSummary,
  tailDebugLog,
  wpCliPluginList,
} from "./tools/wordpress.js";
import { debugPage } from "./tools/browser.js";

const MAX_TOOL_OUTPUT_CHARS = 70000;

export const agentTools = [
  {
    type: "function",
    name: "list_plugins",
    description: "List local WordPress plugin directories and their detected main plugin files.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_files",
    description:
      "List readable text/code files under the WordPress plugin root or a specific plugin folder.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path under the plugin root, for example 'download-plugin'. Use '.' for all plugins.",
        },
        maxFiles: {
          type: "number",
          description: "Maximum number of files to return. Defaults to 300.",
        },
      },
      required: ["path", "maxFiles"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_file",
    description:
      "Read one safe text/code file from the WordPress plugin root. Paths must be relative to the plugin root.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path, for example 'download-plugin/download-plugin.php'.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_files",
    description:
      "Search readable local plugin files for words or phrases. Use this for support questions to verify whether a feature exists in Fluent Support first, then search other installed plugins for workarounds.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative plugin folder or '.' for all plugins, for example 'fluent-support' or 'fluent-crm'.",
        },
        query: {
          type: "string",
          description: "Words to search for, for example 'schedule email' or 'campaign schedule'.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of matches to return. Defaults to 40.",
        },
        maxFiles: {
          type: "number",
          description: "Maximum number of files to scan. Defaults to 1200.",
        },
      },
      required: ["path", "query", "maxResults", "maxFiles"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "tail_debug_log",
    description:
      "Read the latest lines from the configured WordPress debug.log file.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        lines: {
          type: "number",
          description: "Number of recent log lines to read. Defaults to 120.",
        },
      },
      required: ["lines"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "lint_php_file",
    description:
      "Run php -l syntax lint for one PHP file under the WordPress plugin root.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative PHP file path, for example 'my-shop/my-shop-loyalty.php'.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "wp_cli_plugin_list",
    description:
      "Use WP-CLI to list WordPress plugins and statuses. This may fail if the local database is not reachable.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_wordpress_site_summary",
    description:
      "Read WordPress site facts through local XAMPP PHP: active theme, installed and active plugins, published/draft posts and pages, users, and WordPress version.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "debug_browser_page",
    description:
      "Visit the configured local WordPress site or a relative path with a headless browser and return page status, title, console errors, network failures, bad HTTP responses, body preview, and screenshot path.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path under LOCAL_SITE_URL, absolute URL, or empty string for the local site homepage.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

export async function runAgentTool(config, toolCall) {
  let args = {};

  try {
    args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
  } catch (error) {
    return toolResult(false, `Invalid JSON arguments: ${error.message}`);
  }

  try {
    if (toolCall.name === "list_plugins") {
      const plugins = listPluginDirectories(config.pluginRoot).map((plugin) => ({
        name: plugin.name,
        mainFiles: plugin.mainFiles.map((file) =>
          file.replace(`${config.pluginRoot}/`, "")
        ),
      }));

      return toolResult(true, { plugins });
    }

    if (toolCall.name === "list_files") {
      const files = listFiles(config.pluginRoot, {
        path: args.path || ".",
        maxFiles: args.maxFiles || 300,
      });

      return toolResult(true, { path: args.path || ".", count: files.length, files });
    }

    if (toolCall.name === "read_file") {
      const file = readTextFile(config.pluginRoot, args.path);
      return toolResult(true, file);
    }

    if (toolCall.name === "search_files") {
      return toolResult(
        true,
        searchTextFiles(config.pluginRoot, {
          path: args.path || ".",
          query: args.query || "",
          maxResults: args.maxResults || 40,
          maxFiles: args.maxFiles || 1200,
        })
      );
    }

    if (toolCall.name === "tail_debug_log") {
      return toolResult(true, tailDebugLog(config.wpDebugLog, args.lines || 120));
    }

    if (toolCall.name === "lint_php_file") {
      return toolResult(true, await lintPhpFile(config.pluginRoot, args.path));
    }

    if (toolCall.name === "wp_cli_plugin_list") {
      return toolResult(true, await wpCliPluginList(config.pluginRoot));
    }

    if (toolCall.name === "get_wordpress_site_summary") {
      return toolResult(true, await getWordPressSiteSummary(config));
    }

    if (toolCall.name === "debug_browser_page") {
      return toolResult(true, await debugPage(config, { path: args.path || "" }));
    }

    return toolResult(false, `Unknown tool: ${toolCall.name}`);
  } catch (error) {
    return toolResult(false, error.message);
  }
}

function toolResult(ok, value) {
  const payload = JSON.stringify({ ok, value }, null, 2);

  if (payload.length <= MAX_TOOL_OUTPUT_CHARS) {
    return payload;
  }

  return `${payload.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...TRUNCATED...`;
}
