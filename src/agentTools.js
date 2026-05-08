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
import { debugPage, testFormPage } from "./tools/browser.js";

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
      "Search readable local plugin files for words or phrases. Use this for support questions to verify whether a feature exists in the primary plugin the client asks about, then search other installed plugins for workarounds.",
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
    name: "search_docs",
    description:
      "Search local company docs and saved replies. Use this first for support questions, especially docs/golden-answers saved reply templates.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path under the docs root, for example 'golden-answers' or '.'.",
        },
        query: {
          type: "string",
          description: "Words to search for in docs or saved replies.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of matches to return. Defaults to 40.",
        },
        maxFiles: {
          type: "number",
          description: "Maximum number of files to scan. Defaults to 2500.",
        },
      },
      required: ["path", "query", "maxResults", "maxFiles"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_doc_links",
    description:
      "Search the trusted official documentation link index under docs/doc-links. Use this whenever a support answer should include a documentation link.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        product: {
          type: "string",
          description:
            "Product name or slug, for example 'FluentCart', 'Fluent Forms', 'Fluent Support', or empty to search all products.",
        },
        query: {
          type: "string",
          description: "Customer issue or doc topic, for example 'bulk product import price categories'.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of matching documentation links to return. Defaults to 5.",
        },
      },
      required: ["product", "query", "maxResults"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_doc",
    description:
      "Read one local company doc or saved reply file. Paths must be relative to the docs root.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative doc path, for example 'golden-answers/wpmanageninja-account-billing-saved-replies.md'.",
        },
      },
      required: ["path"],
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
  {
    type: "function",
    name: "test_form_page",
    description:
      "Act like a human tester on a page with forms: inspect visible/hidden/required fields, fill visible fields with safe test values, submit the first form, capture screenshots, and report validation blockers.",
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

    if (toolCall.name === "search_docs") {
      return toolResult(
        true,
        searchTextFiles(config.docsRoot, {
          path: args.path || ".",
          query: args.query || "",
          maxResults: args.maxResults || 40,
          maxFiles: args.maxFiles || 2500,
        })
      );
    }

    if (toolCall.name === "search_doc_links") {
      return toolResult(
        true,
        searchTrustedDocLinks(config, {
          product: args.product || "",
          query: args.query || "",
          maxResults: args.maxResults || 5,
        })
      );
    }

    if (toolCall.name === "read_doc") {
      const file = readTextFile(config.docsRoot, args.path);
      return toolResult(true, file);
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

    if (toolCall.name === "test_form_page") {
      return toolResult(true, await testFormPage(config, { path: args.path || "" }));
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

export function searchTrustedDocLinks(config, { product = "", query = "", maxResults = 5 }) {
  const productFilter = normalizeWords(product);
  const queryWords = normalizeWords(`${product} ${query}`);
  const files = listFiles(config.docsRoot, {
    path: "doc-links",
    maxFiles: 100,
  }).filter((file) => file.endsWith(".md") && file !== "doc-links/index.md");
  const matches = [];

  for (const file of files) {
    let content;
    try {
      content = readTextFile(config.docsRoot, file).content;
    } catch (_error) {
      continue;
    }

    const productName = content.match(/^Product:\s*(.+)$/m)?.[1]?.trim() || file.replace(/^doc-links\/|\.md$/g, "");
    const productWords = normalizeWords(productName);
    const fileWords = normalizeWords(file);
    const productMentionBoost = !productFilter.length && hasOverlap(queryWords, [...productWords, ...fileWords]) ? 8 : 0;

    if (productFilter.length && !hasOverlap(productFilter, [...productWords, ...fileWords])) {
      continue;
    }

    for (const section of content.split(/\n## /).slice(1)) {
      const title = section.split(/\r?\n/)[0]?.replace(/^#+\s*/, "").trim();
      const url = section.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
      const description = section.match(/^Description:\s*(.+)$/m)?.[1]?.trim() || "";
      const keywords = section.match(/^Keywords:\s*(.+)$/m)?.[1]?.trim() || "";

      if (!title || !url) {
        continue;
      }

      const haystackWords = normalizeWords(`${productName} ${title} ${description} ${keywords} ${url}`);
      const score = scoreWords(queryWords, haystackWords) + (productFilter.length ? 4 : productMentionBoost);

      if (score <= 0) {
        continue;
      }

      matches.push({
        product: productName,
        title,
        url,
        description,
        score,
        sourcePath: file,
      });
    }
  }

  return {
    query,
    product,
    count: matches.length,
    results: matches
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, maxResults),
  };
}

function normalizeWords(text) {
  return String(text || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .filter((word) => !["and", "the", "for", "with", "docs", "documentation", "fluent"].includes(word));
}

function hasOverlap(leftWords, rightWords) {
  const right = new Set(rightWords);
  return leftWords.some((word) => right.has(word));
}

function scoreWords(queryWords, haystackWords) {
  const haystack = new Set(haystackWords);
  return queryWords.reduce((score, word) => score + (haystack.has(word) ? 1 : 0), 0);
}
