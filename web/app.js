const conversationId = crypto.randomUUID();
const messages = document.querySelector("#messages");
const form = document.querySelector("#chatForm");
const input = document.querySelector("#messageInput");
const statusList = document.querySelector("#statusList");
const pluginsList = document.querySelector("#pluginsList");
const siteLabel = document.querySelector("#siteLabel");

document.querySelector("#debugHome").addEventListener("click", () => runDebug(""));
document.querySelector("#debugPathButton").addEventListener("click", () => {
  runDebug(document.querySelector("#debugPath").value.trim());
});
document.querySelector("#syncIndex").addEventListener("click", syncIndex);
document.querySelector("#resetChat").addEventListener("click", resetChat);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  addMessage("user", text);
  const pending = addMessage("assistant", "Thinking...");

  try {
    const result = await postJson("/api/chat", { conversationId, message: text });
    pending.textContent = result.text || "(No response)";
  } catch (error) {
    pending.textContent = `Error: ${error.message}`;
    pending.classList.add("system");
  }
});

await loadStatus();
addMessage("assistant", "Ready. Ask me about your local WordPress plugins, debug logs, browser errors, or code memory.");

async function loadStatus() {
  const status = await fetchJson("/api/status");
  siteLabel.textContent = status.site;
  statusList.innerHTML = "";
  addStatus("Model", status.model);
  addStatus("Memory", status.vectorStoreId || "not indexed");
  addStatus("Index", status.index.inSync ? "in sync" : "needs sync");
  addStatus("Files", `${status.index.fileCount}`);
  addStatus("Key", status.key);

  pluginsList.innerHTML = "";
  for (const plugin of status.plugins) {
    const item = document.createElement("li");
    item.textContent = plugin.name;
    pluginsList.append(item);
  }
}

async function runDebug(path) {
  addMessage("system", `Running debug${path ? ` for ${path}` : " for homepage"}...`);
  const pending = addMessage("assistant", "Collecting diagnostics...");

  try {
    const result = await postJson("/api/debug", { path });
    pending.textContent = [
      result.text,
      result.contextPath ? `\nDiagnostic context: ${result.contextPath}` : "",
      result.screenshotPath ? `Screenshot: ${result.screenshotPath}` : "",
    ].filter(Boolean).join("\n");
  } catch (error) {
    pending.textContent = `Error: ${error.message}`;
    pending.classList.add("system");
  }
}

async function syncIndex() {
  addMessage("system", "Syncing code memory...");
  const pending = addMessage("assistant", "Checking installed plugin files...");

  try {
    const result = await postJson("/api/index-sync", {});
    pending.textContent = `${result.message}\nVector store: ${result.vectorStoreId || "unchanged"}`;
    await loadStatus();
  } catch (error) {
    pending.textContent = `Error: ${error.message}`;
    pending.classList.add("system");
  }
}

async function resetChat() {
  await postJson("/api/reset", { conversationId });
  messages.innerHTML = "";
  addMessage("assistant", "Chat reset.");
}

function addStatus(label, value) {
  const row = document.createElement("div");
  row.className = "status-row";
  row.innerHTML = `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`;
  statusList.append(row);
}

function addMessage(role, text) {
  const message = document.createElement("div");
  message.className = `message ${role}`;
  message.textContent = text;
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;
  return message;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
