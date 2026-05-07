import fs from "fs";
import path from "path";

export function loadEnv(rootDir = process.cwd()) {
  const envPath = path.join(rootDir, ".env");

  if (!fs.existsSync(envPath)) {
    return { envPath, loaded: false };
  }

  const raw = fs.readFileSync(envPath, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return { envPath, loaded: true };
}

export function getConfig() {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    pluginRoot:
      process.env.PLUGIN_ROOT ||
      "/Applications/XAMPP/xamppfiles/htdocs/sites/wp-content/plugins",
    localSiteUrl: process.env.LOCAL_SITE_URL || "http://localhost/sites",
    wpDebugLog:
      process.env.WP_DEBUG_LOG ||
      "/Applications/XAMPP/xamppfiles/htdocs/sites/wp-content/debug.log",
    phpBinary: process.env.PHP_BINARY || "/Applications/XAMPP/xamppfiles/bin/php",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    openaiVectorStoreId: process.env.OPENAI_VECTOR_STORE_ID || "",
    indexMaxFiles: Number(process.env.INDEX_MAX_FILES || 300),
    autoIndexOnChat: process.env.AUTO_INDEX_ON_CHAT === "true",
    autoIndexOnDebug: process.env.AUTO_INDEX_ON_DEBUG === "true",
  };
}

export function maskSecret(value) {
  if (!value) {
    return "";
  }

  if (value.length <= 8) {
    return "********";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
