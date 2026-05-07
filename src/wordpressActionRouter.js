import {
  activateTheme,
  changeAllPluginsStatus,
  changePluginStatus,
  getWordPressSiteSummary,
  listThemes,
  updateWordPressDebugLog,
} from "./tools/wordpress.js";

export async function detectWordPressAction(config, message, options = {}) {
  const normalized = normalize(message);

  const debugLogAction = detectDebugLogAction(normalized);
  if (debugLogAction) {
    return debugLogAction;
  }

  const allPluginsAction = detectAllPluginsAction(normalized);
  if (allPluginsAction) {
    return allPluginsAction;
  }

  if (isDeactivateAllPluginsRequest(normalized)) {
    return {
      type: "all_plugins",
      action: "deactivate",
    };
  }

  const multiPluginAction = detectRecentPluginsAction(normalized, options);
  if (multiPluginAction) {
    return multiPluginAction;
  }

  const pluginAction = normalized.match(/\b(reactivate|activate|enable|deactivagte|deactivate|disable)\b\s+(.+)/);
  const followUpPluginAction = detectPluginFollowUp(normalized, options);

  if ((pluginAction && !normalized.includes("theme")) || followUpPluginAction) {
    const action = normalizeAction(followUpPluginAction?.action || pluginAction[1]);
    const rawTarget = followUpPluginAction?.target || pluginAction[2];
    const target = cleanTarget(rawTarget);
    const siteSummary = await getWordPressSiteSummary(config);
    if (!siteSummary.ok) {
      return null;
    }

    const plugin = findPlugin(siteSummary.summary.plugins.items, target);
    if (!plugin) {
      return null;
    }

    return {
      type: "plugin",
      action,
      pluginFile: plugin.file,
      pluginName: plugin.name,
    };
  }

  const themeAction =
    normalized.match(/\b(?:activate|switch|change|set)\b\s+theme\s+(?:to\s+)?(.+)/) ||
    normalized.match(/\b(?:activate|switch|change|set)\b\s+(.+?)\s+theme\b/) ||
    normalized.match(/\bswitch\s+to\s+(.+)/) ||
    normalized.match(/\bchange\s+to\s+(.+)/);
  if (themeAction) {
    const target = cleanTarget(themeAction[1]);
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

export async function executeWordPressAction(config, action) {
  if (action.type === "noop") {
    return { ok: true, message: action.message };
  }

  if (action.type === "plugin") {
    return changePluginStatus(config, action.pluginFile, action.action);
  }

  if (action.type === "multi_plugins") {
    return changeMultiplePluginStatuses(config, action.plugins, action.action);
  }

  if (action.type === "all_plugins") {
    return changeAllPluginsStatus(config, action.action);
  }

  if (action.type === "theme") {
    return activateTheme(config, action.stylesheet);
  }

  if (action.type === "debug_log") {
    return updateWordPressDebugLog(config, action.enabled);
  }

  return { ok: false, message: "Unknown WordPress action." };
}

async function changeMultiplePluginStatuses(config, plugins, action) {
  const results = [];

  for (const plugin of plugins) {
    const result = await changePluginStatus(config, plugin.pluginFile, action);
    if (!result.ok) {
      return result;
    }
    results.push({
      plugin: result.plugin,
      active: result.active,
    });
  }

  return {
    ok: true,
    action: `${action}_plugins`,
    changed: results.length,
    results,
  };
}

export function formatActionResult(result) {
  if (!result.ok) {
    return `Action failed: ${result.message || "Unknown error"}`;
  }

  if (result.message) {
    return result.message;
  }

  if (result.plugin) {
    return `Done. ${result.plugin} is now ${result.active ? "active" : "inactive"}.`;
  }

  if (result.action === "activate_plugins" || result.action === "deactivate_plugins") {
    const verb = result.action === "activate_plugins" ? "Activated" : "Deactivated";
    const rows = result.results.map((item) => `- ${item.plugin}: ${item.active ? "active" : "inactive"}`).join("\n");
    return `Done. ${verb} ${result.changed} plugin${result.changed === 1 ? "" : "s"}.\n\n${rows}`;
  }

  if (result.action === "deactivate_all_plugins") {
    const names = result.plugins?.length ? `\n\nDeactivated:\n${result.plugins.map((plugin) => `- ${plugin}`).join("\n")}` : "";
    return `Done. Deactivated ${result.count} active plugin${result.count === 1 ? "" : "s"}. Active plugins now: ${result.active_after}.${names}`;
  }

  if (result.action === "activate_all_plugins") {
    const names = result.plugins?.length ? `\n\nActivated:\n${result.plugins.map((plugin) => `- ${plugin}`).join("\n")}` : "";
    const errors = result.errors?.length
      ? `\n\nCould not activate:\n${result.errors.map((error) => `- ${error.plugin}: ${error.message}`).join("\n")}`
      : "";
    return `Done. Activated ${result.count} plugin${result.count === 1 ? "" : "s"}. Active plugins now: ${result.active_after}.${names}${errors}`;
  }

  if (result.action === "enable_debug_log" || result.action === "disable_debug_log") {
    return `Done. WordPress debug log is now ${result.wpDebugLog ? "enabled" : "disabled"}. WP_DEBUG is ${result.wpDebug ? "on" : "off"}.`;
  }

  if (result.theme) {
    return `Done. The active theme is now ${result.theme}.`;
  }

  return "Done.";
}

export function rememberWordPressAction(context, conversationId, action, result) {
  if (!context || !result.ok || action.type === "noop") {
    return;
  }

  if (action.type === "plugin") {
    const previous = context.get(conversationId) || {};
    context.set(conversationId, {
      ...previous,
      type: "plugin",
      action: action.action,
      pluginFile: action.pluginFile,
      pluginName: action.pluginName,
      recentPlugins: rememberRecentPlugin(previous.recentPlugins, action),
      updatedAt: Date.now(),
    });
    return;
  }

  if (action.type === "multi_plugins") {
    const previous = context.get(conversationId) || {};
    context.set(conversationId, {
      ...previous,
      type: "plugin",
      action: action.action,
      recentPlugins: action.plugins,
      updatedAt: Date.now(),
    });
    return;
  }

  if (action.type === "theme") {
    context.set(conversationId, {
      type: "theme",
      action: "activate",
      stylesheet: action.stylesheet,
      themeName: action.themeName,
      updatedAt: Date.now(),
    });
  }
}

function isDeactivateAllPluginsRequest(normalized) {
  if (/\b(how|snippet|code|example|write|explain|why)\b/.test(normalized)) {
    return false;
  }

  return (
    /\b(deactivate|disable)\b/.test(normalized) &&
    /\b(all|every)\b/.test(normalized) &&
    /\bplugins?\b/.test(normalized)
  );
}

function detectAllPluginsAction(normalized) {
  if (/\b(how|snippet|code|example|write|explain|why)\b/.test(normalized)) {
    return null;
  }

  if (!/\b(all|every)\b/.test(normalized) || !/\bplugins?\b/.test(normalized)) {
    return null;
  }

  if (/\b(reactivate|activate|enable)\b/.test(normalized)) {
    return {
      type: "all_plugins",
      action: "activate",
    };
  }

  if (/\b(deactivate|disable)\b/.test(normalized)) {
    return {
      type: "all_plugins",
      action: "deactivate",
    };
  }

  return null;
}

function detectRecentPluginsAction(normalized, options) {
  if (/\b(how|snippet|code|example|write|explain|why)\b/.test(normalized)) {
    return null;
  }

  if (!/\b(both|them|those|these)\b/.test(normalized) || !/\bplugins?\b/.test(normalized)) {
    return null;
  }

  const actionMatch = normalized.match(/\b(reactivate|activate|enable|deactivagte|deactivate|disable)\b/);
  if (!actionMatch) {
    return null;
  }

  const recentPlugins = getRecentPlugins(options);
  if (recentPlugins.length < 2) {
    return null;
  }

  return {
    type: "multi_plugins",
    action: normalizeAction(actionMatch[1]),
    plugins: recentPlugins.slice(0, 2),
  };
}

function getRecentPlugins(options) {
  const remembered = options.context?.get(options.conversationId);
  if (remembered?.recentPlugins?.length) {
    return remembered.recentPlugins;
  }

  const recent = [];
  for (const item of [...(options.history || [])].reverse()) {
    if (item?.role !== "assistant") {
      continue;
    }

    for (const pluginFile of extractPluginFiles(item.text)) {
      if (recent.some((plugin) => plugin.pluginFile === pluginFile)) {
        continue;
      }

      recent.push({
        pluginFile,
        pluginName: pluginFile,
      });

      if (recent.length >= 5) {
        return recent;
      }
    }
  }

  return recent;
}

function rememberRecentPlugin(recentPlugins = [], action) {
  const next = [
    {
      pluginFile: action.pluginFile,
      pluginName: action.pluginName,
    },
    ...recentPlugins.filter((plugin) => plugin.pluginFile !== action.pluginFile),
  ];

  return next.slice(0, 5);
}

function extractPluginFiles(text) {
  const matches = String(text || "").match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.php/g);
  return matches || [];
}

function detectDebugLogAction(normalized) {
  if (/\b(how|snippet|code|example|write|explain|why)\b/.test(normalized)) {
    return null;
  }

  const mentionsDebugLog =
    /\bdebug\s+log\b/.test(normalized) ||
    /\bwp\s+debug\s+log\b/.test(normalized) ||
    (/\bdebug\b/.test(normalized) && /\blogging?\b/.test(normalized));
  if (!mentionsDebugLog) {
    return null;
  }

  if (/\b(enable|activate|turn on|start)\b/.test(normalized)) {
    return {
      type: "debug_log",
      enabled: true,
    };
  }

  if (/\b(disable|diable|deactivate|turn off|stop)\b/.test(normalized)) {
    return {
      type: "debug_log",
      enabled: false,
    };
  }

  return null;
}

function detectPluginFollowUp(normalized, options) {
  if (normalized.includes("theme")) {
    return null;
  }

  const previousAction = getPreviousPluginAction(options);
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

function getPreviousPluginAction(options) {
  const remembered = options.context?.get(options.conversationId);
  if (remembered?.type === "plugin" && remembered.action) {
    return remembered.action;
  }

  for (const item of [...(options.history || [])].reverse()) {
    if (item?.role !== "user") {
      continue;
    }

    const normalized = normalize(item.text);
    const match = normalized.match(/\b(reactivate|activate|enable|deactivagte|deactivate|disable)\b\s+(.+)/);
    if (match && !normalized.includes("theme")) {
      return normalizeAction(match[1]);
    }
  }

  return null;
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

function normalizeAction(action) {
  return ["enable", "activate", "reactivate"].includes(action) ? "activate" : "deactivate";
}

function cleanTarget(value) {
  return value
    ?.replace(/\b(plugin|plugins|extension|please|the|to)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "";
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
