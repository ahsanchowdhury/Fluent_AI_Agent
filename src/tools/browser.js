import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { emitActivity } from "../activity.js";

const MAX_EVENTS = 80;

export async function debugPage(config, options = {}) {
  const url = buildUrl(config.localSiteUrl, options.path || options.url || "");
  const activity = options.activity || null;
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
    emitActivity(activity, "browser", `Visiting ${url}`);
    response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: options.timeout || 20000,
    });
  } catch (error) {
    navigationError = error.message;
  }

  const title = await page.title().catch(() => "");
  emitActivity(activity, "browser", `Page loaded: ${title || page.url()}`);
  const finalUrl = page.url();
  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  const screenshotPath = path.join(screenshotDir, `${Date.now()}-page.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
  emitActivity(activity, "screenshot", "Captured page screenshot");
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
  const activity = options.activity || null;
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
    emitActivity(activity, "browser", `Visiting ${url}`);
    response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: options.timeout || 25000,
    });
  } catch (error) {
    navigationError = error.message;
  }

  const beforeScreenshotPath = path.join(screenshotDir, `${Date.now()}-form-before.png`);
  await page.screenshot({ path: beforeScreenshotPath, fullPage: true }).catch(() => null);
  emitActivity(activity, "screenshot", "Captured form before screenshot");

  const beforeForms = await inspectForms(page);
  emitActivity(activity, "form", `Found ${beforeForms.length} form${beforeForms.length === 1 ? "" : "s"} before submit`);
  const fillActions = await fillVisibleFormFields(page);
  for (const action of fillActions.slice(0, 8)) {
    emitActivity(activity, "form", describeFillAction(action));
  }
  const submitResult = await submitFirstForm(page);
  emitActivity(activity, "form", submitResult.submitted ? "Submitted the first visible form" : "Could not submit the first visible form");
  await page.waitForTimeout(options.afterSubmitWait || 1800);
  const afterForms = await inspectForms(page);
  const validationMessages = await collectValidationMessages(page);
  const visibleMessages = await collectVisibleMessages(page);
  const afterScreenshotPath = path.join(screenshotDir, `${Date.now()}-form-after.png`);
  await page.screenshot({ path: afterScreenshotPath, fullPage: true }).catch(() => null);
  emitActivity(activity, "screenshot", "Captured form after screenshot");

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
  const activity = options.activity || null;
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
    emitActivity(activity, "browser", `Visiting ${url}`);
    response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeout || 45000,
    });
    await page.waitForTimeout(options.initialWait || 3500);
  } catch (error) {
    navigationError = error.message;
  }

  await acceptCookieBanner(page, actions, activity);
  await clickRequestedElement(page, instructions, actions, activity);
  await page.waitForTimeout(1500);

  const beforeScreenshotPath = path.join(screenshotDir, `${Date.now()}-interactive-before.png`);
  await page.screenshot({ path: beforeScreenshotPath, fullPage: true }).catch(() => null);
  emitActivity(activity, "screenshot", "Captured initial interaction screenshot");

  const stepInspections = await inspectConversationalFormTargets(page, {
    screenshotDir,
    instructions,
    targetSteps,
    actions,
    activity,
  });
  const behaviorTests = shouldRunInteractionBehaviorTests(instructions)
    ? await runConversationalBehaviorTests(url, {
        screenshotDir,
        instructions,
        targetSteps,
        width: options.width || 1440,
        height: options.height || 1000,
        activity,
      })
    : [];

  const afterScreenshotPath = path.join(screenshotDir, `${Date.now()}-interactive-after.png`);
  await page.screenshot({ path: afterScreenshotPath, fullPage: true }).catch(() => null);
  emitActivity(activity, "screenshot", "Captured final interaction screenshot");

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
    behaviorTests,
    behaviorDiagnosis: diagnoseBehaviorTests(behaviorTests),
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

async function acceptCookieBanner(page, actions, activity = null) {
  const labels = [/^Accept$/i, /^Accept all$/i, /^Allow all$/i, /^Agree$/i, /^I agree$/i];

  for (const label of labels) {
    const button = page.getByRole("button", { name: label }).first();
    if (await button.isVisible({ timeout: 1500 }).catch(() => false)) {
      await button.click({ timeout: 3000 }).catch(() => null);
      actions.push({ action: "accepted_cookie_banner", label: String(label) });
      emitActivity(activity, "browser", "Accepted cookie banner");
      await page.waitForTimeout(700);
      return;
    }
  }
}

async function clickRequestedElement(page, instructions, actions, activity = null) {
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
      emitActivity(activity, "browser", `Clicked link: ${label}`);
      return;
    }

    const button = page.getByRole("button", { name: new RegExp(`^${escapeRegExp(label)}$`, "i") }).first();
    if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
      await button.click({ timeout: 7000 }).catch(() => null);
      actions.push({ action: "clicked_requested_button", label });
      emitActivity(activity, "browser", `Clicked button: ${label}`);
      return;
    }
  }
}

async function inspectConversationalFormTargets(page, { screenshotDir, instructions, targetSteps, actions, activity = null }) {
  const hasConversationalForm = await page.locator(".ffc_conv_form, .ff_conv_app, .ffc_conv_wrapper").count().catch(() => 0);
  if (!hasConversationalForm) {
    emitActivity(activity, "form", "No conversational form detected");
    return [];
  }

  emitActivity(activity, "form", "Detected conversational form");
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
      emitActivity(activity, "form", `Inspected step ${activeStep.number}`);

      if (targetSteps.length && activeStep.number === targets.at(-1)) {
        break;
      }
    }

    const advanced = await advanceConversationalStep(page, activeStep, actions, instructions, activity);
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

async function advanceConversationalStep(page, activeStep, actions, instructions, activity = null) {
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
    emitActivity(activity, "form", `Filled email on step ${activeStep.number}`);
    return clickConversationalOk(active, actions, activeStep.number, activity);
  }

  const number = active.locator("input[type='number']").first();
  if (await number.isVisible({ timeout: 1000 }).catch(() => false)) {
    await number.click({ timeout: 5000 });
    await number.fill("");
    await page.keyboard.type("10001", { delay: 15 });
    actions.push({ action: "typed_number", step: activeStep.number, value: "10001" });
    emitActivity(activity, "form", `Filled number field on step ${activeStep.number}`);
    return clickConversationalOk(active, actions, activeStep.number, activity);
  }

  const textInput = active.locator("input:not([type]), input[type='text'], textarea").first();
  if (await textInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await textInput.click({ timeout: 5000 });
    await textInput.fill("");
    await page.keyboard.type("Test response", { delay: 15 });
    actions.push({ action: "typed_text", step: activeStep.number });
    emitActivity(activity, "form", `Filled text field on step ${activeStep.number}`);
    return clickConversationalOk(active, actions, activeStep.number, activity);
  }

  if (activeText.includes("choose as many") || activeText.includes("what type") || activeText.includes("select")) {
    const option = active.locator("li").first();
    if (await option.isVisible({ timeout: 1000 }).catch(() => false)) {
      const label = await option.innerText().catch(() => "");
      await option.click({ timeout: 5000 });
      actions.push({ action: "selected_first_choice", step: activeStep.number, label: label.replace(/\s+/g, " ").trim() });
      emitActivity(activity, "form", `Selected first choice on step ${activeStep.number}`);
      return clickConversationalOk(active, actions, activeStep.number, activity);
    }
  }

  return clickConversationalOk(active, actions, activeStep.number, activity);
}

async function clickConversationalOk(activeLocator, actions, stepNumber, activity = null) {
  const ok = activeLocator.locator(".o-btn-action").first();
  if (await ok.isVisible({ timeout: 1500 }).catch(() => false)) {
    await ok.click({ timeout: 5000 });
    actions.push({ action: "clicked_ok", step: stepNumber });
    emitActivity(activity, "form", `Clicked action button on step ${stepNumber}`);
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

function shouldRunInteractionBehaviorTests(instructions) {
  return /\b(enter|keyboard|keypress|key press|close|closes|closed|not\s+advance|not\s+going|instead|button|next|skip|popup|modal|step)\b/i.test(
    String(instructions || "")
  );
}

async function runConversationalBehaviorTests(url, options = {}) {
  const targetStep = options.targetSteps?.[0] || extractTargetSteps(options.instructions)[0] || 3;
  const activity = options.activity || null;
  const cases = [
    {
      name: "keyboard_enter_without_selection",
      label: "Press keyboard Enter on the target step without selecting an option",
      run: async (page, active) => {
        await page.keyboard.press("Enter");
      },
    },
    {
      name: "click_action_button_without_selection",
      label: "Click the visible action button on the target step without selecting an option",
      run: async (_page, active) => {
        await active.locator(".o-btn-action").click({ timeout: 5000 });
      },
    },
    {
      name: "click_enter_helper_without_selection",
      label: "Click the visible Press Enter helper on the target step without selecting an option",
      run: async (_page, active) => {
        await active.locator(".f-enter-desc").click({ timeout: 5000 });
      },
    },
    {
      name: "select_first_option_then_keyboard_enter",
      label: "Select the first option on the target step, then press keyboard Enter",
      run: async (page, active) => {
        await active.locator("li").first().click({ timeout: 5000 });
        await page.waitForTimeout(500);
        await page.keyboard.press("Enter");
      },
    },
  ];
  const results = [];

  for (const testCase of cases) {
    emitActivity(activity, "test", `Testing: ${testCase.label}`);
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
    const actions = [];

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

    try {
      await prepareConversationalFormAtStep(page, url, {
        instructions: options.instructions,
        targetStep,
        actions,
        activity,
      });
      const modalBefore = await getVisibleModalState(page);
      const activeBefore = await getActiveConversationalStep(page);
      const beforeScreenshotPath = path.join(options.screenshotDir, `${Date.now()}-${testCase.name}-before.png`);
      await page.screenshot({ path: beforeScreenshotPath, fullPage: true }).catch(() => null);

      if (!activeBefore || activeBefore.number !== targetStep) {
        results.push({
          name: testCase.name,
          label: testCase.label,
          targetStep,
          ok: false,
          reason: `Could not reach target step ${targetStep}.`,
          setupActions: actions,
          modalBefore,
          activeBefore,
          beforeScreenshotPath,
          consoleMessages,
          pageErrors,
          requestFailures,
          badResponses,
        });
        await browser.close();
        continue;
      }

      const active = page.locator(".q-form:not(.q-is-inactive)").first();
      await testCase.run(page, active);
      await page.waitForTimeout(2000);

      const modalAfter = await getVisibleModalState(page);
      const activeAfter = await getActiveConversationalStep(page);
      const afterScreenshotPath = path.join(options.screenshotDir, `${Date.now()}-${testCase.name}-after.png`);
      await page.screenshot({ path: afterScreenshotPath, fullPage: true }).catch(() => null);

      results.push({
        name: testCase.name,
        label: testCase.label,
        targetStep,
        ok: true,
        outcome: classifyBehaviorOutcome({ modalBefore, modalAfter, activeBefore, activeAfter }),
        setupActions: actions,
        modalBefore,
        activeBefore,
        modalAfter,
        activeAfter,
        beforeScreenshotPath,
        afterScreenshotPath,
        consoleMessages,
        pageErrors,
        requestFailures,
        badResponses,
      });
      emitActivity(activity, "test", `Result: ${testCase.name} ${results.at(-1).outcome?.type || "checked"}`);
    } catch (error) {
      results.push({
        name: testCase.name,
        label: testCase.label,
        targetStep,
        ok: false,
        reason: error.message,
        setupActions: actions,
        consoleMessages,
        pageErrors,
        requestFailures,
        badResponses,
      });
      emitActivity(activity, "error", `Behavior test failed: ${testCase.name}`);
    } finally {
      await browser.close().catch(() => null);
    }
  }

  return results;
}

async function prepareConversationalFormAtStep(page, url, { instructions, targetStep, actions, activity = null }) {
  emitActivity(activity, "browser", `Preparing page at ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(3000);
  await acceptCookieBanner(page, actions, activity);
  await clickRequestedElement(page, instructions, actions, activity);
  await page.waitForTimeout(1500);

  for (let guard = 0; guard < 12; guard += 1) {
    const activeStep = await getActiveConversationalStep(page);
    if (!activeStep) {
      throw new Error("No active conversational form step found.");
    }
    if (activeStep.number >= targetStep) {
      return activeStep;
    }
    const advanced = await advanceConversationalStep(page, activeStep, actions, `${instructions}\nReach step ${targetStep} for behavior testing.`, activity);
    if (!advanced) {
      throw new Error(`Could not advance past step ${activeStep.number}.`);
    }
    await page.waitForTimeout(1200);
  }

  throw new Error(`Could not reach step ${targetStep} within the transition limit.`);
}

async function getVisibleModalState(page) {
  return page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll("[role='dialog'], .elementor-popup-modal, .dialog-widget, .modal, [class*='popup'], [class*='modal']"),
    ];
    const visible = candidates
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || "",
          className: String(element.className || ""),
          text: (element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200),
          visible: Boolean(rect.width && rect.height && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0),
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      })
      .filter((item) => item.visible);

    return {
      visible: visible.length > 0,
      count: visible.length,
      items: visible.slice(0, 8),
    };
  });
}

function classifyBehaviorOutcome({ modalBefore, modalAfter, activeBefore, activeAfter }) {
  if (modalBefore?.visible && !modalAfter?.visible) {
    return {
      type: "modal_closed",
      severity: "bug",
      summary: "The modal/popup closed after this interaction.",
    };
  }

  if (activeBefore?.number && activeAfter?.number && activeAfter.number > activeBefore.number) {
    return {
      type: "advanced",
      severity: "ok",
      summary: `The form advanced from step ${activeBefore.number} to step ${activeAfter.number}.`,
    };
  }

  if (activeBefore?.number && activeAfter?.number === activeBefore.number) {
    return {
      type: "stayed",
      severity: "warning",
      summary: `The form stayed on step ${activeBefore.number}.`,
    };
  }

  return {
    type: "unknown",
    severity: "warning",
    summary: "The outcome could not be classified from the active step/modal state.",
  };
}

function diagnoseBehaviorTests(behaviorTests) {
  if (!behaviorTests.length) {
    return null;
  }

  const modalClosed = behaviorTests.filter((test) => test.outcome?.type === "modal_closed");
  const advanced = behaviorTests.filter((test) => test.outcome?.type === "advanced");

  if (modalClosed.length) {
    return {
      likelyCause:
        "At least one interaction caused the modal/popup to close instead of advancing. This usually means the keyboard/click event is escaping the form step and being handled by the popup/lightbox layer.",
      confidence: "high",
      failingInteractions: modalClosed.map((test) => ({
        name: test.name,
        label: test.label,
        targetStep: test.targetStep,
        beforeStep: test.activeBefore?.number || null,
        afterStep: test.activeAfter?.number || null,
      })),
      workingInteractions: advanced.map((test) => ({
        name: test.name,
        label: test.label,
        targetStep: test.targetStep,
        beforeStep: test.activeBefore?.number || null,
        afterStep: test.activeAfter?.number || null,
      })),
      suggestedFix:
        "Intercept Enter keydown events inside the active conversational form step, handle the intended form navigation there, and stop propagation so the popup/lightbox does not receive the event.",
    };
  }

  return {
    likelyCause: "No modal-closing interaction was reproduced in the tested behavior paths.",
    confidence: "medium",
    workingInteractions: advanced.map((test) => ({
      name: test.name,
      label: test.label,
      targetStep: test.targetStep,
      beforeStep: test.activeBefore?.number || null,
      afterStep: test.activeAfter?.number || null,
    })),
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

function describeFillAction(action) {
  const field = action.field ? ` ${action.field}` : "";
  if (action.action === "fill") return `Filled${field}`;
  if (action.action === "select") return `Selected option for${field}`;
  if (action.action === "check") return `Checked${field}`;
  return `Updated form field${field}`;
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
  const cleanTarget = extractBrowserTarget(target);

  if (!cleanTarget) {
    return baseUrl;
  }

  if (/^https?:\/\//i.test(cleanTarget)) {
    return cleanTarget;
  }

  const relativeTarget = cleanTarget.replace(/^\/+/, "");
  return new URL(relativeTarget, ensureTrailingSlash(baseUrl)).toString();
}

function extractBrowserTarget(target) {
  const value = String(target || "").trim();
  const urlMatch = value.match(/https?:\/\/[^\s<>"')\]]+/i);

  if (urlMatch?.[0]) {
    return urlMatch[0].replace(/[.,;:!?]+$/, "");
  }

  return value.split(/\s+/)[0] || "";
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function trim(items) {
  if (items.length > MAX_EVENTS) {
    items.splice(0, items.length - MAX_EVENTS);
  }
}
