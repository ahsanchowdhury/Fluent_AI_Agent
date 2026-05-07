import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { maybeAutoIndex } from "../src/autoIndex.js";
import { buildIndexManifest, diffManifests, readSavedManifest, syncCodeVectorStore } from "../src/codeIndex.js";
import { collectDebugContext, analyzeDebugContext, saveDebugContext } from "../src/debugWorkflow.js";
import { getConfig, loadEnv, maskSecret } from "../src/env.js";
import { createAgentResponse, createOpenAIClient } from "../src/openaiClient.js";
import { listPluginDirectories } from "../src/tools/filesystem.js";
import {
  activateTheme,
  changeAllPluginsStatus,
  changePluginStatus,
  getWordPressSiteSummary,
  listThemes,
} from "../src/tools/wordpress.js";

loadEnv();
const config = getConfig();
const client = createOpenAIClient(config);
const app = express();
const port = Number(process.env.AGENT_WEB_PORT || 3333);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "..", "web");
const conversations = new Map();
const conversationActionContext = new Map();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

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

app.get("/api/themes", async (_request, response) => {
  const result = await listThemes(config);
  if (!result.ok) {
    response.status(500).json({ error: result.message });
    return;
  }
  response.json(result);
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
  const history = Array.isArray(request.body?.history) ? request.body.history : [];

  if (!message) {
    response.status(400).json({ error: "Message is required." });
    return;
  }

  try {
    const wordpressAction = await detectWordPressAction(message, conversationId, history);
    if (wordpressAction) {
      const result = await executeWordPressAction(wordpressAction);
      rememberWordPressAction(conversationId, wordpressAction, result);
      response.json({ text: formatActionResult(result) });
      return;
    }

    if (config.autoIndexOnChat) {
      await maybeAutoIndex(config, "web chat");
    }

    const result = await createAgentResponse(client, {
      input: message,
      config,
      previousResponseId: conversations.get(conversationId) || null,
    });

    conversations.set(conversationId, result.responseId);
    response.json({ text: result.text, responseId: result.responseId });
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

  try {
    if (config.autoIndexOnDebug) {
      await maybeAutoIndex(config, "web debug");
    }

    const context = await collectDebugContext(config, { path: targetPath, logLines: 120 });
    const contextPath = saveDebugContext(context);
    const text = await analyzeDebugContext(
      client,
      config,
      context,
      targetPath ? `Debug local WordPress target: ${targetPath}` : "Debug the configured local WordPress homepage."
    );

    response.json({
      text,
      contextPath,
      screenshotPath: context.browser?.screenshotPath || "",
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

async function detectWordPressAction(message, conversationId, history = []) {
  const normalized = normalize(message);
  const allPluginsAction = normalized.match(/\b(deactivate|disable)\b\s+(all|every)\s+plugins?\b/);

  if (allPluginsAction) {
    return {
      type: "all_plugins",
      action: "deactivate",
    };
  }

  const pluginAction = normalized.match(/\b(activate|deactivate)\b\s+(.+)/);
  const followUpPluginAction = detectPluginFollowUp(normalized, conversationId, history);

  if ((pluginAction && !normalized.includes("theme")) || followUpPluginAction) {
    const action = followUpPluginAction?.action || pluginAction[1];
    const rawTarget = followUpPluginAction?.target || pluginAction[2];
    const target = rawTarget
      ?.replace(/\b(plugin|extension|please|the)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "";
    const siteSummary = await getWordPressSiteSummary(config);
    if (!siteSummary.ok) {
      return null;
    }

    const plugin = findPlugin(siteSummary.summary.plugins.items, target);
    if (!plugin) {
      return null;
    }

    if (plugin.active && action === "activate") {
      return {
        type: "noop",
        message: `${plugin.name} is already active.`,
      };
    }

    if (!plugin.active && action === "deactivate") {
      return {
        type: "noop",
        message: `${plugin.name} is already inactive.`,
      };
    }

    return {
      type: "plugin",
      action,
      pluginFile: plugin.file,
      pluginName: plugin.name,
    };
  }

  const themeAction =
    normalized.match(/\bactivate\b\s+theme\s+(.+)/) ||
    normalized.match(/\bactivate\b\s+(.+?)\s+theme\b/);
  if (themeAction) {
    const target = themeAction[1]
      ?.replace(/\b(theme|please|the)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "";
    const themes = await listThemes(config);
    if (!themes.ok) {
      return null;
    }

    const theme = findTheme(themes.themes, target);
    if (!theme) {
      return null;
    }

    if (theme.active) {
      return {
        type: "noop",
        message: `${theme.name} is already the active theme.`,
      };
    }

    return {
      type: "theme",
      stylesheet: theme.stylesheet,
      themeName: theme.name,
    };
  }

  return null;
}

function detectPluginFollowUp(normalized, conversationId, history) {
  if (normalized.includes("theme")) {
    return null;
  }

  const previousAction = getPreviousPluginAction(conversationId, history);
  if (!previousAction) {
    return null;
  }

  const followUp =
    normalized.match(/\b(?:same|do same|do the same|also|again)\s+(?:for|to|on)\s+(.+)/) ||
    normalized.match(/\b(?:same|do same|do the same|also|again)\s+(.+)/) ||
    normalized.match(/\b(?:for|to|on)\s+(.+)/);
  if (!followUp) {
    return null;
  }

  const target = followUp[1]
    ?.replace(/\b(as well|too|also|same|do|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!target) {
    return null;
  }

  return {
    action: previousAction,
    target,
  };
}

function getPreviousPluginAction(conversationId, history) {
  const remembered = conversationActionContext.get(conversationId);
  if (remembered?.type === "plugin" && remembered.action) {
    return remembered.action;
  }

  for (const item of [...history].reverse()) {
    if (item?.role !== "user") {
      continue;
    }

    const match = normalize(item.text).match(/\b(activate|deactivate)\b\s+(.+)/);
    if (match && !normalize(item.text).includes("theme")) {
      return match[1];
    }
  }

  return null;
}

async function executeWordPressAction(action) {
  if (action.type === "noop") {
    return { ok: true, message: action.message };
  }

  if (action.type === "plugin") {
    return changePluginStatus(config, action.pluginFile, action.action);
  }

  if (action.type === "all_plugins") {
    return changeAllPluginsStatus(config, action.action);
  }

  if (action.type === "theme") {
    return activateTheme(config, action.stylesheet);
  }

  return { ok: false, message: "Unknown pending action." };
}

function formatActionResult(result) {
  if (!result.ok) {
    return `Action failed: ${result.message || "Unknown error"}`;
  }

  if (result.message) {
    return result.message;
  }

  if (result.plugin) {
    return `Done. ${result.plugin} is now ${result.active ? "active" : "inactive"}.`;
  }

  if (result.action === "deactivate_all_plugins") {
    const names = result.plugins?.length ? `\n\nDeactivated:\n${result.plugins.map((plugin) => `- ${plugin}`).join("\n")}` : "";
    return `Done. Deactivated ${result.count} active plugin${result.count === 1 ? "" : "s"}. Active plugins now: ${result.active_after}.${names}`;
  }

  if (result.theme) {
    return `Done. The active theme is now ${result.theme}.`;
  }

  return "Done.";
}

function rememberWordPressAction(conversationId, action, result) {
  if (!result.ok || action.type === "noop") {
    return;
  }

  if (action.type === "plugin") {
    conversationActionContext.set(conversationId, {
      type: "plugin",
      action: action.action,
      pluginFile: action.pluginFile,
      pluginName: action.pluginName,
      updatedAt: Date.now(),
    });
    return;
  }

  if (action.type === "theme") {
    conversationActionContext.set(conversationId, {
      type: "theme",
      action: "activate",
      stylesheet: action.stylesheet,
      themeName: action.themeName,
      updatedAt: Date.now(),
    });
  }
}

function findPlugin(plugins, target) {
  if (!target) {
    return null;
  }

  const normalizedTarget = normalize(target);
  const candidates = plugins
    .map((plugin) => ({
      plugin,
      values: [plugin.name, plugin.file, plugin.file.split("/")[0]].map(normalize),
    }))
    .filter((candidate) =>
      candidate.values.some(
        (value) => value === normalizedTarget || value.includes(normalizedTarget) || normalizedTarget.includes(value)
      )
    );

  candidates.sort((a, b) => pluginMatchScore(b.values, normalizedTarget) - pluginMatchScore(a.values, normalizedTarget));
  return candidates[0]?.plugin || null;
}

function findTheme(themes, target) {
  if (!target) {
    return null;
  }

  const normalizedTarget = normalize(target);
  return themes.find((theme) => {
    const values = [theme.name, theme.stylesheet].map(normalize);
    return values.some((value) => value === normalizedTarget || value.includes(normalizedTarget) || normalizedTarget.includes(value));
  });
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pluginMatchScore(values, normalizedTarget) {
  const scores = values.map((value) => {
    if (value === normalizedTarget) {
      return 10000 + value.length;
    }
    if (value.includes(normalizedTarget)) {
      return 5000 + normalizedTarget.length;
    }
    if (normalizedTarget.includes(value)) {
      return 1000 + value.length;
    }
    return 0;
  });

  return Math.max(...scores);
}
