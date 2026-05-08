import {
  activateTheme,
  changeAllPluginsStatus,
  changePluginStatus,
  createWordPressContent,
  getWordPressSiteSummary,
  installWordPressOrgPlugin,
  listThemes,
  updateWordPressDebugLog,
} from "./tools/wordpress.js";

export async function detectWordPressAction(config, message, options = {}) {
  const normalized = normalize(message);
  const supportQuestion = isLikelySupportQuestion(message, normalized);

  const pendingContentAction = detectPendingContentAction(message, normalized, options);
  if (pendingContentAction) {
    return pendingContentAction;
  }

  const contentAction = detectCreateContentAction(message, normalized);
  if (contentAction) {
    return contentAction;
  }

  const debugLogAction = detectDebugLogAction(normalized);
  if (debugLogAction) {
    return debugLogAction;
  }

  const allPluginsAction = detectAllPluginsAction(normalized);
  if (allPluginsAction) {
    return allPluginsAction;
  }

  const installPluginAction = detectInstallPluginAction(normalized);
  if (installPluginAction) {
    return installPluginAction;
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
    if (supportQuestion && !isExplicitPluginManagementRequest(normalized)) {
      return null;
    }

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
    if (supportQuestion && !isExplicitThemeManagementRequest(normalized)) {
      return null;
    }

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

  if (action.type === "install_plugin") {
    return installWordPressOrgPlugin(config, action.query, { activate: action.activate });
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

  if (action.type === "content_prompt") {
    return {
      ok: true,
      action: "content_prompt",
      pendingContent: action.pendingContent,
      message: formatContentPrompt(action.pendingContent),
    };
  }

  if (action.type === "create_content") {
    return createWordPressContent(config, action);
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

  if (result.action === "install_plugin") {
    const installedText = result.already_installed ? "was already installed" : "was installed";
    const activeText = result.activated ? ` and is now ${result.active ? "active" : "inactive"}` : "";
    return `Done. ${result.name || result.slug} ${installedText}${activeText}.\n\nPlugin file: ${result.plugin}${result.version ? `\nVersion: ${result.version}` : ""}`;
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

  if (result.action === "create_content") {
    const typeLabel = result.postType === "page" ? "page" : "post";
    return [
      `Done. Created ${typeLabel}: ${result.title}`,
      `Status: ${result.status}`,
      `View: ${result.permalink}`,
      result.editUrl ? `Edit: ${result.editUrl}` : "",
    ].filter(Boolean).join("\n");
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

  if (result.action === "content_prompt") {
    const previous = context.get(conversationId) || {};
    if (!result.pendingContent) {
      const { pendingContent: _pendingContent, ...rest } = previous;
      context.set(conversationId, {
        ...rest,
        updatedAt: Date.now(),
      });
      return;
    }

    context.set(conversationId, {
      ...previous,
      pendingContent: result.pendingContent,
      updatedAt: Date.now(),
    });
    return;
  }

  if (action.type === "create_content") {
    const previous = context.get(conversationId) || {};
    const { pendingContent: _pendingContent, ...rest } = previous;
    context.set(conversationId, {
      ...rest,
      type: "content",
      postType: action.postType,
      title: action.title,
      id: result.id,
      updatedAt: Date.now(),
    });
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

  if (action.type === "install_plugin" && result.plugin) {
    const previous = context.get(conversationId) || {};
    context.set(conversationId, {
      ...previous,
      type: "plugin",
      action: "activate",
      pluginFile: result.plugin,
      pluginName: result.name || action.query,
      recentPlugins: rememberRecentPlugin(previous.recentPlugins, {
        pluginFile: result.plugin,
        pluginName: result.name || action.query,
      }),
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

function isLikelySupportQuestion(message, normalized) {
  const raw = String(message || "");
  const longMessage = raw.length > 180;
  const hasQuestionShape =
    raw.includes("?") ||
    /\b(hello|hi)\s+.+\bsupport\b/.test(normalized) ||
    /\b(need help|i am using|i m using|i would like|i cannot|i can not|i could not|i do not|i dont|my goal|as a workaround|the issue is|at the moment|to conclude|please advise|please advice|thank you)\b/.test(normalized) ||
    /\b(is there|if not|built in|recommended workaround|recommended way|how can|how do|can i|could i|should i|would it)\b/.test(normalized) ||
    /\b\d+\s+(global|stock|price|plugin|variation|category|slug|mapping|workaround)\b/.test(normalized);

  const mentionsFeatureContext =
    /\b(stock|subscription|variation|digital product|price|limit|access|community|csv|import|mapping|field|category|slug|workaround|built in)\b/.test(normalized);

  return (longMessage && mentionsFeatureContext) || hasQuestionShape;
}

function isExplicitPluginManagementRequest(normalized) {
  if (/\b(price|stock|subscription|variation|digital product|offer|access|community|category|slug|csv|import|mapping|field)\b/.test(normalized)) {
    return false;
  }

  return (
    /^(?:please\s+)?(?:reactivate|activate|enable|deactivagte|deactivate|disable)\s+.+\b(?:plugin|extension|addon|add on)\b/.test(normalized) ||
    /^(?:please\s+)?(?:reactivate|activate|enable|deactivagte|deactivate|disable)\s+[a-z0-9][a-z0-9 ]{1,80}$/.test(normalized) ||
    /\b(?:reactivate|activate|enable|deactivagte|deactivate|disable)\s+all\s+plugins?\b/.test(normalized)
  );
}

function isExplicitThemeManagementRequest(normalized) {
  return (
    /^(?:please\s+)?(?:activate|switch|change|set)\s+(?:theme\s+)?(?:to\s+)?[a-z0-9][a-z0-9 ]{1,80}$/.test(normalized) ||
    /\b(?:activate|switch|change|set)\s+theme\s+(?:to\s+)?[a-z0-9][a-z0-9 ]{1,80}$/.test(normalized)
  );
}

function detectPendingContentAction(message, normalized, options) {
  const pendingContent = options.context?.get(options.conversationId)?.pendingContent;
  if (!pendingContent) {
    return null;
  }

  if (/\b(cancel|stop|never mind|nevermind)\b/.test(normalized)) {
    return {
      type: "content_prompt",
      pendingContent: null,
      message: "Okay, cancelled the page/post creation request.",
    };
  }

  const extracted = extractContentDetails(message);
  const next = {
    ...pendingContent,
    ...Object.fromEntries(Object.entries(extracted).filter(([, value]) => value)),
  };

  if (!next.postType) {
    if (/\bpage\b/.test(normalized)) {
      next.postType = "page";
    } else if (/\bpost\b/.test(normalized) || /\bblog\b/.test(normalized)) {
      next.postType = "post";
    }
  }

  if (next.title && !next.content && !extracted.content && !extracted.title) {
    next.content = String(message || "").trim();
  } else if (!next.title && next.content && !extracted.content && !extracted.title) {
    next.title = String(message || "").trim();
  } else if (!next.title && !next.content) {
    next.title = String(message || "").trim();
  }

  if (!next.postType || !next.title || !next.content) {
    return {
      type: "content_prompt",
      pendingContent: next,
    };
  }

  return {
    type: "create_content",
    postType: next.postType,
    title: next.title,
    content: next.content,
    status: next.status || "publish",
  };
}

function detectCreateContentAction(message, normalized) {
  if (isInformationalContentQuestion(normalized)) {
    return null;
  }

  const details = extractContentDetails(message);
  const explicitCreate = getExplicitCreateContentType(normalized);
  const typedDetails =
    details.title &&
    details.content &&
    (/\bpage\b/.test(normalized) || /\bpost\b/.test(normalized) || /\bblog\b/.test(normalized) || /\barticle\b/.test(normalized));

  if (!explicitCreate && !typedDetails) {
    return null;
  }

  const postType = explicitCreate || (/\bpage\b/.test(normalized) ? "page" : "post");
  const status = /\bdraft\b/.test(normalized) ? "draft" : "publish";
  const pendingContent = {
    postType,
    status,
    title: details.title || "",
    content: details.content || "",
  };

  if (!pendingContent.title || !pendingContent.content) {
    return {
      type: "content_prompt",
      pendingContent,
    };
  }

  return {
    type: "create_content",
    postType,
    status,
    title: pendingContent.title,
    content: pendingContent.content,
  };
}

function isInformationalContentQuestion(normalized) {
  return (
    /\b(how|what|when|where|why|which|can|could|should|would|is|are|do|does|did|snippet|code|example|write|explain|show|list|find|check|debug|fix|help)\b/.test(normalized) &&
    !/\b(create|make|add|publish|draft)\s+(?:(?:a|an|new|wordpress)\s+){0,3}(?:page|post|blog|article)\b/.test(normalized)
  );
}

function getExplicitCreateContentType(normalized) {
  const createPagePatterns = [
    /\b(?:create|make|add|publish|draft)\s+(?:(?:a|an|new|wordpress)\s+){0,3}page\b/,
    /\b(?:create|make|add|publish|draft)\s+(?:(?:a|an|new|wordpress)\s+){0,3}landing\s+page\b/,
    /\b(?:create|make|add|publish|draft)\s+page\s+(?:called|named|titled|with|for)\b/,
  ];

  if (createPagePatterns.some((pattern) => pattern.test(normalized))) {
    return "page";
  }

  const createPostPatterns = [
    /\b(?:create|make|add|publish|draft)\s+(?:(?:a|an|new|wordpress)\s+){0,3}post\b/,
    /\b(?:create|make|add|publish|draft)\s+(?:(?:a|an|new|wordpress)\s+){0,3}blog\s+post\b/,
    /\b(?:create|make|add|publish|draft)\s+(?:(?:a|an|new)\s+){0,3}article\b/,
    /\b(?:create|make|add|publish|draft)\s+post\s+(?:called|named|titled|with|for)\b/,
  ];

  if (createPostPatterns.some((pattern) => pattern.test(normalized))) {
    return "post";
  }

  return null;
}

function extractContentDetails(message) {
  const text = String(message || "").trim();
  const title =
    extractLabelValue(text, ["title", "page title", "post title"]) ||
    extractQuotedTitle(text) ||
    "";
  const content =
    extractLabelValue(text, ["content", "body", "description", "page content", "post content"]) ||
    "";

  return {
    title: cleanContentValue(title),
    content: cleanContentValue(content),
  };
}

function extractLabelValue(text, labels) {
  for (const label of labels) {
    const pattern = new RegExp(
      `(?:^|\\n|\\b)${escapeRegExp(label)}\\s*[:=-]\\s*([\\s\\S]*?)(?=\\s+(?:title|content|body|description)\\s*[:=-]|$)`,
      "i"
    );
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function extractQuotedTitle(text) {
  const match =
    text.match(/\b(?:page|post|blog post|article)\s+(?:called|named|title[d]?)\s+["“]([^"”]+)["”]/i) ||
    text.match(/\b(?:called|named|title[d]?)\s+["“]([^"”]+)["”]/i);
  return match?.[1] || "";
}

function cleanContentValue(value) {
  return String(value || "")
    .replace(/\s*\b(?:please|thanks|thank you)\s*$/i, "")
    .trim();
}

function formatContentPrompt(pendingContent) {
  if (!pendingContent) {
    return "Okay, cancelled the page/post creation request.";
  }

  const typeLabel = pendingContent.postType || "page or post";
  const missing = [];
  if (!pendingContent.postType) missing.push("type: page or post");
  if (!pendingContent.title) missing.push("title");
  if (!pendingContent.content) missing.push("content");

  return [
    `Sure. I can create the ${typeLabel}.`,
    `Please send the ${missing.join(" and ")}.`,
    "",
    "You can reply like this:",
    `Title: ${pendingContent.postType === "post" ? "My Blog Post" : "About Us"}`,
    `Content: Write the ${pendingContent.postType === "post" ? "post" : "page"} content here.`,
  ].join("\n");
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

function detectInstallPluginAction(normalized) {
  if (/\b(how|snippet|code|example|write|explain|why)\b/.test(normalized)) {
    return null;
  }

  const installMatch =
    normalized.match(/\b(?:install|intall|insall)\s+(.+?)\s+(?:plugin|from\s+(?:the\s+)?plugin\s+directory|from\s+(?:the\s+)?plugins\s+directory)\b/) ||
    normalized.match(/\badd\s+new\s+(.+?)\s+plugin\b/) ||
    normalized.match(/\b(?:install|intall|insall|add)\s+(?:new\s+)?plugin\s+(.+)/) ||
    normalized.match(/\b(?:install|intall|insall)\s+(.+)/);
  if (!installMatch) {
    return null;
  }

  const query = installMatch[1]
    .replace(/\b(and|then|also)?\s*(activate|enable|reactivate)\s*(it|plugin)?\b/g, " ")
    .replace(/\bfrom\s+(?:the\s+)?plugins?\s+directory\b/g, " ")
    .replace(/\s+plugin\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!query) {
    return null;
  }

  return {
    type: "install_plugin",
    query,
    activate: true,
  };
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
