import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rootsPath = path.resolve(rootDir, "docs", "doc-roots.json");
const outputDir = path.resolve(rootDir, "docs", "doc-links");
const userAgent = "Fluent-AI-Agent-Doc-Link-Indexer/1.0";
const maxPagesPerProduct = Number(process.env.DOC_LINK_MAX_PAGES || 120);
const concurrency = Number(process.env.DOC_LINK_CONCURRENCY || 8);
const fetchTimeoutMs = Number(process.env.DOC_LINK_FETCH_TIMEOUT_MS || 8000);

const roots = JSON.parse(fs.readFileSync(rootsPath, "utf8"));
fs.mkdirSync(outputDir, { recursive: true });

const generatedAt = new Date().toISOString();
const summaries = [];

for (const root of roots) {
  console.log(`Indexing ${root.product}: ${root.url}`);
  const pages = await crawlProduct(root);
  writeProductIndex(root, pages);
  summaries.push({
    product: root.product,
    slug: root.slug,
    rootUrl: root.url,
    pageCount: pages.length,
  });
  console.log(`  ${pages.length} documentation links saved`);
}

writeMainIndex(summaries);
console.log("");
console.log(`Doc link index complete: ${outputDir}`);

async function crawlProduct(root) {
  const rootUrl = normalizeUrl(root.url, root.url);
  const queue = unique([rootUrl, ...(await findSitemapUrls(rootUrl))]).slice(0, maxPagesPerProduct);
  const queued = new Set(queue);
  const visited = new Set();
  const pages = [];
  let batches = 0;

  while (queue.length && visited.size < maxPagesPerProduct) {
    const batch = queue.splice(0, concurrency);
    const results = await Promise.all(batch.map((url) => fetchPage(url)));
    batches += 1;

    for (const result of results) {
      visited.add(result.url);

      if (!result.ok) {
        continue;
      }

      pages.push({
        title: result.title || readableTitleFromUrl(result.url),
        url: result.url,
        description: result.description || "",
        keywords: keywordsFrom(result.title, result.description, result.url),
      });

      for (const href of extractLinks(result.html, result.url)) {
        const normalized = normalizeUrl(href, result.url);
        if (!normalized || queued.has(normalized) || visited.has(normalized)) {
          continue;
        }

        if (!isAllowedDocUrl(rootUrl, normalized)) {
          continue;
        }

        queued.add(normalized);
        if (queued.size <= maxPagesPerProduct * 3) {
          queue.push(normalized);
        }
      }
    }

    if (batches === 1 || batches % 5 === 0) {
      console.log(`  visited ${visited.size}, saved ${pages.length}, queued ${queue.length}`);
    }
  }

  return pages.sort((a, b) => a.title.localeCompare(b.title) || a.url.localeCompare(b.url));
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("text/html")) {
      return { ok: false, url, status: response.status };
    }

    const html = await response.text();
    const finalUrl = normalizeUrl(response.url || url, url) || url;

    return {
      ok: true,
      url: finalUrl,
      html,
      title: cleanText(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i)),
      description: cleanText(
        matchFirst(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
          matchFirst(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i)
      ),
    };
  } catch (error) {
    return { ok: false, url, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function findSitemapUrls(rootUrlText) {
  const rootUrl = new URL(rootUrlText);
  const sitemapCandidates = [
    new URL("/sitemap.xml", rootUrl).toString(),
    new URL("/sitemap_index.xml", rootUrl).toString(),
    new URL("/page-sitemap.xml", rootUrl).toString(),
    new URL("/docs-sitemap.xml", rootUrl).toString(),
    new URL("/article-sitemap.xml", rootUrl).toString(),
  ];
  const found = [];
  const seenSitemaps = new Set();

  for (const sitemapUrl of sitemapCandidates) {
    await collectSitemapUrls(rootUrlText, sitemapUrl, found, seenSitemaps);
  }

  return unique(found).slice(0, maxPagesPerProduct);
}

async function collectSitemapUrls(rootUrlText, sitemapUrl, found, seenSitemaps) {
  if (seenSitemaps.has(sitemapUrl) || seenSitemaps.size > 20) {
    return;
  }

  seenSitemaps.add(sitemapUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    const response = await fetch(sitemapUrl, {
      headers: {
        "user-agent": userAgent,
        accept: "application/xml,text/xml,text/plain",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return;
    }

    const xml = await response.text();
    const urls = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((match) => decodeHtml(match[1].trim()));

    for (const url of urls) {
      const normalized = normalizeUrl(url, sitemapUrl);
      if (!normalized) {
        continue;
      }

      if (normalized.endsWith(".xml")) {
        await collectSitemapUrls(rootUrlText, normalized, found, seenSitemaps);
        continue;
      }

      if (isAllowedDocUrl(rootUrlText, normalized)) {
        found.push(normalized);
      }
    }
  } catch (_error) {
    // Sitemaps are an optimization only. The page crawler still works without them.
  } finally {
    clearTimeout(timeout);
  }
}

function extractLinks(html, baseUrl) {
  const links = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = anchorPattern.exec(html))) {
    const href = decodeHtml(match[1]);
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }

    const normalized = normalizeUrl(href, baseUrl);
    if (normalized) {
      links.push(normalized);
    }
  }

  return links;
}

function normalizeUrl(input, baseUrl) {
  try {
    const url = new URL(input, baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }

    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");

    if (looksLikeAsset(url.pathname)) {
      return "";
    }

    return url.toString().replace(/\/$/, "/");
  } catch (_error) {
    return "";
  }
}

function isAllowedDocUrl(rootUrlText, candidateText) {
  const rootUrl = new URL(rootUrlText);
  const candidate = new URL(candidateText);

  if (candidate.hostname !== rootUrl.hostname) {
    return false;
  }

  const pathName = candidate.pathname.toLowerCase();
  if (isNonDocPath(pathName)) {
    return false;
  }

  if (rootUrl.hostname.startsWith("docs.")) {
    return true;
  }

  if (pathName.includes("/docs")) {
    return true;
  }

  return pathName.startsWith(rootUrl.pathname.toLowerCase());
}

function looksLikeAsset(pathName) {
  return /\.(7z|avi|css|docx?|gif|ico|jpe?g|js|json|mp3|mp4|pdf|png|pptx?|rar|svg|webp|xlsx?|zip)$/i.test(pathName);
}

function isNonDocPath(pathName) {
  return (
    pathName.includes("/wp-admin") ||
    pathName.includes("/wp-json") ||
    pathName.includes("/feed") ||
    pathName.includes("/comments") ||
    pathName.includes("/cart") ||
    pathName.includes("/checkout") ||
    pathName.includes("/my-account")
  );
}

function writeProductIndex(root, pages) {
  const lines = [
    `# ${root.product} Documentation Links`,
    "",
    `Product: ${root.product}`,
    `Root URL: ${root.url}`,
    `Generated: ${generatedAt}`,
    `Pages indexed: ${pages.length}`,
    "",
    "Use these official documentation links when answering customer questions about this product. Include the most relevant link only when it matches the question.",
    "",
  ];

  for (const page of pages) {
    lines.push(`## ${page.title}`);
    lines.push(`URL: ${page.url}`);
    if (page.description) {
      lines.push(`Description: ${page.description}`);
    }
    lines.push(`Keywords: ${page.keywords.join(", ")}`);
    lines.push("");
  }

  fs.writeFileSync(path.join(outputDir, `${root.slug}.md`), `${lines.join("\n").trim()}\n`, "utf8");
}

function writeMainIndex(summaries) {
  const lines = [
    "# Official Documentation Link Index",
    "",
    `Generated: ${generatedAt}`,
    "",
    "These are trusted documentation roots and crawled child pages for support replies. Use product-specific files in this folder to choose the best clickable documentation link.",
    "",
    "| Product | Root URL | Local index | Pages |",
    "| --- | --- | --- | --- |",
  ];

  for (const summary of summaries) {
    lines.push(
      `| ${summary.product} | ${summary.rootUrl} | doc-links/${summary.slug}.md | ${summary.pageCount} |`
    );
  }

  fs.writeFileSync(path.join(outputDir, "index.md"), `${lines.join("\n").trim()}\n`, "utf8");
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function matchFirst(text, pattern) {
  return text.match(pattern)?.[1] || "";
}

function cleanText(text) {
  return decodeHtml(stripTags(text || ""))
    .replace(/\s+/g, " ")
    .replace(/\s+\|.*$/g, "")
    .trim();
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, " ");
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8211;/g, "-")
    .replace(/&#8212;/g, "-")
    .replace(/&#038;/g, "&")
    .replace(/&#x2F;/g, "/");
}

function readableTitleFromUrl(urlText) {
  const url = new URL(urlText);
  const part = url.pathname.split("/").filter(Boolean).at(-1) || url.hostname;
  return part
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function keywordsFrom(title, description, urlText) {
  const url = new URL(urlText);
  const raw = `${title || ""} ${description || ""} ${url.pathname.replace(/[/-]+/g, " ")}`;
  const seen = new Set();

  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .filter((word) => !["and", "the", "for", "with", "docs", "documentation", "fluent"].includes(word))
    .filter((word) => {
      if (seen.has(word)) {
        return false;
      }
      seen.add(word);
      return true;
    })
    .slice(0, 18);
}
