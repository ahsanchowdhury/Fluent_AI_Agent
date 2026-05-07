import { buildIndexManifest, diffManifests, readSavedManifest, syncCodeVectorStore } from "./codeIndex.js";
import { createOpenAIClient } from "./openaiClient.js";

export async function maybeAutoIndex(config, reason) {
  const current = buildIndexManifest(config, { path: "." });
  const previous = readSavedManifest();
  const diff = diffManifests(previous, current);

  if (!diff.changed && config.openaiVectorStoreId) {
    return {
      changed: false,
      message: "Code memory is already in sync.",
    };
  }

  const client = createOpenAIClient(config);
  const result = await syncCodeVectorStore(client, config, { path: "." });

  return {
    changed: result.changed,
    vectorStoreId: result.vectorStoreId,
    message: `Code memory synced for ${reason}.`,
  };
}
