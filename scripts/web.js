import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { maybeAutoIndex } from "../src/autoIndex.js";
import { createActivityEmitter, createActivityStore } from "../src/activity.js";
import { buildIndexManifest, diffManifests, readSavedManifest, syncCodeVectorStore } from "../src/codeIndex.js";
import { collectDebugContext, analyzeDebugContext, saveDebugContext } from "../src/debugWorkflow.js";
import { getConfig, loadEnv, maskSecret } from "../src/env.js";
import { localImageUrl, saveImageAttachments } from "../src/imageInputs.js";
import { createAgentResponse, createOpenAIClient } from "../src/openaiClient.js";
import { listPluginDirectories } from "../src/tools/filesystem.js";
import { generateQaScript, listQaScripts, promoteQaScript, runNextQaScriptStep } from "../src/tools/qaScripts.js";
import { activateTheme, changePluginStatus, getWordPressSiteSummary, listThemes } from "../src/tools/wordpress.js";
import {
  detectWordPressAction,
  executeWordPressAction,
  formatActionResult,
  rememberWordPressAction,
} from "../src/wordpressActionRouter.js";

loadEnv();
const config = getConfig();
const client = createOpenAIClient(config);
const app = express();
const port = Number(process.env.AGENT_WEB_PORT || 3333);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "..", "web");
const conversations = new Map();
const conversationActionContext = new Map();
const activityStore = createActivityStore();

app.use(express.json({ limit: "40mb" }));
app.use(express.static(publicDir));

app.get("/api/local-image", (request, response) => {
  const filePath = String(request.query?.path || "");
  const resolvedPath = path.resolve(filePath);
  const allowedRoots = [
    path.resolve(process.cwd(), "memory", "screenshots"),
    path.resolve(process.cwd(), "memory", "uploads"),
  ];

  if (!allowedRoots.some((root) => resolvedPath.startsWith(`${root}${path.sep}`))) {
    response.status(403).send("Image is outside the agent memory folder.");
    return;
  }

  response.sendFile(resolvedPath, (error) => {
    if (error && !response.headersSent) {
      response.status(404).send("Image not found.");
    }
  });
});

app.get("/api/local-file", (request, response) => {
  const filePath = String(request.query?.path || "");
  const resolvedPath = path.resolve(filePath);
  const allowedRoots = [
    path.resolve(process.cwd(), "memory", "qa-reports"),
  ];

  if (!allowedRoots.some((root) => resolvedPath.startsWith(`${root}${path.sep}`))) {
    response.status(403).send("File is outside the allowed agent memory folder.");
    return;
  }

  response.sendFile(resolvedPath, (error) => {
    if (error && !response.headersSent) {
      response.status(404).send("File not found.");
    }
  });
});

app.get("/api/status", async (_request, response) => {
  const current = buildIndexManifest(config, { path: "." });
  const previous = readSavedManifest();
  const diff = diffManifests(previous, current);
  const siteSummary = await getWordPressSiteSummary(config);

  response.json({
    site: config.localSiteUrl,
    model: config.openaiModel,
    key: config.openaiApiKey ? maskSecret(config.openaiApiKey) : "missing",
    vectorStoreId: config.openaiVectorStoreId || "",
    index: {
      fileCount: current.fileCount,
      skippedCount: current.skippedCount || 0,
      totalBytes: current.totalBytes,
      inSync: !diff.changed && Boolean(previous),
      added: diff.added.length,
      changed: diff.changedFiles.length,
      removed: diff.removed.length,
    },
    plugins: listPluginDirectories(config.pluginRoot).map((plugin) => ({
      name: plugin.name,
      mainFiles: plugin.mainFiles.map((file) => file.replace(`${config.pluginRoot}/`, "")),
    })),
    siteSummary: siteSummary.ok ? siteSummary.summary : null,
    siteSummaryError: siteSummary.ok ? "" : siteSummary.message,
  });
});

app.get("/api/site-summary", async (_request, response) => {
  const result = await getWordPressSiteSummary(config);
  if (!result.ok) {
    response.status(500).json({ error: result.message });
    return;
  }
  response.json(result.summary);
});

app.get("/api/chat/activity/:requestId", (request, response) => {
  response.json(activityStore.get(String(request.params.requestId || "")));
});

app.get("/api/memory/summary", (_request, response) => {
  try {
    response.json(getLocalMemorySummary(config));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/memory/search", (request, response) => {
  try {
    const query = String(request.query?.q || "").trim();
    const source = String(request.query?.source || "all").trim();
    response.json(searchLocalMemory(config, { query, source }));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/memory/file", (request, response) => {
  try {
    const filePath = String(request.query?.path || "").trim();
    const source = String(request.query?.source || "").trim();
    response.json(readLocalMemoryFile(config, { path: filePath, source }));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/themes", async (_request, response) => {
  const result = await listThemes(config);
  if (!result.ok) {
    response.status(500).json({ error: result.message });
    return;
  }
  response.json(result);
});

app.get("/api/qa/scripts", async (_request, response) => {
  try {
    response.json(await listQaScripts(config));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/qa/scripts/generate", async (request, response) => {
  try {
    const plugin = String(request.body?.plugin || "").trim();
    response.json(await generateQaScript(config, { plugin }));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/qa/scripts/run-step", async (request, response) => {
  try {
    const plugin = String(request.body?.plugin || "").trim();
    const testId = String(request.body?.testId || "").trim();
    response.json(addGeneratedQaStepUrls(await runNextQaScriptStep(config, { plugin, testId })));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/qa/scripts/promote", async (request, response) => {
  try {
    const plugin = String(request.body?.plugin || "").trim();
    response.json(promoteQaScript(config, { plugin }));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/plugin-action", async (request, response) => {
  const pluginFile = String(request.body?.pluginFile || "").trim();
  const action = String(request.body?.action || "").trim();
  const confirmed = request.body?.confirmed === true;

  if (!confirmed) {
    response.status(400).json({ error: "Confirmation is required." });
    return;
  }

  const result = await changePluginStatus(config, pluginFile, action);
  if (!result.ok) {
    response.status(500).json({ error: result.message || "Plugin action failed." });
    return;
  }
  response.json(result);
});

app.post("/api/theme-action", async (request, response) => {
  const stylesheet = String(request.body?.stylesheet || "").trim();
  const confirmed = request.body?.confirmed === true;

  if (!confirmed) {
    response.status(400).json({ error: "Confirmation is required." });
    return;
  }

  const result = await activateTheme(config, stylesheet);
  if (!result.ok) {
    response.status(500).json({ error: result.message || "Theme activation failed." });
    return;
  }
  response.json(result);
});

app.post("/api/chat", async (request, response) => {
  const message = String(request.body?.message || "").trim();
  const conversationId = String(request.body?.conversationId || "default");
  const requestId = String(request.body?.requestId || `${conversationId}-${Date.now()}`);
  const history = Array.isArray(request.body?.history) ? request.body.history : [];
  const images = Array.isArray(request.body?.images) ? request.body.images : [];
  activityStore.start(requestId);
  const activity = createActivityEmitter(activityStore, requestId);

  if (!message && !images.length) {
    activityStore.finish(requestId);
    response.status(400).json({ error: "Message or image is required." });
    return;
  }

  try {
    activity("start", "Reading your request");
    const wordpressAction = await detectWordPressAction(config, message, {
      conversationId,
      context: conversationActionContext,
      history,
    });
    if (wordpressAction) {
      activity("wordpress", `Running WordPress action: ${wordpressAction.action}`);
      const result = await executeWordPressAction(config, wordpressAction);
      rememberWordPressAction(conversationActionContext, conversationId, wordpressAction, result);
      activity("done", "WordPress action finished");
      activityStore.finish(requestId);
      response.json({ text: formatActionResult(result) });
      return;
    }

    if (config.autoIndexOnChat) {
      activity("memory", "Checking code memory index");
      await maybeAutoIndex(config, "web chat");
    }

    activity("ai", "Asking the model which tools it needs");
    const result = await createAgentResponse(client, {
      input: message,
      config,
      previousResponseId: conversations.get(conversationId) || null,
      images,
      activity,
    });

    conversations.set(conversationId, result.responseId);
    const savedImages = saveImageAttachments(images).map((image) => ({
      ...image,
      url: localImageUrl(image.path),
    }));
    activity("done", "Final response ready");
    activityStore.finish(requestId);
    response.json({ text: result.text, responseId: result.responseId, images: savedImages });
  } catch (error) {
    activity("error", `Request failed: ${error.message}`);
    activityStore.finish(requestId);
    response.status(500).json({ error: error.message });
  } finally {
    activityStore.cleanup();
  }
});

app.post("/api/message-action", async (request, response) => {
  const action = String(request.body?.action || "").trim();
  const text = String(request.body?.text || "").trim();
  const history = Array.isArray(request.body?.history) ? request.body.history : [];

  if (!["summarize_context", "rewrite"].includes(action)) {
    response.status(400).json({ error: "Unknown message action." });
    return;
  }

  if (action === "rewrite" && !text) {
    response.status(400).json({ error: "Response text is required." });
    return;
  }

  try {
    const result = await client.responses.create({
      model: config.openaiModel,
      instructions: [
        "You are helping refine a WordPress support-agent chat.",
        "Do not activate plugins, change themes, install anything, browse pages, or perform site actions.",
        "Return only the requested text. Do not mention that you are an AI.",
      ].join("\n"),
      input: buildMessageActionPrompt(action, { text, history }),
    });

    response.json({ text: result.output_text || "" });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/reset", (request, response) => {
  const conversationId = String(request.body?.conversationId || "default");
  conversations.delete(conversationId);
  conversationActionContext.delete(conversationId);
  response.json({ ok: true });
});

app.post("/api/debug", async (request, response) => {
  const targetPath = String(request.body?.path || "").trim();
  const formTest = request.body?.formTest === true;

  try {
    if (config.autoIndexOnDebug) {
      await maybeAutoIndex(config, "web debug");
    }

    const context = await collectDebugContext(config, { path: targetPath, formTest, logLines: 120 });
    const contextPath = saveDebugContext(context);
    const text = await analyzeDebugContext(
      client,
      config,
      context,
      formTest
        ? `Test form like a human on: ${targetPath || "/"}`
        : targetPath ? `Debug local WordPress target: ${targetPath}` : "Debug the configured local WordPress homepage."
    );

    response.json({
      text,
      contextPath,
      screenshotPath: context.browser?.afterScreenshotPath || context.browser?.screenshotPath || "",
      beforeScreenshotPath: context.browser?.beforeScreenshotPath || "",
      afterScreenshotPath: context.browser?.afterScreenshotPath || "",
      screenshotUrl: localImageUrl(context.browser?.afterScreenshotPath || context.browser?.screenshotPath || ""),
      beforeScreenshotUrl: localImageUrl(context.browser?.beforeScreenshotPath || ""),
      afterScreenshotUrl: localImageUrl(context.browser?.afterScreenshotPath || ""),
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/index-sync", async (_request, response) => {
  try {
    const result = await syncCodeVectorStore(client, config, { path: "." });
    response.json({
      changed: result.changed,
      vectorStoreId: result.vectorStoreId,
      message: result.changed ? "Code memory synced." : "Code memory already in sync.",
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Local WP AI Agent dashboard: http://127.0.0.1:${port}`);
});

function buildMessageActionPrompt(action, { text, history }) {
  if (action === "rewrite") {
    return [
      "Rewrite this response in a more professional, polished support tone.",
      "Keep the original meaning, steps, links, code blocks, and important technical details.",
      "Make it clearer and more customer-ready. Do not add unsupported claims.",
      "",
      "Response to rewrite:",
      text,
    ].join("\n");
  }

  return [
    "Summarize the full chat context in bullet points.",
    "Use concise bullets grouped by topic when useful.",
    "Include decisions, user preferences, completed work, open items, links, and important technical details.",
    text ? "Also include the user's current unsent draft under a 'Current draft:' bullet if it matters." : "",
    "End with a footer titled 'Short summary:' containing 1-2 sentences.",
    "",
    text ? `Current unsent draft:\n${text}\n` : "",
    "Conversation history JSON:",
    JSON.stringify(history.map((message) => ({
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    })), null, 2),
  ].join("\n");
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

function addQaReportUrls(result) {
  const reportUrl = result.reportPath ? `/api/local-file?path=${encodeURIComponent(result.reportPath)}` : "";
  return {
    ...result,
    reportUrl,
    reportMarkdown: reportUrl ? `[Open QA report](${reportUrl})` : "",
    screenshots: (result.screenshots || []).map((screenshot) => {
      const screenshotUrl = localImageUrl(screenshot.path || "");
      return {
        ...screenshot,
        screenshotUrl,
        screenshotMarkdown: screenshotUrl ? `[Open ${screenshot.name || "QA screenshot"}](${screenshotUrl})` : "",
      };
    }),
  };
}

function getManifestPath() {
  return path.resolve(process.cwd(), "memory", "index-manifest.json");
}

function readLocalManifest() {
  const manifestPath = getManifestPath();
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function getLocalMemorySummary(config) {
  const manifest = readLocalManifest();
  if (!manifest) {
    return {
      exists: false,
      vectorStoreId: config.openaiVectorStoreId || "",
      message: "No local memory manifest found yet.",
    };
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const bySource = files.reduce((totals, file) => {
    const source = file.source || "unknown";
    totals[source] = (totals[source] || 0) + 1;
    return totals;
  }, {});

  return {
    exists: true,
    vectorStoreId: manifest.vectorStoreId || config.openaiVectorStoreId || "",
    vectorStoreStatus: manifest.vectorStoreStatus || "",
    indexedAt: manifest.indexedAt || manifest.createdAt || "",
    fileCount: manifest.fileCount || files.length,
    skippedCount: manifest.skippedCount || 0,
    totalBytes: manifest.totalBytes || 0,
    pluginRoot: manifest.pluginRoot || config.pluginRoot,
    docsRoot: manifest.docsRoot || path.resolve(process.cwd(), "docs"),
    bySource,
    files: files.slice(0, 120).map(summarizeMemoryFile),
  };
}

function searchLocalMemory(config, options = {}) {
  const manifest = readLocalManifest();
  if (!manifest) {
    return { query: options.query || "", count: 0, results: [] };
  }

  const query = String(options.query || "").trim();
  const sourceFilter = String(options.source || "all").trim();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const results = [];

  for (const file of files) {
    if (results.length >= 80) break;
    if (sourceFilter !== "all" && file.source !== sourceFilter) continue;

    const pathMatch = terms.length
      ? terms.every((term) => String(file.path || "").toLowerCase().includes(term))
      : false;
    let contentMatch = null;

    if (terms.length && !pathMatch) {
      contentMatch = findFirstMemoryContentMatch(config, file, terms);
      if (!contentMatch) continue;
    }

    results.push({
      ...summarizeMemoryFile(file),
      line: contentMatch?.line || null,
      excerpt: contentMatch?.text || "",
      matchType: pathMatch ? "path" : "content",
    });
  }

  return {
    query,
    source: sourceFilter,
    count: results.length,
    results,
  };
}

function readLocalMemoryFile(config, options = {}) {
  const manifest = readLocalManifest();
  if (!manifest) {
    throw new Error("No local memory manifest found.");
  }

  const targetPath = String(options.path || "").trim();
  const source = String(options.source || "").trim();
  if (!targetPath || !source) {
    throw new Error("Path and source are required.");
  }

  const file = (manifest.files || []).find((item) => item.path === targetPath && item.source === source);
  if (!file) {
    throw new Error("File is not listed in the memory manifest.");
  }

  const absolutePath = resolveMemorySourcePath(config, file);
  const stat = fs.statSync(absolutePath);
  const maxBytes = 220 * 1024;
  if (stat.size > maxBytes) {
    return {
      ...summarizeMemoryFile(file),
      absolutePath,
      truncated: true,
      content: fs.readFileSync(absolutePath, "utf8").slice(0, maxBytes),
    };
  }

  return {
    ...summarizeMemoryFile(file),
    absolutePath,
    truncated: false,
    content: fs.readFileSync(absolutePath, "utf8"),
  };
}

function findFirstMemoryContentMatch(config, file, terms) {
  try {
    const absolutePath = resolveMemorySourcePath(config, file);
    const stat = fs.statSync(absolutePath);
    if (stat.size > 500 * 1024) return null;

    const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const haystack = lines[index].toLowerCase();
      if (terms.every((term) => haystack.includes(term))) {
        return {
          line: index + 1,
          text: lines[index].trim().slice(0, 260),
        };
      }
    }
  } catch (_error) {
    return null;
  }

  return null;
}

function resolveMemorySourcePath(config, file) {
  const sourceRoot = file.source === "docs"
    ? process.cwd()
    : config.pluginRoot;
  const root = path.resolve(sourceRoot);
  const resolved = path.resolve(root, file.path || "");
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Memory file path escapes the allowed root.");
  }

  return resolved;
}

function summarizeMemoryFile(file) {
  return {
    path: file.path,
    source: file.source || "unknown",
    bytes: file.bytes || 0,
    sha256: file.sha256 || "",
  };
}
