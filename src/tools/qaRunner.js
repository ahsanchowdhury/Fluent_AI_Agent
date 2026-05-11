import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { emitActivity } from "../activity.js";

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

function trim(items, limit = 80) {
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}
