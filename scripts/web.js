import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { maybeAutoIndex } from "../src/autoIndex.js";
import { buildIndexManifest, diffManifests, readSavedManifest, syncCodeVectorStore } from "../src/codeIndex.js";
import { collectDebugContext, analyzeDebugContext, saveDebugContext } from "../src/debugWorkflow.js";
import { getConfig, loadEnv, maskSecret } from "../src/env.js";
import { createAgentResponse, createOpenAIClient } from "../src/openaiClient.js";
import { listPluginDirectories } from "../src/tools/filesystem.js";
import { activateTheme, changePluginStatus, getWordPressSiteSummary, listThemes } from "../src/tools/wordpress.js";

loadEnv();
const config = getConfig();
const client = createOpenAIClient(config);
const app = express();
const port = Number(process.env.AGENT_WEB_PORT || 3333);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "..", "web");
const conversations = new Map();
const pendingActions = new Map();

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

  if (!message) {
    response.status(400).json({ error: "Message is required." });
    return;
  }

  try {
    const pending = pendingActions.get(conversationId);
    if (pending && isConfirmation(message)) {
      const result = await executePendingAction(pending);
      pendingActions.delete(conversationId);
      response.json({ text: formatActionResult(result) });
      return;
    }

    if (pending && isRejection(message)) {
      pendingActions.delete(conversationId);
      response.json({ text: "Okay, I cancelled the pending WordPress action." });
      return;
    }

    const proposedAction = await detectWordPressAction(message);
    if (proposedAction) {
      pendingActions.set(conversationId, proposedAction);
      response.json({ text: formatPendingAction(proposedAction) });
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
  pendingActions.delete(conversationId);
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

async function detectWordPressAction(message) {
  const normalized = normalize(message);
  const pluginAction = normalized.match(/\b(activate|deactivate)\b\s+(.+)/);

  if (pluginAction && !normalized.includes("theme")) {
    const action = pluginAction[1];
    const target = pluginAction[2]
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

async function executePendingAction(action) {
  if (action.type === "noop") {
    return action;
  }

  if (action.type === "plugin") {
    return changePluginStatus(config, action.pluginFile, action.action);
  }

  if (action.type === "theme") {
    return activateTheme(config, action.stylesheet);
  }

  return { ok: false, message: "Unknown pending action." };
}

function formatPendingAction(action) {
  if (action.type === "noop") {
    return action.message;
  }

  if (action.type === "plugin") {
    const label = action.action === "activate" ? "activate" : "deactivate";
    return [
      `I can ${label} ${action.pluginName} (${action.pluginFile}).`,
      "Reply `yes` to confirm, or `no` to cancel.",
    ].join("\n");
  }

  if (action.type === "theme") {
    return [
      `I can activate the ${action.themeName} theme (${action.stylesheet}).`,
      "Reply `yes` to confirm, or `no` to cancel.",
    ].join("\n");
  }

  return "I could not prepare that action.";
}

function formatActionResult(result) {
  if (!result.ok) {
    return `Action failed: ${result.message || "Unknown error"}`;
  }

  if (result.plugin) {
    return `Done. ${result.plugin} is now ${result.active ? "active" : "inactive"}.`;
  }

  if (result.theme) {
    return `Done. The active theme is now ${result.theme}.`;
  }

  return "Done.";
}

function findPlugin(plugins, target) {
  if (!target) {
    return null;
  }

  const normalizedTarget = normalize(target);
  return plugins.find((plugin) => {
    const values = [plugin.name, plugin.file, plugin.file.split("/")[0]].map(normalize);
    return values.some((value) => value === normalizedTarget || value.includes(normalizedTarget) || normalizedTarget.includes(value));
  });
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

function isConfirmation(message) {
  return /^(yes|y|confirm|do it|proceed)$/i.test(message.trim());
}

function isRejection(message) {
  return /^(no|n|cancel|stop)$/i.test(message.trim());
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
