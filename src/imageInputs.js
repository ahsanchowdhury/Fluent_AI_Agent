import fs from "fs";
import path from "path";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function imagePathToDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
    return null;
  }

  const mimeType = mimeTypeFromPath(filePath);
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    return null;
  }

  const data = fs.readFileSync(filePath).toString("base64");
  return `data:${mimeType};base64,${data}`;
}

export function imagePathToInputImage(filePath) {
  const imageUrl = imagePathToDataUrl(filePath);
  if (!imageUrl) {
    return null;
  }

  return {
    type: "input_image",
    image_url: imageUrl,
    detail: "auto",
  };
}

export function normalizeImageAttachments(attachments = []) {
  const normalized = [];

  for (const attachment of attachments) {
    const dataUrl = String(attachment?.dataUrl || "");
    const name = String(attachment?.name || "uploaded-image").trim();
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      continue;
    }

    const mimeType = match[1];
    const bytes = Buffer.from(match[2], "base64");
    if (!SUPPORTED_MIME_TYPES.has(mimeType) || bytes.length > MAX_IMAGE_BYTES) {
      continue;
    }

    normalized.push({
      name: sanitizeImageName(name),
      mimeType,
      dataUrl,
      size: bytes.length,
    });
  }

  return normalized.slice(0, 4);
}

export function imageAttachmentsToContentItems(attachments = []) {
  return normalizeImageAttachments(attachments).map((attachment) => ({
    type: "input_image",
    image_url: attachment.dataUrl,
    detail: "auto",
  }));
}

export function saveImageAttachments(attachments = []) {
  const uploadDir = path.resolve(process.cwd(), "memory", "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });

  return normalizeImageAttachments(attachments).map((attachment, index) => {
    const extension = extensionFromMimeType(attachment.mimeType);
    const fileName = `${Date.now()}-${index + 1}-${attachment.name}.${extension}`;
    const filePath = path.join(uploadDir, fileName);
    const bytes = Buffer.from(attachment.dataUrl.split(",")[1], "base64");
    fs.writeFileSync(filePath, bytes);

    return {
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      path: filePath,
    };
  });
}

export function localImageUrl(filePath) {
  if (!filePath) {
    return "";
  }
  return `/api/local-image?path=${encodeURIComponent(filePath)}`;
}

function mimeTypeFromPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return "image/png";
}

function extensionFromMimeType(mimeType) {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  return "png";
}

function sanitizeImageName(name) {
  const base = path.basename(name, path.extname(name));
  const safe = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "uploaded-image";
}
