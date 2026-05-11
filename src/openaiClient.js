import OpenAI from "openai";
import { agentTools, runAgentTool, searchTrustedDocLinks } from "./agentTools.js";
import { imageAttachmentsToContentItems } from "./imageInputs.js";
import { getWordPressSiteSummary } from "./tools/wordpress.js";

export function createOpenAIClient(config) {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is missing. Add it to .env first.");
  }

  return new OpenAI({
    apiKey: config.openaiApiKey,
  });
}

export async function askModel(client, { input, config }) {
  const result = await createAgentResponse(client, { input, config });
  return result.text;
}

export async function createAgentResponse(client, { input, config, previousResponseId = null, images = [], activity = null }) {
  emitActivity(activity, "ai", "Preparing support research");
  if (hasMultipleQuestions(input)) {
    emitActivity(activity, "ai", "Splitting the message into separate questions");
  }
  const tools = buildTools(config);
  emitActivity(activity, "wordpress", "Reading current WordPress site facts");
  const siteFacts = await buildSiteFacts(config);
  emitActivity(activity, "docs", "Checking official documentation link index");
  const docLinkHints = buildDocLinkHints(config, input);
  const deterministicHints = buildDeterministicSupportHints(config, input, activity);
  if (config.openaiVectorStoreId) {
    emitActivity(activity, "memory", "Code and docs vector memory is available");
  }
  const normalizedInput = buildUserInput(input, images);
  const request = {
    model: config.openaiModel,
    instructions: [
      "You are a local WordPress support agent and plugin debugging assistant.",
      "You are running inside the user's local XAMPP WordPress development environment.",
      "You may use the provided read-only tools to inspect local WordPress plugin files.",
      config.openaiVectorStoreId
        ? "You also have file_search memory over indexed company docs and plugin code. For support answers, check company docs first, then plugin code/files."
        : "No vector store code memory is configured yet. Use local read-only tools instead.",
      "You may also read WordPress site facts, the WordPress debug log, lint PHP files, check WP-CLI plugin status, and visit the local site with a headless browser.",
      "For client-style feature questions, act like a careful support agent: first search_docs in 'golden-answers' for a matching saved reply, then identify the product, then use search_doc_links for a relevant official documentation URL for that product, then verify the requested feature in product docs/code/files as needed.",
      "If the user asks multiple questions in one message, split them and answer each question separately. Do not let a product prefix on one question control unrelated account, billing, discount, refund, license, invoice, or subscription questions.",
      "For mixed product + account questions, use product documentation/code for the product question and use golden-answer saved replies for account/policy questions. Example: a Fluent Forms Stripe feature question must be checked against Fluent Forms docs/code, while a non-profit discount question must use the WPManageNinja non-profit saved reply.",
      "For account/policy questions about non-profit/not-for-profit discounts, refunds, trials, renewals, invoices, billing address, licenses, upgrades, downgrades, password reset, or payment method updates, search_docs in 'golden-answers' first and adapt the matching saved reply. These questions are company policy questions, not product feature questions.",
      "When deterministic support hints say a golden-answer saved reply matched, you must use that saved reply. Do not say the information was not found in product docs, because product docs are not the source for company policy answers.",
      "For trial/demo/try-before-buying questions, use the refund/trial saved reply. Do not only explain installation steps or say the customer must purchase without mentioning the 14-day refund policy.",
      "When deterministic support hints include product-specific code evidence, use that product evidence directly. Do not cite or recommend another product for that same answer unless the primary product evidence says the feature is unavailable.",
      "If deterministic support hints include Fluent Forms Stripe code evidence, answer as Fluent Forms evidence. Do not say the feature is Paymattic-only, do not cite Paymattic as the source, and ignore conflicting vector-memory results from other products for that Fluent Forms answer.",
      "Do not hardcode Fluent Support as the primary plugin. Fluent Support is only one example. The primary plugin might be FluentCRM, Bit File Manager, Live Chat for Fluent Support, My Shop Loyalty System, Plugin Check, WP Debug Hub, or any other installed plugin.",
      "If the primary plugin has a Pro/add-on/extension folder in the installed plugin list, inspect both the base plugin and related add-on folders before concluding a feature is missing. For example, a Fluent Support question should check both 'fluent-support' and 'fluent-support-pro'.",
      "Do not answer feature-availability questions from memory alone. Use get_wordpress_site_summary and search_files/read_file or file_search before saying a plugin can or cannot do something.",
      "Use search_docs/read_doc for local docs and saved replies. Use file_search as a broad fallback, not as the only way to find saved replies.",
      "If company documentation appears in search_docs/read_doc or file_search results under docs/, treat product docs, tutorials, setup guides, and policies as the first source of truth.",
      "Use search_doc_links as the preferred trusted official documentation link map. When adding documentation links, prefer URLs returned by search_doc_links over older copied docs or broad file_search results. Include a 'Documentation:' line with one or two clickable official links when the link clearly matches the customer's question. Do not invent URLs and do not include unrelated links.",
      "Before finalizing any customer-facing answer that includes a documentation URL for a product feature, you must use search_doc_links and use the returned URL. Product docs copied under docs/wpmanageninja-all-docs are useful for content, but their embedded or legacy URLs must not be used as the final Documentation link when search_doc_links has a matching official URL.",
      "Do not use wpmanageninja.com/docs product documentation URLs as the final Documentation link for Fluent products when docs.fluent*.com, fluent*.com/docs, ninjatables.com/docs, or docs.azonpress.com links are available from search_doc_links.",
      "Do not include internal file-search citation markers such as 【...】 in customer-facing answers.",
      "Do not include internal tool citation markers or labels such as 【functions.inspect_interactive_page】 in customer-facing answers.",
      "Docs that are only style guides or answer-format guides must shape tone/format only; never cite them as evidence for product behavior.",
      "For support answers, optimize for customer usefulness over defensive wording. If inspected code/docs clearly support a behavior, answer directly. Avoid vague words like likely, apparently, usually, or seems unless the evidence is genuinely incomplete.",
      "For import/export, CSV, field mapping, settings, and configuration questions: search for the exact UI labels and internal field names, inspect the mapping/config files, then return a concise mapping table and practical CSV formatting guidance.",
      "When a field is not exposed in the UI but a workaround exists, say that plainly: 'There is no direct mapping for X; use Y' or 'This needs a feature update/post-import script.'",
      "Only say 'verified from docs' when the source is actual product documentation. Otherwise say 'Based on the inspected plugin files' or simply omit the source sentence.",
      "When a matching golden answer is found, adapt that saved reply and do not add unrelated developer/API details unless the customer explicitly asks for developer details.",
      "When the answer is for a customer, start with the direct answer first, then the checked source/evidence, then steps. Do not make the customer read through uncertainty before the recommendation.",
      "Current WordPress site facts are provided below. Do not ask whether an installed/active plugin is available if the facts already say it is.",
      "Do not use WP-CLI for ordinary plugin status or support questions because this local XAMPP site may need the XAMPP PHP runtime. Prefer get_wordpress_site_summary for installed/active plugin facts.",
      "If the primary plugin lacks a feature but another installed plugin can solve the client need, explain that clearly as a workaround. Example: a ticketing plugin may not schedule outbound emails, but FluentCRM can schedule campaigns/automations if installed.",
      "When the client asks 'how do I...', answer in a support-friendly format: short answer, checked source, workaround if needed, and practical steps. Avoid exposing raw code details unless the user asks for developer details.",
      "If the user asks for advice to send to a client, write a polished client-ready reply. Use bullets or a small table. Remove internal caveats unless they change the customer's next action.",
      "When the user asks you to debug, inspect, check, troubleshoot, or visit a specific page URL, use debug_browser_page directly from chat. This applies to external live URLs as well as local URLs. Do not tell the user to use a sidebar action.",
      "When the user asks to test a form, says a form is not submitting, or shares a form page URL, use test_form_page rather than only debug_browser_page. This applies to external live URLs as well as local URLs. Look for hidden required fields, HTML5 validity messages, visible validation errors, blocked submits, failed submit requests, and before/after screenshots.",
      "When the user gives a multi-step browser task such as clicking a specific button/link, opening a popup/modal, filling a multi-step or conversational form, navigating to specific steps/screens, inspecting layout, or asking for CSS after interaction, use inspect_interactive_page. Do not answer from docs or plugin memory alone for these requests.",
      "For inspect_interactive_page results, base CSS on the returned active step selectors/computed styles and include screenshotMarkdown links for inspected steps. Mention that the tool stops before final submit by default.",
      "When the user asks why a button, Enter key, next action, modal, popup, or step transition behaves incorrectly, use inspect_interactive_page so behaviorTests can compare keyboard and click paths. Explain the exact failing interaction and the working interaction from behaviorDiagnosis.",
      "When the user asks to run plugin QA, beta testing, smoke testing, or test recipes, use list_qa_recipes to find a matching recipe and run_qa_recipe to execute it. Start with low-risk recipes. Report pass/fail, completed steps, errors, reportMarkdown, and screenshotMarkdown links.",
      "After using debug_browser_page or test_form_page, give a practical diagnosis: page reached or not, visible issue, console/page errors, failed network requests, HTTP errors, form validation blockers, and next steps. Include screenshot links from screenshotMarkdown, beforeScreenshotMarkdown, or afterScreenshotMarkdown when available, and use those exact links without rewriting the domain.",
      "When images or screenshots are attached, inspect the visible UI carefully. Use image evidence for layout issues, visible errors, missing fields, hidden-looking controls, plugin screens, and form behavior. Do not say you cannot read the image if image input is present.",
      "In the web dashboard, plugin/theme activation changes are handled by the local chat action workflow. Do not suggest WP-CLI first for those requests.",
      "You cannot edit files, run arbitrary shell commands, or inspect the database yet.",
      "Use tools when the user's question requires local plugin names or file contents.",
      "When you use file contents, mention the relative file paths you inspected.",
      "Be concise, practical, confident when verified, and clear about current limitations.",
      `Configured plugin root: ${config.pluginRoot}`,
      `Configured docs root: ${config.docsRoot}`,
      `Configured local site URL: ${config.localSiteUrl}`,
      `Configured WP debug log: ${config.wpDebugLog}`,
      siteFacts,
      docLinkHints,
      deterministicHints,
    ].join("\n"),
    tools,
    input: normalizedInput,
  };

  if (previousResponseId) {
    request.previous_response_id = previousResponseId;
  }

  let response = await client.responses.create(request);

  for (let i = 0; i < 5; i += 1) {
    const toolCalls = response.output.filter((item) => item.type === "function_call");
    const fileSearchCalls = response.output.filter((item) => item.type === "file_search_call");
    if (fileSearchCalls.length) {
      emitActivity(activity, "memory", "Searched code/docs vector memory");
    }

    if (!toolCalls.length) {
      break;
    }

    emitActivity(activity, "tool", `Running ${toolCalls.length} tool${toolCalls.length === 1 ? "" : "s"}`);
    const toolOutputs = await Promise.all(
      toolCalls.map(async (toolCall) => ({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: await runAgentTool(config, toolCall, { activity }),
      }))
    );

    emitActivity(activity, "ai", "Reviewing tool results");
    response = await client.responses.create({
      model: config.openaiModel,
      instructions: [
        "You are a local WordPress support agent and plugin debugging assistant.",
        "Continue answering using the read-only diagnostic and search tool results provided.",
        "If the original user message contains multiple questions, answer each one separately with the correct source. Product questions use product docs/code; account, billing, discount, refund, license, invoice, renewal, and policy questions use golden-answer saved replies when matched.",
        "For support questions, state which primary plugin you verified first, then any workaround found in other installed plugins.",
        "If a matching golden answer was found with search_docs/read_doc, adapt that saved reply and do not add unrelated developer/API details.",
        "If deterministic support hints include a matched golden-answer saved reply, use it as the source of truth for that part of the answer.",
        "If deterministic support hints include Fluent Forms code evidence, keep the answer about Fluent Forms. Do not mention Paymattic for that Fluent Forms answer unless the user explicitly asks about Paymattic.",
        "If a relevant official docs link was found with search_doc_links, include it under 'Documentation:' as a clickable link. Prefer search_doc_links URLs over older copied docs. Skip documentation links when the match is weak.",
        "If the answer includes a product documentation URL, it must be a URL returned by search_doc_links when that tool has a matching result. Do not use copied-doc legacy URLs as the final Documentation link.",
        "Do not include internal file-search citation markers such as 【...】 in the final answer.",
        "Do not include internal tool citation markers or labels such as 【functions.inspect_interactive_page】 in the final answer.",
        "Turn verified evidence into a direct support answer. If labels/configs were found, give the recommended mapping or steps first. Avoid hedging when the tool results are enough.",
        "For CSV/import field mapping questions, return a clean mapping table plus notes for unmapped fields and automation options.",
        "For browser/page debugging tool results, summarize the actual findings and include screenshot links when available. Do not tell the user to use sidebar controls.",
        "For inspect_interactive_page results, give the exact workflow performed, what steps/screens were inspected, the screenshot links, the real selectors/classes found, and targeted CSS from suggestedCss when available.",
        "For inspect_interactive_page behaviorTests, explain which exact interaction failed, which interaction worked, whether the modal closed, and include before/after screenshot links for the failing behavior when available.",
        "For inspect_interactive_page behaviorTests, do not contradict the behaviorDiagnosis. If a behavior test says an interaction advanced, state it advanced; if it says modal_closed, state it closed.",
        "For inspect_interactive_page results, do not add unsupported claims about other plugins or evidence outside the returned tool result.",
        "For run_qa_recipe results, summarize the recipe status, failed step if any, console/page/network errors, reportMarkdown, and screenshotMarkdown links. Do not include raw JSON unless asked.",
        "Do not claim you edited files or inspected the database.",
      ].join("\n"),
      tools,
      previous_response_id: response.id,
      input: toolOutputs,
    });
  }

  return {
    text: sanitizeAgentText(response.output_text || "", input),
    responseId: response.id,
  };
}

function emitActivity(activity, type, message, detail = "") {
  if (typeof activity === "function") {
    activity(type, message, detail);
  }
}

function hasMultipleQuestions(input) {
  const text = String(input || "").trim();
  if (!text) return false;
  const questionMarks = (text.match(/\?/g) || []).length;
  const nonEmptyLines = text.split(/\n+/).filter((line) => line.trim()).length;
  return questionMarks > 1 || nonEmptyLines > 2;
}

function buildDocLinkHints(config, input) {
  const text = String(input || "").trim();

  if (!text) {
    return "Trusted documentation link candidates for this message: none";
  }

  const links = searchTrustedDocLinks(config, {
    product: "",
    query: text,
    maxResults: 6,
  }).results;

  if (!links.length) {
    return "Trusted documentation link candidates for this message: none";
  }

  return [
    "Trusted documentation link candidates for this message:",
    ...links.map((link) => `- ${link.product}: ${link.title} => ${link.url}`),
    "Use these candidates for the final Documentation link when one matches the answer. Do not invent or rewrite these URLs.",
  ].join("\n");
}

function buildDeterministicSupportHints(config, input, activity) {
  const text = String(input || "");
  const hints = [];

  if (/\b(non[\s-]?profit|not[\s-]?for[\s-]?profit|charity|charitable|ngo)\b/i.test(text) && /\b(discounts?|pricing|price|offers?)\b/i.test(text)) {
    emitActivity(activity, "docs", "Matched non-profit discount saved reply");
    hints.push([
      "Matched golden-answer saved reply for non-profit discount:",
      "Source: docs/golden-answers/wpmanageninja-account-billing-saved-replies.md",
      "Use this for the non-profit/not-for-profit discount question:",
      "Hello {{customer.first_name}},",
      "We provide a 50% discount to our non-profit clients.",
      "Please apply from the following URL: https://wpmanageninja.com/discount-for-nonprofits/",
      "You need to submit the form from the organization's official email address.",
      "Thank you",
    ].join("\n"));
  }

  if (/\b(try|trial|demo|test|evaluate|before\s+buying|before\s+purchase|money[\s-]?back|refund)\b/i.test(text) && /\b(pro|plugin|product|license|ninja\s*tables?|fluent|wpmanageninja)\b/i.test(text)) {
    emitActivity(activity, "docs", "Matched refund and trial-period saved reply");
    hints.push([
      "Matched golden-answer saved reply for refund policy and trial period:",
      "Source: docs/golden-answers/wpmanageninja-account-billing-saved-replies.md",
      "Use this when a customer asks whether they can try, test, demo, evaluate, or use a Pro product before buying:",
      "Hello {{customer.first_name}},",
      "We do not have a trial period, but we do have a 14-day refund policy. You can try our product, and if it does not meet your needs, you can request a refund.",
      "You may read our Privacy Policy here: https://wpmanageninja.com/privacy/",
      "Thank you",
      "Answer implication: Keep the reply focused on no trial period + 14-day refund policy. Mention the specific product only naturally; do not turn this into installation instructions unless the customer asks how to install.",
    ].join("\n"));
  }

  if (/fluent\s*forms?/i.test(text) && /stripe/i.test(text) && /\b(two|multiple|different|separate|donation|donations|purchase|purchases|accounts?)\b/i.test(text)) {
    emitActivity(activity, "files", "Matched Fluent Forms Stripe account code evidence");
    hints.push([
      "Matched Fluent Forms Stripe account code evidence:",
      "Source: fluentform/app/Modules/Payments/PaymentMethods/Stripe/StripeSettings.php",
      "The inspected code supports form-specific custom Stripe configuration. getSecretKey($formId), getPublishableKey($formId), and isLive($formId) first read the form payment settings; when stripe_account_type is custom, they use stripe_custom_config.secret_key, stripe_custom_config.publishable_key, and stripe_custom_config.payment_mode for that specific form. Otherwise, they fall back to the global Stripe settings.",
      "Answer implication: Different forms can use different Stripe accounts by configuring custom Stripe credentials per form. For example, one donation form can use the donation Stripe account and one purchase form can use the purchase Stripe account. Do not claim Fluent Forms only supports one Stripe account globally when this code evidence is present.",
      "Do not mention Paymattic as the source or say this is a Paymattic-only feature. This hint is from Fluent Forms code.",
      "Documentation link to include when useful: https://fluentforms.com/docs/how-to-integrate-stripe-with-fluent-forms/",
      "Caveat: Routing to different Stripe accounts inside the same single form based on a selected option is a different requirement and may need separate forms or custom logic.",
    ].join("\n"));
  }

  if (!hints.length) {
    return "Deterministic support hints: none";
  }

  return [
    "Deterministic support hints from local saved replies/code:",
    ...hints,
    "Use these hints as higher priority than broad vector-memory guesses.",
  ].join("\n\n");
}

function sanitizeAgentText(text, input) {
  if (isTrialRefundPolicyQuestion(input)) {
    return buildTrialRefundSavedReply(input);
  }

  let value = String(text || "").replace(/【[^】]+】/g, "").trim();
  const askedFluentForms = /fluent\s*forms?/i.test(String(input || ""));
  const askedPaymattic = /paymattic/i.test(String(input || ""));

  if (askedFluentForms && !askedPaymattic) {
    value = value
      .split("\n")
      .filter((line) => !/paymattic/i.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return value;
}

function isTrialRefundPolicyQuestion(input) {
  const text = String(input || "");
  return /\b(try|trial|demo|test|evaluate|before\s+buying|before\s+purchase|money[\s-]?back|refund)\b/i.test(text) &&
    /\b(pro|plugin|product|license|ninja\s*tables?|fluent|wpmanageninja)\b/i.test(text);
}

function buildTrialRefundSavedReply(input) {
  const product = extractProductName(input) || "our product";
  return [
    "Hello,",
    "",
    `We do not have a trial period, but we do have a 14-day refund policy. You can try ${product}, and if it does not meet your needs, you can request a refund.`,
    "",
    "You may read our Privacy Policy here:",
    "https://wpmanageninja.com/privacy/",
    "",
    "Thank you",
  ].join("\n");
}

function extractProductName(input) {
  const text = String(input || "");
  if (/ninja\s*tables?\s*pro/i.test(text)) return "Ninja Tables Pro";
  if (/ninja\s*tables?/i.test(text)) return "Ninja Tables";
  if (/fluent\s*forms?\s*pro/i.test(text)) return "Fluent Forms Pro";
  if (/fluent\s*forms?/i.test(text)) return "Fluent Forms";
  if (/fluent\s*crm/i.test(text)) return "FluentCRM";
  if (/fluent\s*support/i.test(text)) return "Fluent Support";
  if (/fluent\s*cart/i.test(text)) return "FluentCart";
  if (/fluent\s*booking/i.test(text)) return "FluentBooking";
  return "";
}

function buildUserInput(input, images = []) {
  const text = String(input || "").trim() || "Please analyze the attached image.";
  const imageItems = imageAttachmentsToContentItems(images);

  if (!imageItems.length) {
    return text;
  }

  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text,
        },
        ...imageItems,
      ],
    },
  ];
}

function buildTools(config) {
  const tools = [...agentTools];

  if (config.openaiVectorStoreId) {
    tools.push({
      type: "file_search",
      vector_store_ids: [config.openaiVectorStoreId],
      max_num_results: 8,
    });
  }

  return tools;
}

async function buildSiteFacts(config) {
  const result = await getWordPressSiteSummary(config);
  if (!result.ok) {
    return `Current WordPress site facts: unavailable (${result.message})`;
  }

  const summary = result.summary;
  const activePlugins = summary.plugins.items
    .filter((plugin) => plugin.active)
    .map((plugin) => `${plugin.name} (${plugin.file})`)
    .join("; ");
  const inactivePlugins = summary.plugins.items
    .filter((plugin) => !plugin.active)
    .map((plugin) => `${plugin.name} (${plugin.file})`)
    .join("; ");

  return [
    "Current WordPress site facts:",
    `Site: ${summary.site.name} (${summary.site.url})`,
    `Theme: ${summary.theme.name} (${summary.theme.stylesheet})`,
    `Active plugins (${summary.plugins.active}/${summary.plugins.total}): ${activePlugins || "none"}`,
    `Inactive plugins: ${inactivePlugins || "none"}`,
    `Published content: ${summary.content.post.publish} posts, ${summary.content.page.publish} pages`,
  ].join("\n");
}
