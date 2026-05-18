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
  return runQaSteps(config, {
    recipe: {
      id: recipeIdFromPath(recipePath),
      name: recipe.name || "",
      product: recipe.product || "",
      area: recipe.area || "",
      risk: recipe.risk || "low",
      path: path.relative(process.cwd(), recipePath),
    },
    steps: recipe.steps || [],
    reportSlug: recipeIdFromPath(recipePath),
    activity,
  });
}

export async function runQaSteps(config, { recipe, steps: recipeSteps, reportSlug = "qa-steps", activity = null } = {}) {
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

  emitActivity(activity, "test", `Starting QA recipe: ${recipe.name || reportSlug}`);

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
    for (const [index, step] of (recipeSteps || []).entries()) {
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
    recipe,
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

  const { reportPath, reportHtmlPath } = writeQaReportFiles(reportDir, reportSlug, report);
  emitActivity(activity, "test", `QA recipe ${status}`);

  return {
    ...report,
    reportPath,
    reportHtmlPath,
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

  const { reportPath, reportHtmlPath } = writeQaReportFiles(reportDir, `plugin-smoke-${safeName(matchedPlugin.name)}`, report);
  emitActivity(activity, "test", `Generic plugin QA ${status}`);

  return {
    ...report,
    reportPath,
    reportHtmlPath,
  };
}

function writeQaReportFiles(reportDir, slug, report) {
  const safeSlug = String(slug || "qa-report").replace(/[^\w.-]+/g, "-");
  const basePath = path.join(reportDir, `${Date.now()}-${safeSlug}`);
  const reportPath = `${basePath}.json`;
  const reportHtmlPath = `${basePath}.html`;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(reportHtmlPath, renderQaReportHtml(report));
  return { reportPath, reportHtmlPath };
}

function renderQaReportHtml(report) {
  const title = report.recipe?.name || report.plugin?.name || report.type || "QA Report";
  const screenshots = report.screenshots || [];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} QA Report</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; background: #f6f8fb; color: #18202a; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    header, section { border: 1px solid #d8e0ea; border-radius: 14px; background: #fff; box-shadow: 0 12px 28px rgba(20,24,32,.06); }
    header { padding: 24px; margin-bottom: 18px; }
    section { padding: 20px; margin-top: 18px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 28px; line-height: 1.2; }
    h2 { font-size: 18px; margin-bottom: 12px; }
    h3 { font-size: 15px; margin-bottom: 6px; }
    .muted { color: #667085; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
    .stat { border: 1px solid #d8e0ea; border-radius: 10px; background: #f8fafc; padding: 10px; }
    .stat span { display: block; color: #667085; font-size: 12px; font-weight: 700; }
    .stat strong { display: block; margin-top: 4px; overflow-wrap: anywhere; }
    .status-passed { color: #177245; }
    .status-failed { color: #b42318; }
    ul, ol { margin: 0; padding-left: 22px; }
    li { margin: 6px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #d8e0ea; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f8fafc; font-size: 12px; text-transform: uppercase; color: #667085; }
    code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
    pre { overflow: auto; border: 1px solid #d8e0ea; border-radius: 10px; background: #f8fafc; padding: 12px; white-space: pre-wrap; }
    figure { margin: 16px 0 0; border: 1px solid #d8e0ea; border-radius: 12px; overflow: hidden; background: #f8fafc; }
    figcaption { padding: 10px 12px; color: #667085; font-size: 13px; font-weight: 700; }
    img { display: block; width: 100%; height: auto; background: #fff; }
    @media (max-width: 760px) { main { padding: 14px; } .grid { grid-template-columns: 1fr 1fr; } }
    @media (prefers-color-scheme: dark) {
      body { background: #0c1118; color: #eef4fb; }
      header, section { background: #111923; border-color: #263548; }
      .muted { color: #94a3b8; }
      .stat, th, pre, figure { background: #172231; border-color: #263548; }
      th, td { border-color: #263548; }
      .status-passed { color: #7dd3a8; }
      .status-failed { color: #f97066; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="muted">QA Report</p>
      <h1>${escapeHtml(title)}</h1>
      <div class="grid">
        <div class="stat"><span>Status</span><strong class="status-${escapeHtml(report.status || "unknown")}">${escapeHtml(report.status || "unknown")}</strong></div>
        <div class="stat"><span>Started</span><strong>${escapeHtml(report.startedAt || "")}</strong></div>
        <div class="stat"><span>Product</span><strong>${escapeHtml(report.recipe?.product || report.plugin?.name || "")}</strong></div>
        <div class="stat"><span>Screenshots</span><strong>${escapeHtml(String(screenshots.length))}</strong></div>
      </div>
      ${report.finalUrl ? `<p style="margin-top:16px;"><strong>Final URL:</strong> ${escapeHtml(report.finalUrl)}</p>` : ""}
      ${report.failure ? `<p style="margin-top:16px;"><strong>Failure:</strong> ${escapeHtml(report.failure)}</p>` : ""}
    </header>
    ${renderReportSteps(report.steps || [])}
    ${renderReportScreenshots(screenshots)}
    ${renderReportDiagnostics(report)}
    <section>
      <h2>Raw Summary</h2>
      <pre>${escapeHtml(JSON.stringify(compactReportForHtml(report), null, 2))}</pre>
    </section>
  </main>
</body>
</html>`;
}

function renderReportSteps(steps) {
  return `<section>
    <h2>Steps</h2>
    ${steps.length ? `<table>
      <thead><tr><th>#</th><th>Action</th><th>Status</th><th>Message</th></tr></thead>
      <tbody>${steps.map((step, index) => `<tr>
        <td>${escapeHtml(String(step.index ?? index + 1))}</td>
        <td>${escapeHtml(step.action || "")}</td>
        <td>${escapeHtml(step.status || "passed")}</td>
        <td>${escapeHtml(step.message || "")}</td>
      </tr>`).join("")}</tbody>
    </table>` : "<p class=\"muted\">No steps recorded.</p>"}
  </section>`;
}

function renderReportDiagnostics(report) {
  const diagnostics = [
    ["Console Errors", report.consoleErrors || []],
    ["Page Errors", report.pageErrors || []],
    ["Request Failures", report.requestFailures || []],
    ["Bad Responses", report.badResponses || []],
  ];
  return `<section>
    <h2>Diagnostics</h2>
    ${diagnostics.map(([label, items]) => `<h3>${escapeHtml(label)}</h3>${items.length ? `<pre>${escapeHtml(JSON.stringify(items, null, 2))}</pre>` : "<p class=\"muted\">None detected.</p>"}`).join("")}
  </section>`;
}

function renderReportScreenshots(screenshots) {
  return `<section>
    <h2>Screenshots</h2>
    ${screenshots.length ? screenshots.map((screenshot) => renderEmbeddedScreenshot(screenshot)).join("") : "<p class=\"muted\">No screenshots captured.</p>"}
  </section>`;
}

function renderEmbeddedScreenshot(screenshot) {
  const dataUrl = imageFileToDataUrl(screenshot.path || "");
  if (!dataUrl) {
    return `<p class="muted">${escapeHtml(screenshot.name || "Screenshot")} could not be embedded.</p>`;
  }

  return `<figure>
    <figcaption>${escapeHtml(screenshot.name || "Screenshot")}</figcaption>
    <img src="${dataUrl}" alt="${escapeHtml(screenshot.name || "QA screenshot")}" />
  </figure>`;
}

function imageFileToDataUrl(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    const extension = path.extname(filePath).toLowerCase();
    const mimeType = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
    return `data:${mimeType};base64,${fs.readFileSync(filePath).toString("base64")}`;
  } catch (_error) {
    return "";
  }
}

function compactReportForHtml(report) {
  return {
    type: report.type || "qa-recipe",
    status: report.status,
    failure: report.failure,
    startedAt: report.startedAt,
    finalUrl: report.finalUrl,
    recipe: report.recipe,
    plugin: report.plugin,
    selectedAdminPage: report.selectedAdminPage,
    recommendations: report.recommendations,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

  if (action === "click_optional") {
    const target = step.text || step.label || "";
    const clicked = await clickByTextOptional(page, target);
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => null);
    return stepResult(context.index, action, clicked ? `Clicked ${target}` : `Optional target not found: ${target}`);
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
  const pluginWords = distinctivePluginWords(plugin);
  const folderSlug = String(plugin.file || "").split("/")[0]?.toLowerCase() || "";
  const blocked = /\b(logout|profile|updates?|comments?|media|pages?|posts?|users?|tools|settings|dashboard)\b/i;

  return menuLinks
    .map((link) => {
      const textWords = normalizeWords(link.text);
      const hrefWords = normalizeWords(link.href);
      const matchedWords = pluginWords.filter((word) => [...textWords, ...hrefWords].some((item) => wordsMatch(item, word)));
      const strongHrefMatch = pluginIdentityMatchesHref(plugin, link.href);
      const textScore = pluginWords.reduce((sum, word) => sum + (textWords.some((item) => wordsMatch(item, word)) ? 4 : 0), 0);
      const hrefScore = pluginWords.reduce((sum, word) => sum + (hrefWords.some((item) => wordsMatch(item, word)) ? 1 : 0), 0);
      const pageBoost = /admin\.php\?page=/.test(link.href) ? 2 : 0;
      const topLevelBoost = textScore > 0 && !/\b(entries|settings|tools|reports|addons?|integrations?)\b/i.test(link.text) ? 3 : 0;
      const score = textScore + hrefScore;
      const blockedPenalty = blocked.test(link.text) && score < 4 ? -3 : 0;
      const minimumMatch = strongHrefMatch || matchedWords.length >= 1;
      return {
        ...link,
        score: minimumMatch ? score + pageBoost + topLevelBoost + blockedPenalty + (strongHrefMatch ? 5 : 0) : 0,
        reason: `Matched ${textScore} text points, ${hrefScore} URL points, distinctive words: ${matchedWords.join(", ") || "none"}`,
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
  const pluginWords = distinctivePluginWords(plugin);
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
      const hasPluginWord = pluginWords.some((word) => linkWords.some((item) => wordsMatch(item, word)));
      const strongHrefMatch = pluginIdentityMatchesHref(plugin, link.href);
      return strongHrefMatch && (hasPluginWord || safeText.test(link.text));
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

async function clickByTextOptional(page, text) {
  const target = String(text || "").trim();
  if (!target) {
    return false;
  }

  const escaped = escapeRegExp(target);
  const locators = [
    page.getByRole("tab", { name: new RegExp(escaped, "i") }).first(),
    page.getByRole("button", { name: new RegExp(escaped, "i") }).first(),
    page.getByRole("link", { name: new RegExp(escaped, "i") }).first(),
    page.getByText(target, { exact: false }).first(),
  ];

  for (const locator of locators) {
    if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
      await locator.click({ timeout: 8000 }).catch(() => null);
      return true;
    }
  }

  return false;
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

function distinctivePluginWords(plugin) {
  const generic = new Set([
    "plugin",
    "plugins",
    "addon",
    "free",
    "pro",
    "add",
    "new",
    "the",
    "and",
    "for",
    "easy",
    "data",
    "tool",
    "tools",
    "builder",
    "management",
    "fluent",
  ]);
  const words = normalizeWords(`${plugin.name || ""} ${String(plugin.file || "").split("/")[0] || ""}`)
    .filter((word) => !generic.has(word));
  return [...new Set(words)];
}

function pluginIdentityMatchesHref(plugin, href) {
  const compactHref = compactIdentity(href);
  const folderSlug = String(plugin.file || "").split("/")[0] || "";
  const variants = [
    plugin.name || "",
    folderSlug,
    safeName(plugin.name || ""),
    safeName(folderSlug),
  ].map(compactIdentity).filter((value) => value.length >= 5);

  return [...new Set(variants)].some((variant) => compactHref.includes(variant) || variant.includes(compactHref));
}

function compactIdentity(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function wordsMatch(candidate, expected) {
  if (!candidate || !expected) return false;
  if (candidate === expected) return true;
  if (candidate.length >= 5 && expected.length >= 5) {
    return candidate.startsWith(expected) || expected.startsWith(candidate);
  }
  return false;
}

function trim(items, limit = 80) {
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}
