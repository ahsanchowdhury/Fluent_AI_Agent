const storageKey = "localWpAgentConversations";
const themeStorageKey = "localWpAgentTheme";
let conversations = loadConversations();
let activeConversationId = getInitialConversationId();
const messages = document.querySelector("#messages");
const form = document.querySelector("#chatForm");
const input = document.querySelector("#messageInput");
const statusList = document.querySelector("#statusList");
const pluginsList = document.querySelector("#pluginsList");
const themesList = document.querySelector("#themesList");
const conversationList = document.querySelector("#conversationList");
const siteLabel = document.querySelector("#siteLabel");
const syncBadge = document.querySelector("#syncBadge");
const sendButton = document.querySelector("#sendButton");
const summarizeContextButton = document.querySelector("#summarizeContextButton");
const rewriteButton = document.querySelector("#rewriteButton");
const imageInput = document.querySelector("#imageInput");
const attachImageButton = document.querySelector("#attachImageButton");
const imagePreviewList = document.querySelector("#imagePreviewList");
const lightThemeButton = document.querySelector("#lightThemeButton");
const darkThemeButton = document.querySelector("#darkThemeButton");
let selectedImages = [];

applyTheme(localStorage.getItem(themeStorageKey) || "light");

document.querySelector("#debugHome").addEventListener("click", () => runDebug(""));
document.querySelector("#debugPathButton").addEventListener("click", () => {
  runDebug(document.querySelector("#debugPath").value.trim());
});
document.querySelector("#formTestButton").addEventListener("click", () => {
  runDebug(document.querySelector("#debugPath").value.trim(), { formTest: true });
});
document.querySelector("#syncIndex").addEventListener("click", syncIndex);
document.querySelector("#resetChat").addEventListener("click", resetChat);
attachImageButton.addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", handleImageSelection);
lightThemeButton.addEventListener("click", () => applyTheme("light"));
darkThemeButton.addEventListener("click", () => applyTheme("dark"));
summarizeContextButton.addEventListener("click", () => runComposerAction("summarize_context"));
rewriteButton.addEventListener("click", () => runComposerAction("rewrite"));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text && !selectedImages.length) return;

  input.value = "";
  const images = selectedImages;
  selectedImages = [];
  imageInput.value = "";
  renderSelectedImages();
  resizeInput();
  const userRow = addMessage("user", text || "Analyze attached image.", images);
  updateConversationTitle(text || images[0]?.name || "Image analysis");
  setBusy(true);
  const pending = addThinkingMessage();

  try {
    const result = await postJson("/api/chat", {
      conversationId: activeConversationId,
      message: text,
      images,
      history: getActiveConversation().messages.slice(-12),
    });
    if (Array.isArray(result.images) && result.images.length) {
      setMessageImages(userRow, result.images);
    }
    setMessageText(pending, result.text || "(No response)");
    await loadStatus();
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
renderConversations();
renderActiveConversation();

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

async function runDebug(path, options = {}) {
  addMessage("system", `${options.formTest ? "Testing form" : "Running debug"}${path ? ` for ${path}` : " for homepage"}...`);
  const pending = addThinkingMessage(options.formTest ? "Interacting with page" : "Collecting diagnostics");

  try {
    const result = await postJson("/api/debug", { path, formTest: options.formTest === true });
    setMessageText(pending, [
      result.text,
      result.contextPath ? `\nDiagnostic context: ${result.contextPath}` : "",
      result.beforeScreenshotPath ? `Before screenshot: ${result.beforeScreenshotPath}` : "",
      result.afterScreenshotPath ? `After screenshot: ${result.afterScreenshotPath}` : "",
      result.screenshotPath ? `Screenshot: ${result.screenshotPath}` : "",
    ].filter(Boolean).join("\n"));
    setMessageImages(
      pending,
      [
        result.beforeScreenshotUrl ? { name: "Before screenshot", url: result.beforeScreenshotUrl } : null,
        result.afterScreenshotUrl ? { name: "After screenshot", url: result.afterScreenshotUrl } : null,
        !result.afterScreenshotUrl && result.screenshotUrl ? { name: "Screenshot", url: result.screenshotUrl } : null,
      ].filter(Boolean)
    );
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
  activeConversationId = createConversation("New chat");
  saveConversations();
  renderConversations();
  renderActiveConversation();
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

function addMessage(role, text, images = []) {
  const messageData = {
    id: crypto.randomUUID(),
    role,
    text,
    images: images.map((image) => ({
      name: image.name,
      url: image.url || image.dataUrl,
      mimeType: image.mimeType,
      size: image.size,
    })),
    createdAt: new Date().toISOString(),
  };
  getActiveConversation().messages.push(messageData);
  getActiveConversation().updatedAt = messageData.createdAt;
  saveConversations();
  renderConversations();
  return appendMessage(messageData);
}

function appendMessage(messageData) {
  const row = document.createElement("div");
  row.className = `message-row ${messageData.role}`;
  row.dataset.messageId = messageData.id;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = messageData.role === "user" ? "YOU" : messageData.role === "system" ? "SYS" : "AI";
  const message = document.createElement("div");
  message.className = `message ${messageData.role}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  const metaLabel = document.createElement("span");
  metaLabel.textContent = `${messageData.role === "user" ? "You" : messageData.role === "system" ? "System" : "Agent"} · ${formatTime(messageData.createdAt)}`;
  meta.append(metaLabel);
  if (messageData.role === "assistant") {
    const copyButton = document.createElement("button");
    copyButton.className = "copy-button";
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", () => copyText(messageData.text, copyButton));
    meta.append(copyButton);
  }
  const body = document.createElement("div");
  body.className = "body";
  renderMessageBody(body, messageData.text);
  const imageStrip = createImageStrip(messageData.images || []);
  message.append(meta, body, imageStrip);
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
  renderMessageBody(row.querySelector(".body"), text);
  const messageId = row.dataset.messageId;
  const conversation = getActiveConversation();
  const storedMessage = conversation.messages.find((message) => message.id === messageId);
  if (storedMessage) {
    storedMessage.text = text;
    storedMessage.updatedAt = new Date().toISOString();
    conversation.updatedAt = storedMessage.updatedAt;
    saveConversations();
    renderConversations();
  }
  messages.scrollTop = messages.scrollHeight;
}

function setMessageImages(row, images = []) {
  const strip = row.querySelector(".message-images");
  strip.replaceWith(createImageStrip(images));
  const messageId = row.dataset.messageId;
  const conversation = getActiveConversation();
  const storedMessage = conversation.messages.find((message) => message.id === messageId);
  if (storedMessage) {
    storedMessage.images = images;
    storedMessage.updatedAt = new Date().toISOString();
    conversation.updatedAt = storedMessage.updatedAt;
    saveConversations();
    renderConversations();
  }
  messages.scrollTop = messages.scrollHeight;
}

function setBusy(isBusy) {
  sendButton.disabled = isBusy;
  summarizeContextButton.disabled = isBusy;
  rewriteButton.disabled = isBusy;
  attachImageButton.disabled = isBusy;
  sendButton.textContent = isBusy ? "Sending" : "Send";
}

async function runComposerAction(action) {
  const draft = input.value.trim();
  if (action === "rewrite" && !draft) {
    addMessage("system", "Type or paste the text you want to rewrite first.");
    return;
  }

  const label = action === "rewrite" ? "Rewriting response" : "Summarising context";
  const pending = addThinkingMessage(label);
  setBusy(true);

  try {
    const result = await postJson("/api/message-action", {
      action,
      text: draft,
      history: getActiveConversation().messages,
    });
    setMessageText(pending, result.text || "(No response)");
  } catch (error) {
    setMessageText(pending, `Error: ${error.message}`);
    pending.querySelector(".message").classList.add("system");
  } finally {
    setBusy(false);
  }
}

async function handleImageSelection(event) {
  const files = [...event.target.files].slice(0, 4 - selectedImages.length);
  const images = await Promise.all(files.map(readImageFile));
  selectedImages = [...selectedImages, ...images.filter(Boolean)].slice(0, 4);
  renderSelectedImages();
}

function readImageFile(file) {
  return new Promise((resolve) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      resolve(null);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      mimeType: file.type,
      size: file.size,
      dataUrl: reader.result,
      url: URL.createObjectURL(file),
    });
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function renderSelectedImages() {
  imagePreviewList.innerHTML = "";
  for (const image of selectedImages) {
    const item = document.createElement("div");
    item.className = "image-preview";
    const img = document.createElement("img");
    img.src = image.url || image.dataUrl;
    img.alt = image.name;
    const label = document.createElement("span");
    label.textContent = image.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      selectedImages = selectedImages.filter((item) => item !== image);
      renderSelectedImages();
    });
    item.append(img, label, remove);
    imagePreviewList.append(item);
  }
}

function createImageStrip(images = []) {
  const strip = document.createElement("div");
  strip.className = "message-images";
  for (const image of images.filter((item) => item?.url)) {
    const link = document.createElement("a");
    link.href = image.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const img = document.createElement("img");
    img.src = image.url;
    img.alt = image.name || "Attached image";
    link.append(img);
    strip.append(link);
  }
  return strip;
}

function renderMessageBody(element, text) {
  element.textContent = "";
  const value = String(text || "");
  const blocks = parseMarkdownBlocks(value);

  if (!blocks.length) {
    return;
  }

  for (const block of blocks) {
    element.append(renderMarkdownBlock(block));
  }
}

function parseMarkdownBlocks(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[1] || "", text: code.join("\n") });
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines = [lines[index], lines[index + 1]];
      index += 2;
      while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "table", lines: tableLines });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const parts = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        parts.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: parts.join("\n") });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index]) &&
      !isTableStart(lines, index) &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function renderMarkdownBlock(block) {
  if (block.type === "code") {
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    const codeHeader = document.createElement("div");
    codeHeader.className = "code-header";
    if (block.language) {
      const label = document.createElement("div");
      label.className = "code-language";
      label.textContent = block.language;
      codeHeader.append(label);
    }
    const copyButton = document.createElement("button");
    copyButton.className = "copy-button";
    copyButton.type = "button";
    copyButton.textContent = "Copy code";
    copyButton.addEventListener("click", () => copyText(block.text, copyButton));
    codeHeader.append(copyButton);
    wrapper.append(codeHeader);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = block.text;
    pre.append(code);
    wrapper.append(pre);
    return wrapper;
  }

  if (block.type === "table") {
    return renderMarkdownTable(block.lines);
  }

  if (block.type === "heading") {
    const heading = document.createElement(block.level === 1 ? "h3" : "h4");
    appendInlineMarkdown(heading, block.text);
    return heading;
  }

  if (block.type === "list") {
    const list = document.createElement(block.ordered ? "ol" : "ul");
    for (const item of block.items) {
      const li = document.createElement("li");
      appendInlineMarkdown(li, item);
      list.append(li);
    }
    return list;
  }

  if (block.type === "quote") {
    const quote = document.createElement("blockquote");
    for (const [index, part] of block.text.split("\n").entries()) {
      if (index) quote.append(document.createElement("br"));
      appendInlineMarkdown(quote, part);
    }
    return quote;
  }

  const paragraph = document.createElement("p");
  const parts = String(block.text || "").split("\n");
  for (const [index, part] of parts.entries()) {
    if (index) paragraph.append(document.createElement("br"));
    appendInlineMarkdown(paragraph, part);
  }
  return paragraph;
}

function renderMarkdownTable(lines) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-wrap";
  const table = document.createElement("table");
  const headerCells = splitTableRow(lines[0]);
  const bodyRows = lines.slice(2).map(splitTableRow).filter((row) => row.length);
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const cell of headerCells) {
    const th = document.createElement("th");
    appendInlineMarkdown(th, cell);
    headerRow.append(th);
  }
  thead.append(headerRow);
  table.append(thead);
  const tbody = document.createElement("tbody");
  for (const row of bodyRows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      appendInlineMarkdown(td, cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrapper.append(table);
  return wrapper;
}

function appendInlineMarkdown(parent, text) {
  const value = String(text || "");
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>"']+)/g;
  let lastIndex = 0;

  for (const match of value.matchAll(pattern)) {
    if (match.index > lastIndex) {
      parent.append(document.createTextNode(value.slice(lastIndex, match.index)));
    }

    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("**") && token.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else {
      const markdownLink = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      const url = markdownLink ? markdownLink[2] : token.replace(/[),.;:!?]+$/g, "");
      const trailing = markdownLink ? "" : token.slice(url.length);
      const link = document.createElement("a");
      link.href = url;
      link.textContent = markdownLink ? markdownLink[1] : url;
      link.target = "_blank";
      link.rel = "noreferrer";
      parent.append(link);
      if (trailing) parent.append(document.createTextNode(trailing));
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < value.length) {
    parent.append(document.createTextNode(value.slice(lastIndex)));
  }
}

function isTableStart(lines, index) {
  return Boolean(
    lines[index] &&
      lines[index + 1] &&
      /\|/.test(lines[index]) &&
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])
  );
}

function splitTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = nextTheme;
  localStorage.setItem(themeStorageKey, nextTheme);
  lightThemeButton.classList.toggle("active", nextTheme === "light");
  darkThemeButton.classList.toggle("active", nextTheme === "dark");
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(String(text || ""));
    flashCopyState(button, "Copied");
  } catch (_error) {
    const textarea = document.createElement("textarea");
    textarea.value = String(text || "");
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    flashCopyState(button, "Copied");
  }
}

function flashCopyState(button, label) {
  const original = button.textContent;
  button.textContent = label;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1200);
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

function loadConversations() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (Array.isArray(saved) && saved.length) {
      return saved.filter((conversation) => conversation?.id && Array.isArray(conversation.messages));
    }
  } catch (_error) {
    localStorage.removeItem(storageKey);
  }

  return [buildConversation("New chat")];
}

function saveConversations() {
  localStorage.setItem(storageKey, JSON.stringify(conversations.slice(0, 30)));
}

function getInitialConversationId() {
  return conversations[0]?.id || createConversation("New chat");
}

function createConversation(title) {
  const conversation = buildConversation(title);
  conversations.unshift(conversation);
  return conversation.id;
}

function buildConversation(title) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "Ready. Ask me about your local WordPress plugins, debug logs, browser errors, or code memory.",
        createdAt: now,
      },
    ],
  };
}

function getActiveConversation() {
  let conversation = conversations.find((item) => item.id === activeConversationId);
  if (!conversation) {
    activeConversationId = createConversation("New chat");
    conversation = conversations[0];
  }
  return conversation;
}

function updateConversationTitle(text) {
  const conversation = getActiveConversation();
  if (conversation.title !== "New chat" || !text) {
    return;
  }

  conversation.title = text.length > 42 ? `${text.slice(0, 39)}...` : text;
  saveConversations();
  renderConversations();
}

function renderActiveConversation() {
  messages.innerHTML = "";
  for (const message of getActiveConversation().messages) {
    appendMessage(message);
  }
  messages.scrollTop = messages.scrollHeight;
}

function renderConversations() {
  conversationList.innerHTML = "";
  const sorted = [...conversations].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  for (const conversation of sorted) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = `conversation-button ${conversation.id === activeConversationId ? "active" : ""}`;
    button.type = "button";
    button.addEventListener("click", () => {
      activeConversationId = conversation.id;
      renderConversations();
      renderActiveConversation();
    });

    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversation.title || "New chat";
    const meta = document.createElement("span");
    meta.className = "conversation-meta";
    meta.textContent = `${conversation.messages.length} messages · ${formatRelative(conversation.updatedAt)}`;
    button.append(title, meta);
    item.append(button);
    conversationList.append(item);
  }
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelative(value) {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
