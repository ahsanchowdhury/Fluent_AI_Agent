const conversationId = crypto.randomUUID();
const messages = document.querySelector("#messages");
const form = document.querySelector("#chatForm");
const input = document.querySelector("#messageInput");
const statusList = document.querySelector("#statusList");
const pluginsList = document.querySelector("#pluginsList");
const themesList = document.querySelector("#themesList");
const siteLabel = document.querySelector("#siteLabel");
const syncBadge = document.querySelector("#syncBadge");
const sendButton = document.querySelector("#sendButton");

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
  resizeInput();
  addMessage("user", text);
  setBusy(true);
  const pending = addThinkingMessage();

  try {
    const result = await postJson("/api/chat", { conversationId, message: text });
    setMessageText(pending, result.text || "(No response)");
  } catch (error) {
    setMessageText(pending, `Error: ${error.message}`);
    pending.querySelector(".message").classList.add("system");
  } finally {
    setBusy(false);
  }
});

input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
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

  if (status.siteSummary) {
    addStatus("Theme", status.siteSummary.theme.name);
    addStatus("Plugins", `${status.siteSummary.plugins.active}/${status.siteSummary.plugins.total} active`);
    addStatus("Posts", `${status.siteSummary.content.post.publish} published`);
    addStatus("Pages", `${status.siteSummary.content.page.publish} published`);
  }
  syncBadge.textContent = status.index.inSync ? "Memory in sync" : "Memory needs sync";
  syncBadge.className = `badge ${status.index.inSync ? "good" : "warn"}`;

  pluginsList.innerHTML = "";
  const sitePlugins = status.siteSummary?.plugins?.items || [];
  for (const plugin of sitePlugins) {
    pluginsList.append(createPluginItem(plugin));
  }

  await loadThemes();
}

async function runDebug(path) {
  addMessage("system", `Running debug${path ? ` for ${path}` : " for homepage"}...`);
  const pending = addThinkingMessage("Collecting diagnostics");

  try {
    const result = await postJson("/api/debug", { path });
    setMessageText(pending, [
      result.text,
      result.contextPath ? `\nDiagnostic context: ${result.contextPath}` : "",
      result.screenshotPath ? `Screenshot: ${result.screenshotPath}` : "",
    ].filter(Boolean).join("\n"));
  } catch (error) {
    setMessageText(pending, `Error: ${error.message}`);
    pending.querySelector(".message").classList.add("system");
  }
}

async function syncIndex() {
  addMessage("system", "Syncing code memory...");
  const pending = addThinkingMessage("Checking installed plugin files");

  try {
    const result = await postJson("/api/index-sync", {});
    setMessageText(pending, `${result.message}\nVector store: ${result.vectorStoreId || "unchanged"}`);
    await loadStatus();
  } catch (error) {
    setMessageText(pending, `Error: ${error.message}`);
    pending.querySelector(".message").classList.add("system");
  }
}

async function resetChat() {
  await postJson("/api/reset", { conversationId });
  messages.innerHTML = "";
  addMessage("assistant", "Chat reset.");
}

async function loadThemes() {
  try {
    const result = await fetchJson("/api/themes");
    themesList.innerHTML = "";
    for (const theme of result.themes || []) {
      themesList.append(createThemeItem(theme));
    }
  } catch (error) {
    themesList.innerHTML = "";
    const item = document.createElement("li");
    item.textContent = `Theme list error: ${error.message}`;
    themesList.append(item);
  }
}

function createPluginItem(plugin) {
  const item = document.createElement("li");
  item.className = "manage-item";
  const row = document.createElement("div");
  row.className = "manage-row";
  const name = document.createElement("div");
  name.className = "manage-name";
  name.textContent = plugin.name;
  const button = document.createElement("button");
  button.className = `mini-button ${plugin.active ? "danger" : "neutral"}`;
  button.textContent = plugin.active ? "Deactivate" : "Activate";
  button.addEventListener("click", () => changePlugin(plugin));
  row.append(name, button);
  const meta = document.createElement("div");
  meta.className = "item-meta";
  meta.textContent = `${plugin.active ? "Active" : "Inactive"} · ${plugin.file}`;
  item.append(row, meta);
  return item;
}

function createThemeItem(theme) {
  const item = document.createElement("li");
  item.className = "manage-item";
  const row = document.createElement("div");
  row.className = "manage-row";
  const name = document.createElement("div");
  name.className = "manage-name";
  name.textContent = theme.name;
  const button = document.createElement("button");
  button.className = "mini-button neutral";
  button.textContent = theme.active ? "Active" : "Activate";
  button.disabled = theme.active;
  button.addEventListener("click", () => activateTheme(theme));
  row.append(name, button);
  const meta = document.createElement("div");
  meta.className = "item-meta";
  meta.textContent = `${theme.stylesheet} · v${theme.version || "unknown"}`;
  item.append(row, meta);
  return item;
}

async function changePlugin(plugin) {
  const action = plugin.active ? "deactivate" : "activate";
  const ok = confirm(`${action === "deactivate" ? "Deactivate" : "Activate"} ${plugin.name}?`);
  if (!ok) return;

  addMessage("system", `${action === "deactivate" ? "Deactivating" : "Activating"} ${plugin.name}...`);
  try {
    const result = await postJson("/api/plugin-action", {
      pluginFile: plugin.file,
      action,
      confirmed: true,
    });
    addMessage("assistant", `Plugin ${result.plugin} ${result.active ? "is active" : "is inactive"}.`);
    await loadStatus();
  } catch (error) {
    addMessage("system", `Plugin action failed: ${error.message}`);
  }
}

async function activateTheme(theme) {
  const ok = confirm(`Activate theme ${theme.name}?`);
  if (!ok) return;

  addMessage("system", `Activating theme ${theme.name}...`);
  try {
    const result = await postJson("/api/theme-action", {
      stylesheet: theme.stylesheet,
      confirmed: true,
    });
    addMessage("assistant", `Active theme is now ${result.theme}.`);
    await loadStatus();
  } catch (error) {
    addMessage("system", `Theme activation failed: ${error.message}`);
  }
}

function addStatus(label, value) {
  const row = document.createElement("div");
  row.className = "status-row";
  row.innerHTML = `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`;
  statusList.append(row);
}

function addMessage(role, text) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "YOU" : role === "system" ? "SYS" : "AI";
  const message = document.createElement("div");
  message.className = `message ${role}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${role === "user" ? "You" : role === "system" ? "System" : "Agent"} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  message.append(meta, body);
  row.append(avatar, message);
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
  return row;
}

function addThinkingMessage(label = "Thinking") {
  const row = addMessage("assistant", "");
  row.querySelector(".body").innerHTML = `${escapeHtml(label)} <span class="typing"><span></span><span></span><span></span></span>`;
  return row;
}

function setMessageText(row, text) {
  row.querySelector(".body").textContent = text;
  messages.scrollTop = messages.scrollHeight;
}

function setBusy(isBusy) {
  sendButton.disabled = isBusy;
  sendButton.textContent = isBusy ? "Sending" : "Send";
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
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
