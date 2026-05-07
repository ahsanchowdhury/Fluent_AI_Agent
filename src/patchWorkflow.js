import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { agentTools, runAgentTool } from "./agentTools.js";
import { normalizeInsideRoot, readTextFile } from "./tools/filesystem.js";

const PATCH_DIR = path.resolve(process.cwd(), "memory", "patches");
const FORBIDDEN_PATH_PARTS = new Set([
  "_local-ai-agent",
  ".git",
  "node_modules",
  "vendor",
  "memory",
]);

export async function proposePatch(client, config, requestText) {
  const tools = buildTools(config);
  let response = await client.responses.create({
    model: config.openaiModel,
    instructions: [
      "You are a senior WordPress plugin engineer.",
      "Your task is to propose a safe patch for local WordPress plugin files.",
      "You may inspect files with read-only tools and indexed file_search memory.",
      "Do not claim the patch has been applied.",
      "Return a short summary, then exactly one fenced ```json code block.",
      "The JSON must have this shape: {\"changes\":[{\"path\":\"plugin/file.php\",\"find\":\"exact existing text\",\"replace\":\"new text\"}]}",
      "Use exact existing text from read_file results for every find value.",
      "Patch paths must be relative to the WordPress plugin root.",
      "Do not include changes to _local-ai-agent, .env, node_modules, vendor, memory, or generated files.",
      "Keep the patch minimal and focused on the user's request.",
    ].join("\n"),
    tools,
    input: requestText,
  });

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
        "Continue proposing the patch using the read-only inspection results.",
        "Return a short summary, then exactly one fenced ```json code block with exact find/replace changes.",
      ].join("\n"),
      tools,
      previous_response_id: response.id,
      input: toolOutputs,
    });
  }

  const text = response.output_text || "";
  const changeSet = extractChangeSet(text);
  const patch = await buildPatchFromChangeSet(config, changeSet);
  validatePatchPaths(patch);
  const check = await checkPatchContent(config, patch);
  if (!check.ok) {
    throw new Error(`Generated patch failed git apply --check:\n${check.output}`);
  }

  const savedPath = savePatch(patch);

  return {
    text,
    patch,
    savedPath,
  };
}

export async function applyPatchFile(config, patchPath) {
  const resolvedPatchPath = path.resolve(process.cwd(), patchPath);

  if (!resolvedPatchPath.startsWith(PATCH_DIR)) {
    throw new Error(`Patch must be inside ${PATCH_DIR}`);
  }

  if (!fs.existsSync(resolvedPatchPath)) {
    throw new Error(`Patch file does not exist: ${resolvedPatchPath}`);
  }

  const patch = fs.readFileSync(resolvedPatchPath, "utf8");
  validatePatchPaths(patch);

  const check = await runGitApply(config.pluginRoot, ["apply", "--check", resolvedPatchPath]);
  if (!check.ok) {
    return {
      ok: false,
      applied: false,
      message: check.output,
    };
  }

  const apply = await runGitApply(config.pluginRoot, ["apply", resolvedPatchPath]);
  return {
    ok: apply.ok,
    applied: apply.ok,
    message: apply.output || "Patch applied.",
  };
}

export async function checkPatchFile(config, patchPath) {
  const resolvedPatchPath = path.resolve(process.cwd(), patchPath);

  if (!resolvedPatchPath.startsWith(PATCH_DIR)) {
    throw new Error(`Patch must be inside ${PATCH_DIR}`);
  }

  if (!fs.existsSync(resolvedPatchPath)) {
    throw new Error(`Patch file does not exist: ${resolvedPatchPath}`);
  }

  const patch = fs.readFileSync(resolvedPatchPath, "utf8");
  validatePatchPaths(patch);
  const check = await runGitApply(config.pluginRoot, ["apply", "--check", resolvedPatchPath]);

  return {
    ok: check.ok,
    message: check.output || "Patch check passed.",
  };
}

export function validatePatchPaths(patch) {
  const paths = extractPatchPaths(patch);

  if (!paths.length) {
    throw new Error("Patch does not contain any file paths.");
  }

  for (const filePath of paths) {
    if (!filePath || filePath === "/dev/null") {
      continue;
    }

    if (path.isAbsolute(filePath) || filePath.includes("..")) {
      throw new Error(`Unsafe patch path: ${filePath}`);
    }

    const parts = filePath.split(/[\\/]+/);
    for (const part of parts) {
      if (FORBIDDEN_PATH_PARTS.has(part)) {
        throw new Error(`Patch path is not allowed: ${filePath}`);
      }
    }

    if (filePath.startsWith(".env")) {
      throw new Error(`Patch path is not allowed: ${filePath}`);
    }
  }

  return paths;
}

export async function buildPatchFromChangeSet(config, changeSet) {
  if (!changeSet?.changes?.length) {
    throw new Error("Patch proposal did not include any changes.");
  }

  const patches = [];

  for (const change of changeSet.changes) {
    validateTargetPath(config, change.path);

    if (!change.find || change.replace === undefined) {
      throw new Error(`Invalid change for ${change.path}: find and replace are required.`);
    }

    const file = readTextFile(config.pluginRoot, change.path);

    if (!file.content.includes(change.find)) {
      throw new Error(`Find text was not found in ${change.path}.`);
    }

    const updated = file.content.replace(change.find, change.replace);

    if (updated === file.content) {
      throw new Error(`No change generated for ${change.path}.`);
    }

    patches.push(await diffText(change.path, file.content, updated));
  }

  return patches.join("\n");
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

function extractChangeSet(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/i);

  if (!match) {
    throw new Error("The model did not return a fenced JSON change set.");
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Invalid JSON change set: ${error.message}`);
  }
}

function savePatch(patch) {
  fs.mkdirSync(PATCH_DIR, { recursive: true });
  const filePath = path.join(PATCH_DIR, `${Date.now()}-proposal.patch`);
  fs.writeFileSync(filePath, patch, "utf8");
  return filePath;
}

async function checkPatchContent(config, patch) {
  fs.mkdirSync(PATCH_DIR, { recursive: true });
  const tempPath = path.join(PATCH_DIR, `.check-${Date.now()}.patch`);

  try {
    fs.writeFileSync(tempPath, patch, "utf8");
    return await runGitApply(config.pluginRoot, ["apply", "--check", tempPath]);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function extractPatchPaths(patch) {
  const paths = new Set();

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        paths.add(match[1]);
        paths.add(match[2]);
      }
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const value = line.slice(4).trim().split(/\s+/)[0];
      if (value === "/dev/null") {
        paths.add(value);
      } else if (value.startsWith("a/") || value.startsWith("b/")) {
        paths.add(value.slice(2));
      } else {
        paths.add(value);
      }
    }
  }

  return [...paths].filter((filePath) => filePath !== "/dev/null");
}

function validateTargetPath(config, targetPath) {
  const { relative } = normalizeInsideRoot(config.pluginRoot, targetPath);
  const patch = [`--- a/${relative}`, `+++ b/${relative}`].join("\n");
  validatePatchPaths(patch);
}

async function diffText(relativePath, oldContent, newContent) {
  const tempDir = path.join(PATCH_DIR, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const oldPath = path.join(tempDir, "old");
  const newPath = path.join(tempDir, "new");
  fs.writeFileSync(oldPath, oldContent, "utf8");
  fs.writeFileSync(newPath, newContent, "utf8");

  try {
    const result = await runDiff([
      "-u",
      "--label",
      `a/${relativePath}`,
      "--label",
      `b/${relativePath}`,
      oldPath,
      newPath,
    ]);

    if (!result.output) {
      throw new Error(`No diff output generated for ${relativePath}.`);
    }

    return result.output.endsWith("\n") ? result.output : `${result.output}\n`;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runDiff(args) {
  return new Promise((resolve) => {
    execFile("diff", args, { timeout: 10000 }, (error, stdout, stderr) => {
      const code = error?.code ?? 0;
      resolve({
        ok: code === 0 || code === 1,
        output: stdout || stderr,
      });
    });
  });
}

function runGitApply(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 15000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: [stdout, stderr].filter(Boolean).join("\n").trim(),
      });
    });
  });
}
