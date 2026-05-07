import fs from "fs";
import path from "path";

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".svn",
  "node_modules",
  "vendor",
  "cache",
  "logs",
  "tmp",
  "uploads",
  "dist",
  "build",
  "coverage",
  "memory",
  "_local-ai-agent",
  "admin-app",
  "libs",
]);

const TEXT_EXTENSIONS = new Set([
  ".php",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".html",
  ".json",
  ".md",
  ".txt",
  ".xml",
  ".yml",
  ".yaml",
  ".po",
  ".pot",
  ".sh",
]);

const MAX_READ_BYTES = 250 * 1024;

function isIgnoredFile(fileName) {
  return (
    fileName.endsWith(".min.js") ||
    fileName.endsWith(".min.css") ||
    fileName.endsWith(".map") ||
    /-[a-f0-9]{8,}\.(js|css)$/i.test(fileName) ||
    /^main\.\d+(\.\d+)+\.(js|css)$/i.test(fileName) ||
    fileName === "composer.lock" ||
    fileName === "package-lock.json" ||
    fileName === "yarn.lock" ||
    fileName === "pnpm-lock.yaml"
  );
}

export function normalizeInsideRoot(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, targetPath || ".");
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes plugin root: ${targetPath}`);
  }

  return { root, resolved, relative: relative || "." };
}

export function listPluginDirectories(pluginRoot) {
  const entries = fs.readdirSync(pluginRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => entry.name !== "_local-ai-agent")
    .map((entry) => {
      const pluginPath = path.join(pluginRoot, entry.name);
      const mainFiles = findPluginMainFiles(pluginPath);

      return {
        name: entry.name,
        path: pluginPath,
        mainFiles,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findPluginMainFiles(pluginPath) {
  const files = fs
    .readdirSync(pluginPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".php"))
    .map((entry) => path.join(pluginPath, entry.name));

  return files.filter((file) => {
    const content = fs.readFileSync(file, "utf8").slice(0, 8192);
    return /Plugin Name\s*:/i.test(content);
  });
}

export function listFiles(rootDir, options = {}) {
  const maxFiles = options.maxFiles || 500;
  const startPath = options.path || ".";
  const { root, resolved } = normalizeInsideRoot(rootDir, startPath);
  const output = [];

  function walk(currentPath) {
    if (output.length >= maxFiles) {
      return;
    }

    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (output.length >= maxFiles) {
        return;
      }

      const fullPath = path.join(currentPath, entry.name);
      const relative = path.relative(root, fullPath);

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) {
          continue;
        }

        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (isIgnoredFile(entry.name)) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension)) {
        continue;
      }

      output.push(relative);
    }
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    walk(resolved);
  } else if (stat.isFile()) {
    output.push(path.relative(root, resolved));
  }

  return output.sort();
}

export function readTextFile(rootDir, targetPath) {
  const { resolved, relative } = normalizeInsideRoot(rootDir, targetPath);
  const stat = fs.statSync(resolved);

  if (!stat.isFile()) {
    throw new Error(`Not a file: ${targetPath}`);
  }

  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`File is too large to read safely: ${relative} (${stat.size} bytes)`);
  }

  const extension = path.extname(resolved).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported file type for text read: ${relative}`);
  }

  return {
    path: relative,
    bytes: stat.size,
    content: fs.readFileSync(resolved, "utf8"),
  };
}
