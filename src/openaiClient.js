import OpenAI from "openai";
import { agentTools, runAgentTool } from "./agentTools.js";

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
  const request = {
    model: config.openaiModel,
    instructions: [
      "You are a local WordPress plugin debugging assistant.",
      "You are running inside the user's local XAMPP WordPress development environment.",
      "You may use the provided read-only tools to inspect local WordPress plugin files.",
      config.openaiVectorStoreId
        ? "You also have file_search memory over indexed plugin code. Use it for broad codebase questions before reading exact files."
        : "No vector store code memory is configured yet. Use local read-only tools instead.",
      "You may also read WordPress site facts, the WordPress debug log, lint PHP files, check WP-CLI plugin status, and visit the local site with a headless browser.",
      "You cannot edit files, run arbitrary shell commands, or inspect the database yet.",
      "Use tools when the user's question requires local plugin names or file contents.",
      "When you use file contents, mention the relative file paths you inspected.",
      "Be concise, practical, and clear about current limitations.",
      `Configured plugin root: ${config.pluginRoot}`,
      `Configured local site URL: ${config.localSiteUrl}`,
      `Configured WP debug log: ${config.wpDebugLog}`,
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
        "You are a local WordPress plugin debugging assistant.",
        "Continue answering using the read-only diagnostic tool results provided.",
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
