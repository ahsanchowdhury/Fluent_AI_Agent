import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const MAX_EVENTS = 80;

export async function debugPage(config, options = {}) {
  const url = buildUrl(config.localSiteUrl, options.path || options.url || "");
  const screenshotDir = path.resolve(process.cwd(), "memory", "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: {
      width: options.width || 1440,
      height: options.height || 1000,
    },
  });

  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  const badResponses = [];

  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
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
      badResponses.push({
        url: response.url(),
        status,
        statusText: response.statusText(),
      });
      trim(badResponses);
    }
  });

  let response = null;
  let navigationError = "";

  try {
    response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: options.timeout || 20000,
    });
  } catch (error) {
    navigationError = error.message;
  }

  const title = await page.title().catch(() => "");
  const finalUrl = page.url();
  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  const screenshotPath = path.join(screenshotDir, `${Date.now()}-page.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
  await browser.close();

  return {
    requestedUrl: url,
    finalUrl,
    status: response ? response.status() : null,
    title,
    navigationError,
    consoleMessages,
    pageErrors,
    requestFailures,
    badResponses,
    bodyTextPreview: bodyText.replace(/\s+/g, " ").trim().slice(0, 1200),
    screenshotPath,
  };
}

function buildUrl(baseUrl, target) {
  if (!target) {
    return baseUrl;
  }

  if (/^https?:\/\//i.test(target)) {
    return target;
  }

  return new URL(target, ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function trim(items) {
  if (items.length > MAX_EVENTS) {
    items.splice(0, items.length - MAX_EVENTS);
  }
}
