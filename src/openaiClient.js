import OpenAI from "openai";
import { agentTools, runAgentTool } from "./agentTools.js";
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

export async function createAgentResponse(client, { input, config, previousResponseId = null }) {
  const tools = buildTools(config);
  const siteFacts = await buildSiteFacts(config);
  const request = {
    model: config.openaiModel,
    instructions: [
      "You are a local WordPress support agent and plugin debugging assistant.",
      "You are running inside the user's local XAMPP WordPress development environment.",
      "You may use the provided read-only tools to inspect local WordPress plugin files.",
      config.openaiVectorStoreId
        ? "You also have file_search memory over indexed plugin code. Use it for broad codebase questions before reading exact files."
        : "No vector store code memory is configured yet. Use local read-only tools instead.",
      "You may also read WordPress site facts, the WordPress debug log, lint PHP files, check WP-CLI plugin status, and visit the local site with a headless browser.",
      "For client-style feature questions, act like a careful support agent: first check the installed/active plugin list, then verify the requested feature in Fluent Support code/docs/files when Fluent Support is relevant, then search other installed plugins for a workaround or integration path.",
      "When checking Fluent Support, inspect both the base plugin folder 'fluent-support' and the Pro/add-on folder 'fluent-support-pro' before concluding a feature is missing.",
      "Do not answer feature-availability questions from memory alone. Use get_wordpress_site_summary and search_files/read_file or file_search before saying a plugin can or cannot do something.",
      "Current WordPress site facts are provided below. Do not ask whether an installed/active plugin is available if the facts already say it is.",
      "Do not use WP-CLI for ordinary plugin status or support questions because this local XAMPP site may need the XAMPP PHP runtime. Prefer get_wordpress_site_summary for installed/active plugin facts.",
      "If Fluent Support lacks a feature but FluentCRM or another installed plugin can solve the client need, explain that clearly as a workaround. Example: Fluent Support may not schedule outbound emails, but FluentCRM can schedule campaigns/automations if installed.",
      "When the client asks 'how do I...', answer in a support-friendly format: short answer, checked source, workaround if needed, and practical steps. Avoid exposing raw code details unless the user asks for developer details.",
      "In the web dashboard, plugin/theme activation changes are handled by the local chat action workflow. Do not suggest WP-CLI first for those requests.",
      "You cannot edit files, run arbitrary shell commands, or inspect the database yet.",
      "Use tools when the user's question requires local plugin names or file contents.",
      "When you use file contents, mention the relative file paths you inspected.",
      "Be concise, practical, confident when verified, and clear about current limitations.",
      `Configured plugin root: ${config.pluginRoot}`,
      `Configured local site URL: ${config.localSiteUrl}`,
      `Configured WP debug log: ${config.wpDebugLog}`,
      siteFacts,
    ].join("\n"),
    tools,
    input,
  };

  if (previousResponseId) {
    request.previous_response_id = previousResponseId;
  }

  let response = await client.responses.create(request);

  for (let i = 0; i < 5; i += 1) {
    const toolCalls = response.output.filter((item) => item.type === "function_call");

    if (!toolCalls.length) {
      break;
    }

    const toolOutputs = await Promise.all(
      toolCalls.map(async (toolCall) => ({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: await runAgentTool(config, toolCall),
      }))
    );

    response = await client.responses.create({
      model: config.openaiModel,
      instructions: [
        "You are a local WordPress support agent and plugin debugging assistant.",
        "Continue answering using the read-only diagnostic and search tool results provided.",
        "For support questions, state what you verified in Fluent Support first, then any workaround found in other installed plugins.",
        "Do not claim you edited files or inspected the database.",
      ].join("\n"),
      tools,
      previous_response_id: response.id,
      input: toolOutputs,
    });
  }

  return {
    text: response.output_text || "",
    responseId: response.id,
  };
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
