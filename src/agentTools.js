import {
  listFiles,
  listPluginDirectories,
  readTextFile,
  searchTextFiles,
} from "./tools/filesystem.js";
import { emitActivity } from "./activity.js";
import { localImageUrl } from "./imageInputs.js";
import {
  lintPhpFile,
  getWordPressSiteSummary,
  tailDebugLog,
  wpCliPluginList,
} from "./tools/wordpress.js";
import { debugPage, inspectInteractivePage, testFormPage } from "./tools/browser.js";
import { listQaRecipes, runPluginQaSmoke, runQaRecipe } from "./tools/qaRunner.js";
import { generateQaScript, listQaScripts, promoteQaScript, runNextQaScriptStep } from "./tools/qaScripts.js";

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
      "Visit a local or external URL with a headless browser and return page status, title, console errors, network failures, bad HTTP responses, body preview, and screenshot link. Use this when the user asks to debug, inspect, check, or troubleshoot a page URL.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path under LOCAL_SITE_URL, absolute URL such as https://example.com/page, or empty string for the local site homepage.",
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
      "Act like a human tester on a local or external page with forms: inspect visible/hidden/required fields, fill visible fields with safe test values, submit the first form, capture screenshots, and report validation blockers. Use this when the user says a form is not submitting or asks to test a form URL.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path under LOCAL_SITE_URL, absolute URL such as https://example.com/contact, or empty string for the local site homepage.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "inspect_interactive_page",
    description:
      "Follow natural-language browser instructions on a local or external URL, including clicking a named button/link, handling cookie banners, filling conversational multi-step forms safely, stopping before final submit, inspecting requested steps/screens, capturing screenshots, extracting computed styles/selectors, and returning targeted CSS suggestions. Use this for complex UI/debug requests like 'click here, fill the form, go to steps 3 and 4, inspect layout, and share CSS'.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path under LOCAL_SITE_URL or absolute URL such as https://example.com/page.",
        },
        instructions: {
          type: "string",
          description:
            "The user's browser/debug instructions, including what to click, what to fill, which steps/screens to inspect, and what output is needed.",
        },
      },
      required: ["path", "instructions"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_qa_recipes",
    description:
      "List available WordPress/plugin QA test recipes that the agent can run in the browser.",
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
    name: "run_qa_recipe",
    description:
      "Run a low-risk WordPress/plugin QA recipe in the browser using WP admin credentials. Use this when the user asks to run a plugin QA test, beta test, smoke test, or recipe.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        recipeId: {
          type: "string",
          description:
            "Recipe id from list_qa_recipes, for example 'wordpress/admin-dashboard-smoke'.",
        },
      },
      required: ["recipeId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_plugin_qa_smoke",
    description:
      "Run a generic low-risk QA smoke test for an installed WordPress plugin. It logs into WP Admin, detects the plugin's admin menu/page, opens it, captures screenshots, checks console/page/network errors, and samples a few safe related admin links. Use this when the user asks to QA test, beta test, smoke test, or check a plugin without naming a specific recipe.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        plugin: {
          type: "string",
          description:
            "Plugin name or partial name, for example 'Fluent Forms', 'Ninja Tables', or 'FluentCRM'.",
        },
        maxLinks: {
          type: "number",
          description: "Maximum number of safe related admin links to sample. Defaults to 3.",
        },
      },
      required: ["plugin", "maxLinks"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_qa_scripts",
    description:
      "List installed plugins with dynamic QA script readiness status. Use before generated docs-based QA flows.",
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
    name: "generate_qa_script",
    description:
      "Generate or refresh a docs/admin-discovery based QA script draft for one installed plugin. Use when the user asks to make QA scripts ready or test a plugin from docs and no script exists.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        plugin: {
          type: "string",
          description: "Installed plugin name or partial name, for example 'Fluent Forms'.",
        },
      },
      required: ["plugin"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_next_qa_script_step",
    description:
      "Run exactly one pending generated QA script test case for a plugin. If plugin is empty, continue the most recently updated QA script.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        plugin: {
          type: "string",
          description: "Plugin name or empty string to continue the most recent QA script.",
        },
        testId: {
          type: "string",
          description: "Optional generated test id. Empty means run the next pending test.",
        },
      },
      required: ["plugin", "testId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "promote_qa_script",
    description:
      "Promote a generated local QA script draft into tests/recipes so it appears in list_qa_recipes and can be committed.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        plugin: {
          type: "string",
          description: "Plugin name or partial name whose QA script should be promoted.",
        },
      },
      required: ["plugin"],
      additionalProperties: false,
    },
  },
];

export async function runAgentTool(config, toolCall, options = {}) {
  let args = {};
  const activity = options.activity || null;

  try {
    args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
  } catch (error) {
    return toolResult(false, `Invalid JSON arguments: ${error.message}`);
  }

  try {
    if (toolCall.name === "list_plugins") {
      emitActivity(activity, "files", "Listing installed plugin folders");
      const plugins = listPluginDirectories(config.pluginRoot).map((plugin) => ({
        name: plugin.name,
        mainFiles: plugin.mainFiles.map((file) =>
          file.replace(`${config.pluginRoot}/`, "")
        ),
      }));

      return toolResult(true, { plugins });
    }

    if (toolCall.name === "list_files") {
      emitActivity(activity, "files", `Listing files in ${args.path || "."}`);
      const files = listFiles(config.pluginRoot, {
        path: args.path || ".",
        maxFiles: args.maxFiles || 300,
      });

      return toolResult(true, { path: args.path || ".", count: files.length, files });
    }

    if (toolCall.name === "read_file") {
      emitActivity(activity, "files", `Reading ${args.path}`);
      const file = readTextFile(config.pluginRoot, args.path);
      return toolResult(true, file);
    }

    if (toolCall.name === "search_files") {
      emitActivity(activity, "files", `Searching plugin files for "${args.query || ""}"`);
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
      emitActivity(activity, "docs", `Searching docs and saved replies for "${args.query || ""}"`);
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
      emitActivity(activity, "docs", `Searching official doc links for "${args.query || ""}"`);
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
      emitActivity(activity, "docs", `Reading doc ${args.path}`);
      const file = readTextFile(config.docsRoot, args.path);
      return toolResult(true, file);
    }

    if (toolCall.name === "tail_debug_log") {
      emitActivity(activity, "wordpress", "Reading WordPress debug log");
      return toolResult(true, tailDebugLog(config.wpDebugLog, args.lines || 120));
    }

    if (toolCall.name === "lint_php_file") {
      emitActivity(activity, "code", `Linting ${args.path}`);
      return toolResult(true, await lintPhpFile(config.pluginRoot, args.path));
    }

    if (toolCall.name === "wp_cli_plugin_list") {
      emitActivity(activity, "wordpress", "Checking plugin status with WP-CLI");
      return toolResult(true, await wpCliPluginList(config.pluginRoot));
    }

    if (toolCall.name === "get_wordpress_site_summary") {
      emitActivity(activity, "wordpress", "Reading WordPress site summary");
      return toolResult(true, await getWordPressSiteSummary(config));
    }

    if (toolCall.name === "debug_browser_page") {
      emitActivity(activity, "browser", "Opening page in browser");
      const result = await debugPage(config, { path: args.path || "", activity });
      return toolResult(true, addDebugImageUrls(result));
    }

    if (toolCall.name === "test_form_page") {
      emitActivity(activity, "browser", "Testing form like a user");
      const result = await testFormPage(config, { path: args.path || "", activity });
      return toolResult(true, addDebugImageUrls(result));
    }

    if (toolCall.name === "inspect_interactive_page") {
      emitActivity(activity, "browser", "Running interactive page inspection");
      const result = await inspectInteractivePage(config, {
        path: args.path || "",
        instructions: args.instructions || "",
        activity,
      });
      return toolResult(true, compactInteractiveResult(addDebugImageUrlsToInteractiveResult(result)));
    }

    if (toolCall.name === "list_qa_recipes") {
      emitActivity(activity, "test", "Listing QA recipes");
      return toolResult(true, { recipes: listQaRecipes() });
    }

    if (toolCall.name === "run_qa_recipe") {
      emitActivity(activity, "test", `Running QA recipe ${args.recipeId}`);
      const result = await runQaRecipe(config, {
        recipeId: args.recipeId,
        activity,
      });
      return toolResult(true, addQaReportUrls(result));
    }

    if (toolCall.name === "run_plugin_qa_smoke") {
      emitActivity(activity, "test", `Running generic plugin QA for ${args.plugin}`);
      const result = await runPluginQaSmoke(config, {
        plugin: args.plugin || "",
        maxLinks: args.maxLinks || 3,
        activity,
      });
      return toolResult(true, addQaReportUrls(result));
    }

    if (toolCall.name === "list_qa_scripts") {
      emitActivity(activity, "test", "Listing generated QA scripts");
      return toolResult(true, await listQaScripts(config));
    }

    if (toolCall.name === "generate_qa_script") {
      emitActivity(activity, "test", `Generating QA script for ${args.plugin}`);
      return toolResult(true, await generateQaScript(config, {
        plugin: args.plugin || "",
        activity,
      }));
    }

    if (toolCall.name === "run_next_qa_script_step") {
      emitActivity(activity, "test", `Running next QA script step${args.plugin ? ` for ${args.plugin}` : ""}`);
      const result = await runNextQaScriptStep(config, {
        plugin: args.plugin || "",
        testId: args.testId || "",
        activity,
      });
      return toolResult(true, addGeneratedQaStepUrls(result));
    }

    if (toolCall.name === "promote_qa_script") {
      emitActivity(activity, "test", `Promoting QA script for ${args.plugin}`);
      return toolResult(true, promoteQaScript(config, {
        plugin: args.plugin || "",
      }));
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

function addDebugImageUrls(result) {
  const screenshotUrl = absoluteLocalImageUrl(result.screenshotPath || "");
  const beforeScreenshotUrl = absoluteLocalImageUrl(result.beforeScreenshotPath || "");
  const afterScreenshotUrl = absoluteLocalImageUrl(result.afterScreenshotPath || "");

  return {
    ...result,
    screenshotUrl,
    beforeScreenshotUrl,
    afterScreenshotUrl,
    screenshotMarkdown: screenshotUrl ? `[Open screenshot](${screenshotUrl})` : "",
    beforeScreenshotMarkdown: beforeScreenshotUrl ? `[Open before screenshot](${beforeScreenshotUrl})` : "",
    afterScreenshotMarkdown: afterScreenshotUrl ? `[Open after screenshot](${afterScreenshotUrl})` : "",
  };
}

function addDebugImageUrlsToInteractiveResult(result) {
  return {
    ...addDebugImageUrls(result),
    stepInspections: (result.stepInspections || []).map((step) => {
      const screenshotUrl = absoluteLocalImageUrl(step.screenshotPath || "");
      return {
        ...step,
        screenshotUrl,
        screenshotMarkdown: screenshotUrl ? `[Open step ${step.step} screenshot](${screenshotUrl})` : "",
      };
    }),
    behaviorTests: (result.behaviorTests || []).map((test) => {
      const beforeScreenshotUrl = absoluteLocalImageUrl(test.beforeScreenshotPath || "");
      const afterScreenshotUrl = absoluteLocalImageUrl(test.afterScreenshotPath || "");
      return {
        ...test,
        beforeScreenshotUrl,
        afterScreenshotUrl,
        beforeScreenshotMarkdown: beforeScreenshotUrl ? `[Open ${test.name} before screenshot](${beforeScreenshotUrl})` : "",
        afterScreenshotMarkdown: afterScreenshotUrl ? `[Open ${test.name} after screenshot](${afterScreenshotUrl})` : "",
      };
    }),
  };
}

function addQaReportUrls(result) {
  const reportUrl = result.reportPath ? `/api/local-file?path=${encodeURIComponent(result.reportPath)}` : "";
  return {
    ...result,
    reportUrl,
    reportMarkdown: reportUrl ? `[Open QA report](${reportUrl})` : "",
    screenshots: (result.screenshots || []).map((screenshot) => {
      const screenshotUrl = absoluteLocalImageUrl(screenshot.path || "");
      return {
        ...screenshot,
        screenshotUrl,
        screenshotMarkdown: screenshotUrl ? `[Open ${screenshot.name || "QA screenshot"}](${screenshotUrl})` : "",
      };
    }),
  };
}

function addGeneratedQaStepUrls(result) {
  if (result.blocked || !result.report) {
    return result;
  }

  return {
    ...result,
    report: addQaReportUrls(result.report),
  };
}

function compactInteractiveResult(result) {
  return {
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    status: result.status,
    title: result.title,
    navigationError: result.navigationError,
    instructions: result.instructions,
    targetSteps: result.targetSteps,
    actions: result.actions,
    safetyNote: result.safetyNote,
    behaviorDiagnosis: result.behaviorDiagnosis,
    behaviorTests: (result.behaviorTests || []).map((test) => ({
      name: test.name,
      label: test.label,
      targetStep: test.targetStep,
      ok: test.ok,
      reason: test.reason || "",
      outcome: test.outcome || null,
      beforeStep: test.activeBefore?.number || null,
      beforeText: test.activeBefore?.text || "",
      afterStep: test.activeAfter?.number || null,
      afterText: test.activeAfter?.text || "",
      modalBeforeVisible: test.modalBefore?.visible ?? null,
      modalAfterVisible: test.modalAfter?.visible ?? null,
      beforeScreenshotMarkdown: test.beforeScreenshotMarkdown || "",
      afterScreenshotMarkdown: test.afterScreenshotMarkdown || "",
      consoleErrors: (test.consoleMessages || []).filter((message) => message.type === "error").slice(0, 5),
      pageErrors: (test.pageErrors || []).slice(0, 5),
      badResponses: (test.badResponses || []).slice(0, 8),
    })),
    stepInspections: (result.stepInspections || []).map((step) => ({
      step: step.step,
      plugin: step.plugin,
      formClass: step.formClass,
      activeClassName: step.activeClassName,
      text: step.text,
      viewport: step.viewport,
      formRect: step.formRect,
      overflowsViewport: step.overflowsViewport,
      screenshotMarkdown: step.screenshotMarkdown || "",
      keySelectors: {
        containers: compactElementSamples(step.elements?.containers),
        questionText: compactElementSamples(step.elements?.questionText),
        choices: compactElementSamples(step.elements?.choices, 12),
        inputs: compactElementSamples(step.elements?.inputs, 8),
      },
    })),
    suggestedCss: result.suggestedCss,
    screenshots: {
      before: result.beforeScreenshotMarkdown || result.beforeScreenshotUrl || "",
      after: result.afterScreenshotMarkdown || result.afterScreenshotUrl || "",
    },
    submitRequests: (result.submitRequests || []).slice(0, 8),
    consoleErrors: (result.consoleMessages || []).filter((message) => message.type === "error").slice(0, 8),
    pageErrors: (result.pageErrors || []).slice(0, 8),
    requestFailures: (result.requestFailures || []).slice(0, 8),
    badResponses: (result.badResponses || []).slice(0, 12),
    bodyTextPreview: result.bodyTextPreview,
  };
}

function compactElementSamples(items = [], limit = 6) {
  return items.slice(0, limit).map((item) => ({
    tag: item.tag,
    className: item.className,
    text: item.text,
    rect: item.rect,
    style: item.style,
  }));
}

function absoluteLocalImageUrl(filePath) {
  const relativeUrl = localImageUrl(filePath);
  if (!relativeUrl) {
    return "";
  }

  return `http://127.0.0.1:${process.env.AGENT_WEB_PORT || 3333}${relativeUrl}`;
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
