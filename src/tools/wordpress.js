import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { normalizeInsideRoot } from "./filesystem.js";

const MAX_LOG_BYTES = 200 * 1024;

export function getWordPressRoot(pluginRoot) {
  return path.resolve(pluginRoot, "..", "..");
}

export function tailDebugLog(logPath, lines = 120) {
  if (!fs.existsSync(logPath)) {
    return {
      exists: false,
      path: logPath,
      content: "",
      message: "Debug log does not exist.",
    };
  }

  const stat = fs.statSync(logPath);
  const start = Math.max(0, stat.size - MAX_LOG_BYTES);
  const file = fs.openSync(logPath, "r");
  const buffer = Buffer.alloc(stat.size - start);

  try {
    fs.readSync(file, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(file);
  }

  const content = buffer
    .toString("utf8")
    .split(/\r?\n/)
    .slice(-Math.max(1, lines))
    .join("\n");

  return {
    exists: true,
    path: logPath,
    bytes: stat.size,
    lines,
    content,
  };
}

export function lintPhpFile(pluginRoot, targetPath) {
  const { resolved, relative } = normalizeInsideRoot(pluginRoot, targetPath);

  if (!resolved.endsWith(".php")) {
    return Promise.resolve({
      ok: false,
      path: relative,
      message: "Only PHP files can be linted with php -l.",
    });
  }

  return runCommand("php", ["-l", resolved]).then((result) => ({
    ok: result.ok,
    path: relative,
    message: result.output,
  }));
}

export function wpCliPluginList(pluginRoot) {
  const wpRoot = getWordPressRoot(pluginRoot);

  return runCommand("wp", [
    `--path=${wpRoot}`,
    "plugin",
    "list",
    "--fields=name,status,version",
    "--format=json",
  ]).then((result) => {
    if (!result.ok) {
      return {
        ok: false,
        wordpressRoot: wpRoot,
        message: result.output,
      };
    }

    try {
      return {
        ok: true,
        wordpressRoot: wpRoot,
        plugins: JSON.parse(result.output),
      };
    } catch (error) {
      return {
        ok: false,
        wordpressRoot: wpRoot,
        message: `WP-CLI returned invalid JSON: ${error.message}\n${result.output}`,
      };
    }
  });
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();

        resolve({
          ok: !error,
          output: output || (error ? error.message : ""),
        });
      }
    );
  });
}
