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

export async function inspectInteractivePage(config, options = {}) {
  const url = buildUrl(config.localSiteUrl, options.path || options.url || "");
  const instructions = String(options.instructions || "").trim();
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
  const actions = [];
  const targetSteps = extractTargetSteps(instructions);

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
      waitUntil: "domcontentloaded",
      timeout: options.timeout || 45000,
    });
    await page.waitForTimeout(options.initialWait || 3500);
  } catch (error) {
    navigationError = error.message;
  }

  await acceptCookieBanner(page, actions);
  await clickRequestedElement(page, instructions, actions);
  await page.waitForTimeout(1500);

  const beforeScreenshotPath = path.join(screenshotDir, `${Date.now()}-interactive-before.png`);
  await page.screenshot({ path: beforeScreenshotPath, fullPage: true }).catch(() => null);

  const stepInspections = await inspectConversationalFormTargets(page, {
    screenshotDir,
    instructions,
    targetSteps,
    actions,
  });

  const afterScreenshotPath = path.join(screenshotDir, `${Date.now()}-interactive-after.png`);
  await page.screenshot({ path: afterScreenshotPath, fullPage: true }).catch(() => null);

  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  await browser.close();

  return {
    requestedUrl: url,
    finalUrl: page.url(),
    status: response ? response.status() : null,
    title,
    navigationError,
    instructions,
    targetSteps,
    actions,
    stepInspections,
    suggestedCss: buildInteractiveCssSuggestion(stepInspections),
    safetyNote: "Stopped before final submit unless the requested target step required inspection only.",
    beforeScreenshotPath,
    afterScreenshotPath,
    submitRequests,
    consoleMessages,
    pageErrors,
    requestFailures,
    badResponses,
    bodyTextPreview: bodyText.replace(/\s+/g, " ").trim().slice(0, 1200),
  };
}

async function acceptCookieBanner(page, actions) {
  const labels = [/^Accept$/i, /^Accept all$/i, /^Allow all$/i, /^Agree$/i, /^I agree$/i];

  for (const label of labels) {
    const button = page.getByRole("button", { name: label }).first();
    if (await button.isVisible({ timeout: 1500 }).catch(() => false)) {
      await button.click({ timeout: 3000 }).catch(() => null);
      actions.push({ action: "accepted_cookie_banner", label: String(label) });
      await page.waitForTimeout(700);
      return;
    }
  }
}

async function clickRequestedElement(page, instructions, actions) {
  const clickableText = extractClickableText(instructions);
  const candidates = clickableText ? [clickableText] : [];

  if (/waitlist|first to know/i.test(instructions)) {
    candidates.push("Click here", "Join the waitlist", "Waitlist");
  }

  for (const label of uniqueStrings(candidates)) {
    const locator = page.getByRole("link", { name: new RegExp(`^${escapeRegExp(label)}$`, "i") }).first();
    if (await locator.isVisible({ timeout: 2500 }).catch(() => false)) {
      await locator.click({ timeout: 7000 }).catch(() => null);
      actions.push({ action: "clicked_requested_link", label });
      return;
    }

    const button = page.getByRole("button", { name: new RegExp(`^${escapeRegExp(label)}$`, "i") }).first();
    if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
      await button.click({ timeout: 7000 }).catch(() => null);
      actions.push({ action: "clicked_requested_button", label });
      return;
    }
  }
}

async function inspectConversationalFormTargets(page, { screenshotDir, instructions, targetSteps, actions }) {
  const hasConversationalForm = await page.locator(".ffc_conv_form, .ff_conv_app, .ffc_conv_wrapper").count().catch(() => 0);
  if (!hasConversationalForm) {
    return [];
  }

  const inspections = [];
  const targets = targetSteps.length ? targetSteps : [null];
  const maxTransitions = 12;

  for (let index = 0; index < maxTransitions; index += 1) {
    const activeStep = await getActiveConversationalStep(page);
    if (!activeStep) {
      break;
    }

    if (targets.includes(activeStep.number) || (!targetSteps.length && inspections.length === 0)) {
      const inspection = await inspectActiveConversationalStep(page, activeStep, screenshotDir);
      inspections.push(inspection);
      actions.push({ action: "inspected_conversational_step", step: activeStep.number, text: activeStep.text.slice(0, 120) });

      if (targetSteps.length && activeStep.number === targets.at(-1)) {
        break;
      }
    }

    const advanced = await advanceConversationalStep(page, activeStep, actions, instructions);
    if (!advanced) {
      break;
    }

    await page.waitForTimeout(1500);
  }

  return inspections;
}

async function getActiveConversationalStep(page) {
  return page.locator(".q-form").evaluateAll((forms) => {
    const visibleForms = forms.map((form, index) => {
      const rect = form.getBoundingClientRect();
      const style = window.getComputedStyle(form);
      const text = (form.innerText || "").replace(/\s+/g, " ").trim();
      const active = !form.className.includes("q-is-inactive");
      const visible = Boolean(rect.width && rect.height && style.display !== "none" && style.visibility !== "hidden");
      const number = Number(text.match(/^(\d+)/)?.[1] || 0);

      return {
        index,
        className: String(form.className || ""),
        active,
        visible,
        text,
        number,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      };
    });

    return visibleForms.find((form) => form.active) || visibleForms.find((form) => form.visible && form.rect.x > 0) || null;
  });
}

async function advanceConversationalStep(page, activeStep, actions, instructions) {
  const active = page.locator(".q-form:not(.q-is-inactive)").first();
  const activeText = activeStep.text.toLowerCase();
  const shouldAvoidFinalSubmit = /submit/i.test(activeStep.text) && /inspect|css|size|style|layout|reduce/i.test(instructions);

  if (shouldAvoidFinalSubmit) {
    actions.push({ action: "stopped_before_final_submit", step: activeStep.number });
    return false;
  }

  const email = active.locator("input[type='email']").first();
  if (await email.isVisible({ timeout: 1000 }).catch(() => false)) {
    await email.click({ timeout: 5000 });
    await email.fill("");
    await page.keyboard.type(`agent-test-${Date.now()}@example.com`, { delay: 15 });
    actions.push({ action: "typed_email", step: activeStep.number });
    return clickConversationalOk(active, actions, activeStep.number);
  }

  const number = active.locator("input[type='number']").first();
  if (await number.isVisible({ timeout: 1000 }).catch(() => false)) {
    await number.click({ timeout: 5000 });
    await number.fill("");
    await page.keyboard.type("10001", { delay: 15 });
    actions.push({ action: "typed_number", step: activeStep.number, value: "10001" });
    return clickConversationalOk(active, actions, activeStep.number);
  }

  const textInput = active.locator("input:not([type]), input[type='text'], textarea").first();
  if (await textInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await textInput.click({ timeout: 5000 });
    await textInput.fill("");
    await page.keyboard.type("Test response", { delay: 15 });
    actions.push({ action: "typed_text", step: activeStep.number });
    return clickConversationalOk(active, actions, activeStep.number);
  }

  if (activeText.includes("choose as many") || activeText.includes("what type") || activeText.includes("select")) {
    const option = active.locator("li").first();
    if (await option.isVisible({ timeout: 1000 }).catch(() => false)) {
      const label = await option.innerText().catch(() => "");
      await option.click({ timeout: 5000 });
      actions.push({ action: "selected_first_choice", step: activeStep.number, label: label.replace(/\s+/g, " ").trim() });
      return clickConversationalOk(active, actions, activeStep.number);
    }
  }

  return clickConversationalOk(active, actions, activeStep.number);
}

async function clickConversationalOk(activeLocator, actions, stepNumber) {
  const ok = activeLocator.locator(".o-btn-action").first();
  if (await ok.isVisible({ timeout: 1500 }).catch(() => false)) {
    await ok.click({ timeout: 5000 });
    actions.push({ action: "clicked_ok", step: stepNumber });
    return true;
  }

  return false;
}

async function inspectActiveConversationalStep(page, activeStep, screenshotDir) {
  const screenshotPath = path.join(screenshotDir, `${Date.now()}-step-${activeStep.number || "active"}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);

  const details = await page.locator(".q-form:not(.q-is-inactive)").first().evaluate((form) => {
    const rectFor = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
      };
    };
    const styleFor = (element) => {
      const style = window.getComputedStyle(element);
      return {
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        padding: style.padding,
        margin: style.margin,
        display: style.display,
        overflow: style.overflow,
      };
    };
    const summarize = (selector) => [...form.querySelectorAll(selector)].map((element) => ({
      tag: element.tagName.toLowerCase(),
      className: String(element.className || ""),
      text: (element.innerText || element.textContent || element.value || "").replace(/\s+/g, " ").trim().slice(0, 120),
      rect: rectFor(element),
      style: styleFor(element),
    }));
    const app = form.closest(".ff_conv_app, .frm-fluent-form, .ffc_conv_wrapper");
    const wrapper = form.closest(".ffc_conv_form, .ff_conv_app, .ffc_conv_wrapper");
    const rootClasses = [app?.className || "", wrapper?.className || ""].join(" ");
    const formClass = rootClasses.match(/fluent_form_\d+/)?.[0] || rootClasses.match(/ff_conv_app_\d+/)?.[0] || "";
    const formRect = rectFor(form);

    return {
      plugin: rootClasses.includes("fluent_form") || rootClasses.includes("ff_conv") ? "Fluent Forms conversational form" : "Unknown conversational form",
      formClass,
      activeClassName: String(form.className || ""),
      text: (form.innerText || "").replace(/\s+/g, " ").trim(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      formRect,
      overflowsViewport: formRect.y < 0 || formRect.bottom > window.innerHeight,
      elements: {
        containers: summarize(".ff_conv_input, .ffc_question, .f-answer"),
        questionText: summarize(".f-text"),
        choices: summarize(".f-radios li, .f-label").slice(0, 60),
        inputs: summarize("input, textarea, select").slice(0, 20),
      },
    };
  });

  return {
    step: activeStep.number,
    screenshotPath,
    ...details,
  };
}

function buildInteractiveCssSuggestion(stepInspections) {
  const first = stepInspections.find((step) => step.formClass) || stepInspections[0];
  const formSelector = first?.formClass ? `.${first.formClass}` : ".fluent_form_4";
  const hasMultiChoice = stepInspections.some((step) => step.activeClassName?.includes("field-multiplechoice"));

  if (!hasMultiChoice) {
    return "";
  }

  return [
    "/* Compact Fluent Forms conversational multi-choice steps */",
    `${formSelector} .field-multiplechoice .ff_conv_input.q-inner {`,
    "  padding-top: 28px !important;",
    "  padding-left: 14px !important;",
    "}",
    "",
    `${formSelector} .field-multiplechoice .f-text {`,
    "  font-size: 18px !important;",
    "  line-height: 1.25 !important;",
    "}",
    "",
    `${formSelector} .field-multiplechoice .f-answer {`,
    "  margin-top: 14px !important;",
    "}",
    "",
    `${formSelector} .field-multiplechoice .f-radios li {`,
    "  min-height: auto !important;",
    "  padding: 6px 10px !important;",
    "  margin: 4px 0 !important;",
    "  line-height: 1.2 !important;",
    "}",
    "",
    `${formSelector} .field-multiplechoice .f-label {`,
    "  font-size: 14px !important;",
    "  line-height: 1.25 !important;",
    "}",
    "",
    `${formSelector} .field-multiplechoice .ffc_question {`,
    "  height: auto !important;",
    "}",
    "",
    "@media (max-width: 767px) {",
    `  ${formSelector} .field-multiplechoice .f-text {`,
    "    font-size: 16px !important;",
    "  }",
    "",
    `  ${formSelector} .field-multiplechoice .f-label {`,
    "    font-size: 13px !important;",
    "  }",
    "",
    `  ${formSelector} .field-multiplechoice .f-radios li {`,
    "    padding: 5px 8px !important;",
    "    margin: 3px 0 !important;",
    "  }",
    "}",
  ].join("\n");
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

function extractTargetSteps(instructions) {
  const text = String(instructions || "").toLowerCase();
  const steps = new Set();

  for (const match of text.matchAll(/\bsteps?\s*(\d+)(?:\s*(?:&|and|,|-)\s*(\d+))?/g)) {
    steps.add(Number(match[1]));
    if (match[2]) {
      steps.add(Number(match[2]));
    }
  }

  for (const match of text.matchAll(/\b(?:page|screen)\s*(\d+)\b/g)) {
    steps.add(Number(match[1]));
  }

  return [...steps].filter(Boolean).sort((a, b) => a - b);
}

function extractClickableText(instructions) {
  const text = String(instructions || "");
  const patterns = [
    /click\s+(?:the\s+)?["“']([^"”']+)["”']/i,
    /click\s+(?:the\s+)?([A-Za-z0-9 _-]{2,40})\s+(?:button|link)/i,
    /->\s*([A-Za-z0-9 _-]{2,40})\s+button/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function uniqueStrings(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
