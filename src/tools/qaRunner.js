import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { emitActivity } from "../activity.js";
import { getWordPressSiteSummary } from "./wordpress.js";

const RECIPES_ROOT = path.resolve(process.cwd(), "tests", "recipes");

export function listQaRecipes() {
  if (!fs.existsSync(RECIPES_ROOT)) {
    return [];
  }

  return walkRecipeFiles(RECIPES_ROOT).map((filePath) => {
    const recipe = readRecipeFile(filePath);
    return {
      id: recipeIdFromPath(filePath),
      path: path.relative(RECIPES_ROOT, filePath),
      name: recipe.name || recipeIdFromPath(filePath),
      product: recipe.product || "",
      area: recipe.area || "",
      risk: recipe.risk || "low",
      description: recipe.description || "",
      steps: Array.isArray(recipe.steps) ? recipe.steps.length : 0,
    };
  });
}

export async function runQaRecipe(config, { recipeId, activity = null } = {}) {
  const recipePath = resolveRecipePath(recipeId);
  const recipe = readRecipeFile(recipePath);
  const reportDir = path.resolve(process.cwd(), "memory", "qa-reports");
  const screenshotDir = path.resolve(process.cwd(), "memory", "screenshots");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.mkdirSync(screenshotDir, { recursive: true });

  if ((recipe.risk || "low") !== "low") {
    throw new Error(`Only low-risk QA recipes are enabled in this first version. Recipe risk is "${recipe.risk}".`);
  }

  if (!config.wpAdminUser || !config.wpAdminPassword) {
    throw new Error("WP_ADMIN_USER and WP_ADMIN_PASSWORD are required in .env to run QA recipes.");
  }

  emitActivity(activity, "test", `Starting QA recipe: ${recipe.name || recipeId}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  const badResponses = [];
  const steps = [];
  const screenshots = [];

  page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() });
    trim(consoleMessages);
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    trim(pageErrors);
  });
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || "Unknown failure",
    });
    trim(requestFailures);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      badResponses.push({ url: response.url(), status, statusText: response.statusText() });
      trim(badResponses);
    }
  });

  let status = "passed";
  let failure = "";

  try {
    for (const [index, step] of recipe.steps.entries()) {
      const result = await runRecipeStep(page, config, step, {
        index,
        recipe,
        screenshotDir,
        screenshots,
        activity,
      });
      steps.push(result);
    }
  } catch (error) {
    status = "failed";
    failure = error.message;
    steps.push({
      index: steps.length + 1,
      action: "failed",
      status: "failed",
      message: error.message,
    });
    emitActivity(activity, "error", `QA recipe failed: ${error.message}`);
  }

  const finalScreenshotPath = path.join(screenshotDir, `${Date.now()}-qa-final.png`);
  await page.screenshot({ path: finalScreenshotPath, fullPage: true }).catch(() => null);
  screenshots.push({ name: "final", path: finalScreenshotPath });
  await browser.close().catch(() => null);

  const report = {
    recipe: {
      id: recipeIdFromPath(recipePath),
      name: recipe.name || "",
      product: recipe.product || "",
      area: recipe.area || "",
      risk: recipe.risk || "low",
      path: path.relative(process.cwd(), recipePath),
    },
    status,
    failure,
    startedAt: new Date().toISOString(),
    finalUrl: page.url(),
    steps,
    screenshots,
    consoleErrors: consoleMessages.filter((message) => message.type === "error"),
    pageErrors,
    requestFailures,
    badResponses,
  };

  const reportPath = path.join(reportDir, `${Date.now()}-${recipeIdFromPath(recipePath).replace(/[^\w.-]+/g, "-")}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  emitActivity(activity, "test", `QA recipe ${status}`);

  return {
    ...report,
    reportPath,
  };
}

export async function runPluginQaSmoke(config, { plugin = "", maxLinks = 3, activity = null } = {}) {
  const reportDir = path.resolve(process.cwd(), "memory", "qa-reports");
  const screenshotDir = path.resolve(process.cwd(), "memory", "screenshots");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.mkdirSync(screenshotDir, { recursive: true });

  if (!config.wpAdminUser || !config.wpAdminPassword) {
    throw new Error("WP_ADMIN_USER and WP_ADMIN_PASSWORD are required in .env to run plugin QA smoke tests.");
  }

  emitActivity(activity, "test", `Preparing generic plugin QA for ${plugin || "requested plugin"}`);
  const siteSummary = await getWordPressSiteSummary(config);
  if (!siteSummary.ok) {
    throw new Error(`Could not read WordPress site summary: ${siteSummary.message}`);
  }

  const matchedPlugin = matchPlugin(siteSummary.summary.plugins.items, plugin);
  if (!matchedPlugin) {
    throw new Error(`Could not find an installed plugin matching "${plugin}".`);
  }

  emitActivity(activity, "test", `Matched plugin: ${matchedPlugin.name}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const diagnostics = attachDiagnostics(page);
  const steps = [];
  const screenshots = [];
  let status = "passed";
  let failure = "";
  let finalUrl = "";
  let menuCandidates = [];
  let selectedAdminPage = null;
  let pageSummary = null;
  const exploredLinks = [];

  try {
    emitActivity(activity, "wordpress", "Logging in to WordPress Admin");
    await loginAdmin(page, config);
    steps.push(stepResult(0, "login_admin", "Logged in to WordPress Admin"));

    emitActivity(activity, "test", "Scanning admin menu for plugin pages");
    menuCandidates = await collectAdminMenuLinks(page);
    selectedAdminPage = selectPluginAdminPage(menuCandidates, matchedPlugin);

    if (!selectedAdminPage) {
      const pluginsUrl = buildAdminUrl(config, `plugins.php?s=${encodeURIComponent(matchedPlugin.name)}`);
      emitActivity(activity, "test", "Plugin menu was not found; opening Plugins screen");
      await page.goto(pluginsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      selectedAdminPage = {
        text: "Plugins screen fallback",
        href: page.url(),
        score: 0,
        reason: "No matching admin menu item was detected.",
      };
    } else {
      emitActivity(activity, "test", `Opening plugin admin page: ${selectedAdminPage.text}`);
      await page.goto(selectedAdminPage.href, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
    }

    steps.push(stepResult(1, "open_plugin_admin", `Opened ${selectedAdminPage.text}: ${page.url()}`));
    pageSummary = await inspectAdminPage(page);
    const firstScreenshotPath = await captureQaScreenshot(page, screenshotDir, `${matchedPlugin.name}-admin`, screenshots);
    steps.push(stepResult(2, "screenshot", "Captured plugin admin page screenshot", { screenshotPath: firstScreenshotPath }));

    const safeLinks = findSafeAdminLinks(pageSummary.links, selectedAdminPage.href, matchedPlugin).slice(0, Math.max(0, Math.min(Number(maxLinks) || 3, 5)));
    for (const [index, link] of safeLinks.entries()) {
      emitActivity(activity, "test", `Exploring safe admin link: ${link.text}`);
      await page.goto(link.href, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      const linkSummary = await inspectAdminPage(page);
      const screenshotPath = await captureQaScreenshot(page, screenshotDir, `${matchedPlugin.name}-${link.text}`, screenshots);
      exploredLinks.push({
        text: link.text,
        href: link.href,
        finalUrl: page.url(),
        title: linkSummary.title,
        visibleButtons: linkSummary.buttons.slice(0, 20),
        visibleForms: linkSummary.forms,
        screenshotPath,
      });
      steps.push(stepResult(3 + index, "explore_admin_link", `Opened ${link.text}: ${page.url()}`, { screenshotPath }));
    }

    finalUrl = page.url();
    const fatalSignals = detectFatalSignals([pageSummary, ...exploredLinks]);
    if (fatalSignals.length || diagnostics.pageErrors.length || diagnostics.badResponses.some((item) => item.status >= 500)) {
      status = "failed";
      failure = fatalSignals[0] || diagnostics.pageErrors[0] || "One or more server/page errors were detected.";
    }
  } catch (error) {
    status = "failed";
    failure = error.message;
    finalUrl = page.url();
    steps.push({
      index: steps.length + 1,
      action: "failed",
      status: "failed",
      message: error.message,
    });
    emitActivity(activity, "error", `Plugin QA failed: ${error.message}`);
  }

  const finalScreenshotPath = await captureQaScreenshot(page, screenshotDir, `${matchedPlugin.name}-final`, screenshots).catch(() => "");
  await browser.close().catch(() => null);

  const report = {
    type: "generic-plugin-smoke",
    status,
    failure,
    startedAt: new Date().toISOString(),
    pluginQuery: plugin,
    plugin: matchedPlugin,
    selectedAdminPage,
    finalUrl,
    steps,
    pageSummary,
    exploredLinks,
    screenshots,
    finalScreenshotPath,
    consoleErrors: diagnostics.consoleMessages.filter((message) => message.type === "error"),
    pageErrors: diagnostics.pageErrors,
    requestFailures: diagnostics.requestFailures,
    badResponses: diagnostics.badResponses,
    recommendations: buildPluginQaRecommendations({ status, failure, selectedAdminPage, pageSummary, exploredLinks, diagnostics }),
  };

  const reportPath = path.join(reportDir, `${Date.now()}-plugin-smoke-${safeName(matchedPlugin.name)}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  emitActivity(activity, "test", `Generic plugin QA ${status}`);

  return {
    ...report,
    reportPath,
  };
}

async function runRecipeStep(page, config, step, context) {
  const action = typeof step === "string" ? step : step.action;
  const label = step.label || step.text || step.path || action;
  emitActivity(context.activity, "test", `QA step: ${label}`);

  if (action === "login_admin") {
    await loginAdmin(page, config);
    return stepResult(context.index, action, "Logged in to WordPress Admin");
  }

  if (action === "go_to") {
    const url = buildAdminUrl(config, step.path || "");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
    return stepResult(context.index, action, `Opened ${url}`);
  }

  if (action === "click") {
    await clickByText(page, step.text || step.label || "");
    return stepResult(context.index, action, `Clicked ${step.text || step.label}`);
  }

  if (action === "fill") {
    await fillField(page, step);
    return stepResult(context.index, action, `Filled ${step.label || step.selector}`);
  }

  if (action === "wait_for_text" || action === "assert_text") {
    await page.getByText(step.text, { exact: false }).first().waitFor({ timeout: step.timeout || 10000 });
    return stepResult(context.index, action, `Found text: ${step.text}`);
  }

  if (action === "assert_url_contains") {
    const currentUrl = page.url();
    if (!currentUrl.includes(step.value)) {
      throw new Error(`Expected URL to contain "${step.value}", got "${currentUrl}".`);
    }
    return stepResult(context.index, action, `URL contains ${step.value}`);
  }

  if (action === "screenshot") {
    const name = step.name || `step-${context.index + 1}`;
    const screenshotPath = path.join(context.screenshotDir, `${Date.now()}-qa-${safeName(name)}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    context.screenshots.push({ name, path: screenshotPath });
    return stepResult(context.index, action, `Captured screenshot: ${name}`, { screenshotPath });
  }

  throw new Error(`Unsupported QA recipe action: ${action}`);
}

async function loginAdmin(page, config) {
  await page.goto(wpLoginUrl(config.wpAdminUrl), { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

  const loginField = page.locator("#user_login").first();
  if (await loginField.isVisible({ timeout: 5000 }).catch(() => false)) {
    await loginField.fill(config.wpAdminUser);
    await page.locator("#user_pass").fill(config.wpAdminPassword);
    await page.locator("#wp-submit").click();
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
  }

  await page.goto(config.wpAdminUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

  if (await page.locator("#user_login").isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error("WordPress admin login failed. Check WP_ADMIN_USER and WP_ADMIN_PASSWORD.");
  }
}

function attachDiagnostics(page) {
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  const badResponses = [];

  page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() });
    trim(consoleMessages);
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    trim(pageErrors);
  });
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || "Unknown failure",
    });
    trim(requestFailures);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      badResponses.push({ url: response.url(), status, statusText: response.statusText() });
      trim(badResponses);
    }
  });

  return {
    consoleMessages,
    pageErrors,
    requestFailures,
    badResponses,
  };
}

function matchPlugin(plugins, query) {
  const terms = normalizeWords(query);
  const activeBoost = (plugin) => plugin.active ? 1 : 0;
  const scored = plugins.map((plugin) => {
    const haystack = normalizeWords(`${plugin.name} ${plugin.file}`);
    const score = terms.length
      ? terms.reduce((sum, term) => sum + (haystack.some((word) => word.includes(term) || term.includes(word)) ? 3 : 0), 0)
      : 0;
    return {
      plugin,
      score: score + activeBoost(plugin),
    };
  }).sort((a, b) => b.score - a.score || a.plugin.name.localeCompare(b.plugin.name));

  if (!terms.length) {
    return null;
  }

  return scored[0]?.score > 0 ? scored[0].plugin : null;
}

async function collectAdminMenuLinks(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll("#adminmenu a[href], #wpadminbar a[href]")]
      .map((link) => ({
        text: (link.textContent || "").replace(/\s+/g, " ").trim(),
        href: link.href,
        id: link.id || "",
        className: link.className || "",
      }))
      .filter((link) => link.text && link.href && /\/wp-admin\//.test(link.href));
  });
}

function selectPluginAdminPage(menuLinks, plugin) {
  const pluginWords = normalizeWords(`${plugin.name} ${plugin.file}`);
  const folderWords = normalizeWords(String(plugin.file || "").split("/")[0] || "");
  const words = [...new Set([...pluginWords, ...folderWords])].filter((word) => !["plugin", "plugins", "pro", "free", "addon", "add"].includes(word));
  const blocked = /\b(logout|profile|updates?|comments?|media|pages?|posts?|users?|tools|settings|dashboard)\b/i;

  return menuLinks
    .map((link) => {
      const textWords = normalizeWords(link.text);
      const hrefWords = normalizeWords(link.href);
      const textScore = words.reduce((sum, word) => sum + (textWords.some((item) => item.includes(word) || word.includes(item)) ? 4 : 0), 0);
      const hrefScore = words.reduce((sum, word) => sum + (hrefWords.some((item) => item.includes(word) || word.includes(item)) ? 1 : 0), 0);
      const pageBoost = /admin\.php\?page=/.test(link.href) ? 2 : 0;
      const topLevelBoost = textScore > 0 && !/\b(entries|settings|tools|reports|addons?|integrations?)\b/i.test(link.text) ? 3 : 0;
      const score = textScore + hrefScore;
      const blockedPenalty = blocked.test(link.text) && score < 4 ? -3 : 0;
      return {
        ...link,
        score: score + pageBoost + topLevelBoost + blockedPenalty,
        reason: `Matched ${textScore} text points and ${hrefScore} URL points`,
      };
    })
    .filter((link) => link.score > 1)
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))[0] || null;
}

async function inspectAdminPage(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const textOf = (element) => (element.textContent || element.value || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    return {
      title: document.title,
      url: location.href,
      bodyTextPreview: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 3000),
      headings: [...document.querySelectorAll("h1,h2,h3")].filter(visible).map(textOf).filter(Boolean).slice(0, 30),
      buttons: [...document.querySelectorAll("button, input[type='button'], input[type='submit'], .button, a.button")]
        .filter(visible)
        .map(textOf)
        .filter(Boolean)
        .slice(0, 50),
      forms: [...document.querySelectorAll("form")].map((form) => ({
        id: form.id || "",
        className: form.className || "",
        action: form.action || "",
        method: form.method || "get",
        fields: [...form.querySelectorAll("input,select,textarea")].map((field) => ({
          tag: field.tagName.toLowerCase(),
          type: field.getAttribute("type") || "",
          name: field.getAttribute("name") || "",
          id: field.id || "",
          required: field.required || false,
        })).slice(0, 40),
      })).slice(0, 12),
      links: [...document.querySelectorAll("a[href]")]
        .filter(visible)
        .map((link) => ({
          text: textOf(link),
          href: link.href,
        }))
        .filter((link) => link.text && link.href)
        .slice(0, 160),
    };
  });
}

function findSafeAdminLinks(links, currentHref, plugin) {
  const pluginWords = normalizeWords(`${plugin.name} ${plugin.file}`);
  const safeText = /\b(settings?|setup|all|forms?|entries|submissions?|contacts?|tables?|products?|reports?|tools?|integrations?|add new|create)\b/i;
  const unsafeText = /\b(skip|delete|remove|trash|deactivate|activate|disconnect|logout|reset|clear|sync|send|publish|import|export|install|uninstall|migrate|upgrade|license)\b/i;
  const seen = new Set([currentHref]);

  return links
    .filter((link) => {
      if (!link.href.includes("/wp-admin/")) return false;
      if (/#wp-|#content|#toolbar|#adminmenu|#main/i.test(link.href)) return false;
      if (seen.has(link.href)) return false;
      if (unsafeText.test(link.text) || unsafeText.test(link.href)) return false;
      const linkWords = normalizeWords(`${link.text} ${link.href}`);
      const hasPluginWord = pluginWords.some((word) => linkWords.some((item) => item.includes(word) || word.includes(item)));
      const isPluginAdminPage = /admin\.php\?page=/i.test(link.href);
      return hasPluginWord || (isPluginAdminPage && safeText.test(link.text));
    })
    .map((link) => {
      seen.add(link.href);
      return link;
    });
}

async function captureQaScreenshot(page, screenshotDir, name, screenshots) {
  const screenshotPath = path.join(screenshotDir, `${Date.now()}-qa-${safeName(name)}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  screenshots.push({ name, path: screenshotPath });
  return screenshotPath;
}

function detectFatalSignals(summaries) {
  const signals = [];
  for (const summary of summaries.filter(Boolean)) {
    const text = `${summary.bodyTextPreview || ""} ${(summary.headings || []).join(" ")}`;
    if (/fatal error|critical error|there has been a critical error|parse error|warning:\s|deprecated:/i.test(text)) {
      signals.push("The page shows a PHP/WordPress error message.");
    }
  }
  return signals;
}

function buildPluginQaRecommendations({ status, failure, selectedAdminPage, pageSummary, exploredLinks, diagnostics }) {
  const recommendations = [];
  if (!selectedAdminPage || selectedAdminPage.reason?.includes("No matching")) {
    recommendations.push("No plugin-specific admin menu was detected. Add a plugin-specific recipe for deeper coverage.");
  }
  if (diagnostics.pageErrors.length || diagnostics.consoleMessages.some((message) => message.type === "error")) {
    recommendations.push("Review browser console/page errors from the report before release.");
  }
  if (diagnostics.badResponses.some((response) => response.status >= 500)) {
    recommendations.push("Fix failing server requests before release.");
  }
  if (!pageSummary?.forms?.length && !exploredLinks.some((link) => link.visibleForms?.length)) {
    recommendations.push("No forms were discovered in the sampled admin pages; deeper workflow testing may need a plugin-specific recipe.");
  }
  if (status === "passed" && !recommendations.length) {
    recommendations.push("Generic smoke test passed. Add product-specific recipes for create/edit/submit workflows.");
  }
  if (failure) {
    recommendations.unshift(`Investigate failure: ${failure}`);
  }
  return recommendations;
}

async function clickByText(page, text) {
  const escaped = escapeRegExp(text);
  const roleLocator = page.getByRole("button", { name: new RegExp(escaped, "i") }).first();
  if (await roleLocator.isVisible({ timeout: 2500 }).catch(() => false)) {
    await roleLocator.click({ timeout: 10000 });
    return;
  }

  const link = page.getByRole("link", { name: new RegExp(escaped, "i") }).first();
  if (await link.isVisible({ timeout: 2500 }).catch(() => false)) {
    await link.click({ timeout: 10000 });
    return;
  }

  await page.getByText(text, { exact: false }).first().click({ timeout: 10000 });
}

async function fillField(page, step) {
  if (step.selector) {
    await page.locator(step.selector).first().fill(String(step.value || ""));
    return;
  }

  if (step.label) {
    await page.getByLabel(step.label, { exact: false }).first().fill(String(step.value || ""));
    return;
  }

  throw new Error("fill action requires selector or label.");
}

function buildAdminUrl(config, targetPath) {
  if (/^https?:\/\//i.test(targetPath)) {
    return targetPath;
  }

  return new URL(String(targetPath || "").replace(/^\/+/, ""), ensureTrailingSlash(config.wpAdminUrl)).toString();
}

function wpLoginUrl(adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = url.pathname.replace(/\/wp-admin\/?$/, "/wp-login.php");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resolveRecipePath(recipeId) {
  const cleanId = String(recipeId || "").trim().replace(/\\/g, "/");
  if (!cleanId) {
    throw new Error("recipeId is required.");
  }

  const withExtension = cleanId.endsWith(".json") ? cleanId : `${cleanId}.json`;
  const resolved = path.resolve(RECIPES_ROOT, withExtension);

  if (!resolved.startsWith(`${RECIPES_ROOT}${path.sep}`)) {
    throw new Error("Recipe path is outside the recipes folder.");
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`QA recipe not found: ${recipeId}`);
  }

  return resolved;
}

function readRecipeFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function walkRecipeFiles(root) {
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkRecipeFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      results.push(entryPath);
    }
  }
  return results;
}

function recipeIdFromPath(filePath) {
  return path.relative(RECIPES_ROOT, filePath).replace(/\.json$/i, "").replace(/\\/g, "/");
}

function stepResult(index, action, message, extra = {}) {
  return {
    index: index + 1,
    action,
    status: "passed",
    message,
    ...extra,
  };
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function safeName(value) {
  return String(value || "screenshot").replace(/[^\w.-]+/g, "-").slice(0, 80);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function trim(items, limit = 80) {
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}
