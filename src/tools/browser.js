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

export async function testFormPage(config, options = {}) {
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
  const submitRequests = [];

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

  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH"].includes(request.method())) {
      submitRequests.push({
        url: request.url(),
        method: request.method(),
        postData: (request.postData() || "").slice(0, 1200),
      });
      trim(submitRequests);
    }
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
      timeout: options.timeout || 25000,
    });
  } catch (error) {
    navigationError = error.message;
  }

  const beforeScreenshotPath = path.join(screenshotDir, `${Date.now()}-form-before.png`);
  await page.screenshot({ path: beforeScreenshotPath, fullPage: true }).catch(() => null);

  const beforeForms = await inspectForms(page);
  const fillActions = await fillVisibleFormFields(page);
  const submitResult = await submitFirstForm(page);
  await page.waitForTimeout(options.afterSubmitWait || 1800);
  const afterForms = await inspectForms(page);
  const validationMessages = await collectValidationMessages(page);
  const visibleMessages = await collectVisibleMessages(page);
  const afterScreenshotPath = path.join(screenshotDir, `${Date.now()}-form-after.png`);
  await page.screenshot({ path: afterScreenshotPath, fullPage: true }).catch(() => null);

  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  const diagnosis = diagnoseFormIssue(beforeForms, afterForms, validationMessages, submitRequests, badResponses, visibleMessages);

  await browser.close();

  return {
    requestedUrl: url,
    finalUrl: page.url(),
    status: response ? response.status() : null,
    title,
    navigationError,
    beforeScreenshotPath,
    afterScreenshotPath,
    formsBeforeSubmit: beforeForms,
    formsAfterSubmit: afterForms,
    fillActions,
    submitResult,
    validationMessages,
    visibleMessages,
    submitRequests,
    consoleMessages,
    pageErrors,
    requestFailures,
    badResponses,
    bodyTextPreview: bodyText.replace(/\s+/g, " ").trim().slice(0, 1200),
    diagnosis,
  };
}

async function inspectForms(page) {
  return page.evaluate(() => {
    const controlsSelector = "input, textarea, select, button";
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return Boolean(
        rect.width &&
          rect.height &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0
      );
    };

    const labelFor = (element) => {
      const id = element.getAttribute("id");
      const aria = element.getAttribute("aria-label");
      const placeholder = element.getAttribute("placeholder");
      const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : "";
      const wrapped = element.closest("label")?.textContent;
      return (explicit || wrapped || aria || placeholder || "").replace(/\s+/g, " ").trim();
    };

    const forms = [...document.querySelectorAll("form")];
    return forms.map((form, formIndex) => ({
      index: formIndex,
      id: form.id || "",
      name: form.getAttribute("name") || "",
      action: form.getAttribute("action") || "",
      method: form.getAttribute("method") || "get",
      visible: isVisible(form),
      fields: [...form.querySelectorAll(controlsSelector)].map((field, fieldIndex) => ({
        index: fieldIndex,
        tag: field.tagName.toLowerCase(),
        type: field.getAttribute("type") || "",
        name: field.getAttribute("name") || "",
        id: field.getAttribute("id") || "",
        label: labelFor(field),
        required: field.required || field.getAttribute("aria-required") === "true",
        disabled: field.disabled,
        readOnly: field.readOnly || false,
        hiddenAttribute: field.hidden || field.getAttribute("type") === "hidden",
        visible: isVisible(field),
        valueLength: "value" in field ? String(field.value || "").length : 0,
        validity: "validity" in field ? {
          valid: field.validity.valid,
          valueMissing: field.validity.valueMissing,
          typeMismatch: field.validity.typeMismatch,
          patternMismatch: field.validity.patternMismatch,
          customError: field.validity.customError,
        } : null,
        validationMessage: "validationMessage" in field ? field.validationMessage : "",
      })),
    }));
  });
}

async function fillVisibleFormFields(page) {
  return page.evaluate(() => {
    const actions = [];
    const controls = [...document.querySelectorAll("form input, form textarea, form select")];
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return Boolean(
        rect.width &&
          rect.height &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0
      );
    };

    for (const field of controls) {
      if (!isVisible(field) || field.disabled || field.readOnly) {
        continue;
      }

      const tag = field.tagName.toLowerCase();
      const type = (field.getAttribute("type") || "").toLowerCase();
      const name = (field.getAttribute("name") || field.getAttribute("id") || "").toLowerCase();
      const label = field.getAttribute("aria-label") || field.getAttribute("placeholder") || name;

      if (["hidden", "file", "password", "submit", "button", "reset"].includes(type)) {
        continue;
      }

      if (tag === "select") {
        const option = [...field.options].find((item) => !item.disabled && item.value);
        if (option) {
          field.value = option.value;
          field.dispatchEvent(new Event("change", { bubbles: true }));
          actions.push({ field: name || label, action: "select", value: option.textContent.trim().slice(0, 80) });
        }
        continue;
      }

      if (type === "checkbox" || type === "radio") {
        field.checked = true;
        field.dispatchEvent(new Event("change", { bubbles: true }));
        actions.push({ field: name || label, action: "check" });
        continue;
      }

      let value = "Test message from automated form check.";
      if (type === "email" || name.includes("email")) value = "test@example.com";
      else if (type === "tel" || name.includes("phone")) value = "5551234567";
      else if (name.includes("name")) value = "Test User";
      else if (name.includes("subject")) value = "Test form submission";
      else if (type === "url") value = "https://example.com";
      else if (type === "number") value = "1";

      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      actions.push({ field: name || label, action: "fill", value });
    }

    return actions;
  });
}

async function submitFirstForm(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return Boolean(
        rect.width &&
          rect.height &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0
      );
    };

    const form = [...document.querySelectorAll("form")].find(isVisible) || document.querySelector("form");
    if (!form) {
      return { ok: false, reason: "No form found." };
    }

    const submitter = [...form.querySelectorAll('button, input[type="submit"], input[type="button"]')]
      .find((item) => isVisible(item) && !item.disabled);

    if (submitter) {
      submitter.click();
      return { ok: true, method: "click", submitterText: (submitter.innerText || submitter.value || "").trim() };
    }

    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return { ok: true, method: "requestSubmit" };
    }

    form.submit();
    return { ok: true, method: "submit" };
  });
}

async function collectValidationMessages(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll("form input, form textarea, form select")]
      .map((field) => ({
        tag: field.tagName.toLowerCase(),
        type: field.getAttribute("type") || "",
        name: field.getAttribute("name") || "",
        id: field.getAttribute("id") || "",
        required: field.required || field.getAttribute("aria-required") === "true",
        valid: "validity" in field ? field.validity.valid : true,
        visible: (() => {
          const style = window.getComputedStyle(field);
          const rect = field.getBoundingClientRect();
          return Boolean(rect.width && rect.height && style.display !== "none" && style.visibility !== "hidden");
        })(),
        message: "validationMessage" in field ? field.validationMessage : "",
      }))
      .filter((item) => item.required || !item.valid || item.message);
  });
}

async function collectVisibleMessages(page) {
  return page.evaluate(() => {
    const selectors = [
      ".error",
      ".errors",
      ".invalid",
      ".validation",
      ".message",
      ".notice",
      "[role='alert']",
      "[aria-live]",
      ".ff-message",
      ".fluentform-response",
      ".wpcf7-response-output",
    ];
    return [...document.querySelectorAll(selectors.join(","))]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width && rect.height && style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => element.textContent.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 20);
  });
}

function diagnoseFormIssue(beforeForms, afterForms, validationMessages, submitRequests, badResponses, visibleMessages) {
  const hiddenRequired = beforeForms.flatMap((form) =>
    form.fields
      .filter((field) => field.required && !field.visible && !field.disabled)
      .map((field) => ({
        formIndex: form.index,
        name: field.name,
        id: field.id,
        type: field.type,
        label: field.label,
      }))
  );
  const invalidFields = validationMessages.filter((field) => !field.valid || field.message);

  if (hiddenRequired.length) {
    return {
      likelyCause: "Required field is hidden from the UI.",
      confidence: "high",
      evidence: hiddenRequired,
    };
  }

  if (invalidFields.length) {
    return {
      likelyCause: "Browser/form validation blocked submit.",
      confidence: "high",
      evidence: invalidFields,
    };
  }

  if (badResponses.length) {
    return {
      likelyCause: "Submit or page request returned an HTTP error.",
      confidence: "medium",
      evidence: badResponses,
    };
  }

  if (!submitRequests.length) {
    return {
      likelyCause: "No submit network request was detected after clicking submit.",
      confidence: "medium",
      evidence: visibleMessages,
    };
  }

  return {
    likelyCause: "No obvious client-side blocker found.",
    confidence: "low",
    evidence: {
      submitRequests,
      visibleMessages,
      formCountBefore: beforeForms.length,
      formCountAfter: afterForms.length,
    },
  };
}

function buildUrl(baseUrl, target) {
  if (!target) {
    return baseUrl;
  }

  if (/^https?:\/\//i.test(target)) {
    return target;
  }

  const relativeTarget = target.replace(/^\/+/, "");
  return new URL(relativeTarget, ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function trim(items) {
  if (items.length > MAX_EVENTS) {
    items.splice(0, items.length - MAX_EVENTS);
  }
}
