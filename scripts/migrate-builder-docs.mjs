import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_ROOT = "https://buildersupport.gitbook.io/help-docs";
const SITEMAP_URL = `${SOURCE_ROOT}/sitemap-pages.xml`;
const PROJECT_ROOT = process.cwd();
const IMAGE_DIR = path.join(PROJECT_ROOT, "images", "builder");
const REPORT_PATH = path.join(PROJECT_ROOT, "builder-migration-report.json");

const PAGE_CONCURRENCY = 5;
const IMAGE_CONCURRENCY = 8;

const pageErrors = [];
const unresolvedImages = [];
const imageErrors = [];

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function titleCaseSlug(slug) {
  return slug
    .split("-")
    .map((word) => word ? word[0].toUpperCase() + word.slice(1) : word)
    .join(" ");
}

function yamlString(value) {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

function stripMarkdown(value) {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function descriptionFor(markdown, title) {
  const blocks = markdown.split(/\n\s*\n/);
  for (const block of blocks) {
    const candidate = block.trim();
    if (!candidate || /^(?:[#>*+-]|\d+\.)\s/.test(candidate) || candidate.startsWith("<")) continue;
    const plain = stripMarkdown(candidate);
    if (plain.length >= 30) {
      if (plain.length <= 180) return plain;
      const shortened = plain.slice(0, 177).replace(/\s+\S*$/, "").trimEnd();
      return `${shortened}...`;
    }
  }
  return `Learn how to use ${title} in Bosscart Builder.`;
}

async function fetchResponse(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "user-agent": "Bosscart-Docs-Migration/1.0",
          ...options.headers,
        },
        ...options,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function fetchText(url, options = {}) {
  return (await fetchResponse(url, options)).text();
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function unwrapGitBookImage(url) {
  const cleaned = decodeEntities(url).replace(/\\&/g, "&").replace(/\\u0026/g, "&");
  try {
    const parsed = new URL(cleaned);
    if (parsed.pathname.includes("/~gitbook/image")) {
      return parsed.searchParams.get("url") || cleaned;
    }
  } catch {
    // Keep the original value for reporting.
  }
  return cleaned;
}

function canonicalAssetUrl(url) {
  const unwrapped = unwrapGitBookImage(url);
  try {
    const parsed = new URL(unwrapped);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return unwrapped;
  }
}

function extractRenderedImageCandidates(html) {
  const normalized = decodeEntities(html).replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  const bodyStart = normalized.indexOf("<body");
  const renderedBody = bodyStart >= 0 ? normalized.slice(bodyStart) : normalized;
  const proxyPattern = /https?:\/\/[^"'\s<>]+\/~gitbook\/image\?url=[^"'\s<>]+/g;
  const candidates = [];
  let previousKey = null;
  for (const match of renderedBody.matchAll(proxyPattern)) {
    const proxy = match[0];
    const target = unwrapGitBookImage(proxy);
    const lower = target.toLowerCase();
    const isSiteIcon = (lower.includes("%2fsites%2f") || lower.includes("/sites/")) &&
      (lower.includes("%2ficon%2f") || lower.includes("/icon/"));
    if (isSiteIcon || !/^https?:\/\//i.test(target)) continue;
    const key = canonicalAssetUrl(target);
    // GitBook emits several consecutive responsive variants for each image.
    // Collapse those variants, but preserve a later repeat of the same image
    // because the article may intentionally show it more than once.
    if (key === previousKey) continue;
    previousKey = key;
    candidates.push({ key, target, proxy });
  }
  return candidates;
}

function extractImageTokens(markdown) {
  const pattern = /!\[([^\]]*)\]\(([^)\n]+)\)|<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  const tokens = [];
  for (const match of markdown.matchAll(pattern)) {
    let alt = match[1] || "";
    if (!match[1]) {
      const altMatch = match[0].match(/\balt=(?:"([^"]*)"|'([^']*)')/i);
      alt = altMatch?.[1] || altMatch?.[2] || "";
    }
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      original: match[0],
      rawUrl: (match[2] || match[3] || match[4] || "").replace(/^<|>$/g, ""),
      alt,
      assetKey: null,
    });
  }
  return tokens;
}

function matchImages(page, candidates) {
  let candidateCursor = 0;
  for (const token of page.imageTokens) {
    const raw = decodeEntities(token.rawUrl).replace(/\\&/g, "&").trim();
    if (raw.startsWith("data:") || raw.startsWith("/images/")) continue;

    let matched;
    if (raw.startsWith("/files/")) {
      matched = candidates[candidateCursor];
      candidateCursor += 1;
    } else if (/^https?:\/\//i.test(raw)) {
      const key = canonicalAssetUrl(raw);
      const foundIndex = candidates.findIndex((candidate, index) => index >= candidateCursor && candidate.key === key);
      if (foundIndex >= 0) {
        matched = candidates[foundIndex];
        candidateCursor = foundIndex + 1;
      } else {
        matched = { key, target: unwrapGitBookImage(raw), proxy: raw.includes("/~gitbook/image") ? raw : null };
      }
    }

    if (!matched) {
      unresolvedImages.push({ page: page.sourceUrl, image: raw });
      continue;
    }
    token.assetKey = matched.key;
    page.assets.set(matched.key, matched);
  }
}

function sourcePathFromUrl(url) {
  const pathname = new URL(url).pathname.replace(/^\/help-docs\/?/, "").replace(/\/$/, "");
  return pathname;
}

function localRouteForSourcePath(sourcePath) {
  return sourcePath ? `builder/${sourcePath}` : "builder";
}

function convertInternalHref(rawHref, knownSourcePaths) {
  let href = decodeEntities(rawHref).replace(/\\&/g, "&").trim();
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return href;

  let sourcePath;
  let suffix = "";
  try {
    const absolute = new URL(href, SOURCE_ROOT);
    if (absolute.hostname === "buildersupport.gitbook.io" &&
      (absolute.pathname.startsWith("/help-docs") || absolute.pathname.startsWith("/hub"))) {
      sourcePath = absolute.pathname.replace(/^\/(?:help-docs|hub)\/?/, "").replace(/\.md$/, "").replace(/\/$/, "");
      suffix = `${absolute.search}${absolute.hash}`;
    } else if (href.startsWith("/help-docs/") || href.startsWith("/hub/")) {
      sourcePath = href.replace(/^\/(?:help-docs|hub)\/?/, "").replace(/\.md(?:$|[?#])/, "");
    }
  } catch {
    return href;
  }
  if (sourcePath === undefined) return href;

  const aliases = [
    ["platform/builder-canvas", "platform/builder"],
    ["platform/widgets/basic-widgets", "platform/widgets/basic"],
    ["platform/widgets/media-widgets", "platform/widgets/media"],
    ["platform/widgets/lead-generation-widgets", "platform/widgets/lead-generation"],
    ["platform/widgets/store-widgets", "platform/widgets/store"],
    ["platform/widgets/other-widgets", "platform/widgets/other"],
  ];
  for (const [oldPrefix, newPrefix] of aliases) {
    if (sourcePath === oldPrefix || sourcePath.startsWith(`${oldPrefix}/`)) {
      sourcePath = `${newPrefix}${sourcePath.slice(oldPrefix.length)}`;
      break;
    }
  }
  if (sourcePath && !knownSourcePaths.has(sourcePath)) return `/builder/${sourcePath}${suffix}`;
  return sourcePath ? `/builder/${sourcePath}${suffix}` : `/builder${suffix}`;
}

function convertCardTables(markdown) {
  const funnelTargets = new Map([
    ["lead gen funnel", "/builder/funnel-designs/types-of-funnels/lead-generation"],
    ["webinar funnel", "/builder/funnel-designs/types-of-funnels/webinar"],
    ["digital download funnel", "/builder/funnel-designs/types-of-funnels/digital-download-funnel"],
    ["online summit funnel", "/builder/funnel-designs/types-of-funnels/summit-funnel"],
    ["online course funnel", "/builder/funnel-designs/types-of-funnels/online-course-funnel"],
    ["membership funnel", "/builder/funnel-designs/types-of-funnels/membership-funnel"],
    ["opt-in funnel", "/builder/funnel-designs/types-of-funnels/opt-in"],
    ["onboarding funnel", "/builder/funnel-designs/types-of-funnels/onboarding"],
    ["hero funnel", "/builder/funnel-designs/types-of-funnels/hero"],
    ["booking funnel", "/builder/funnel-designs/types-of-funnels/appointment-booking"],
  ]);

  return markdown.replace(/<table\s+data-view="cards"[^>]*>[\s\S]*?<\/table>/gi, (table) => {
    const cards = [];
    for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
      if (!cells.length) continue;
      const title = stripMarkdown(cells[0]);
      const image = row[1].match(/\/files\/[A-Za-z0-9_-]+/)?.[0];
      const target = funnelTargets.get(title.toLowerCase());
      if (!title || !image || !target) continue;
      cards.push(`<Card title="${title}" href="${target}">\n![${title}](${image})\n</Card>`);
    }
    return cards.length ? `<CardGroup cols={2}>\n${cards.join("\n")}\n</CardGroup>` : table;
  });
}

function convertGitBookMarkup(markdown, knownSourcePaths) {
  let content = convertCardTables(markdown.replace(/\r\n/g, "\n"));
  content = content.replace(/^> For the complete documentation index[^\n]*\n+/i, "");
  content = content.replace(/\{% content-ref[^%]*%\}\s*([\s\S]*?)\s*\{% endcontent-ref %\}/g, "$1");
  content = content.replace(/\{% hint style="([^"]+)" %\}([\s\S]*?)\{% endhint %\}/g, (_, style, body) => {
    const component = style === "success" ? "Tip" : style === "warning" ? "Warning" : "Note";
    return `\n<${component}>\n${body.trim()}\n</${component}>\n`;
  });
  content = content
    .replace(/\{% tabs %\}/g, "<Tabs>")
    .replace(/\{% endtabs %\}/g, "</Tabs>")
    .replace(/\{% tab title="([^"]+)" %\}/g, '<Tab title="$1">')
    .replace(/\{% endtab %\}/g, "</Tab>");
  content = content.replace(/\{% embed url="<?([^">]+)>?" %\}/g, "[Watch the video]($1)");
  content = content.replace(/<a\s+href="#[^"]+"\s+id="[^"]+"><\/a>/gi, "");
  content = content.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  content = content.replace(/<\/?(?:figure|figcaption|div)(?:\s+[^>]*)?>/gi, "");
  content = content.replace(/<br\s*\/?\s*>/gi, "<br />");
  content = content.replace(/<mark(?:\s+[^>]*)?>([\s\S]*?)<\/mark>/gi, "$1");
  content = content.replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**");
  content = content.replace(/<i>([\s\S]*?)<\/i>/gi, "*$1*");
  content = content.replace(/<p>\s*<\/p>/gi, "");
  content = decodeEntities(content);
  content = content.replace(/\]\((https?:\/\/buildersupport\.gitbook\.io\/(?:help-docs|hub)[^)]+|\/(?:help-docs|hub)\/[^)]+)\)/g,
    (_, href) => `](${convertInternalHref(href, knownSourcePaths)})`);
  content = content.replace(/\n{3,}/g, "\n\n").trim();
  return content;
}

function extractTitleAndBody(markdown, sourcePath) {
  const heading = markdown.match(/^#\s+(.+)$/m);
  const title = stripMarkdown(heading?.[1] || titleCaseSlug(sourcePath.split("/").at(-1) || "Welcome"));
  const body = heading ? `${markdown.slice(0, heading.index)}${markdown.slice(heading.index + heading[0].length)}`.trim() : markdown.trim();
  return { title, body };
}

function extensionFor(contentType, url) {
  const byType = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
  };
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (byType[mediaType]) return byType[mediaType];
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"].includes(extension)) {
      return extension === ".jpeg" ? ".jpg" : extension;
    }
  } catch {
    // Fall back below.
  }
  return ".png";
}

async function downloadAsset(asset) {
  const hash = createHash("sha1").update(asset.key).digest("hex").slice(0, 16);
  const existing = (await readdir(IMAGE_DIR)).find((filename) => filename.startsWith(`${hash}.`));
  if (existing) return `/images/builder/${existing}`;

  let response;
  try {
    response = await fetchResponse(asset.target);
  } catch (targetError) {
    if (!asset.proxy) throw targetError;
    response = await fetchResponse(asset.proxy);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`Expected image content but received ${contentType || "an unknown type"}`);
  }
  const extension = extensionFor(contentType, asset.target);
  const filename = `${hash}${extension}`;
  await writeFile(path.join(IMAGE_DIR, filename), Buffer.from(await response.arrayBuffer()));
  return `/images/builder/${filename}`;
}

function applyImageReplacements(page, assetRoutes) {
  let content = page.body;
  for (const token of [...page.imageTokens].reverse()) {
    if (!token.assetKey || !assetRoutes.has(token.assetKey)) continue;
    const alt = token.alt.replace(/\]/g, "\\]");
    const replacement = `![${alt}](${assetRoutes.get(token.assetKey)})`;
    content = `${content.slice(0, token.start)}${replacement}${content.slice(token.end)}`;
  }
  return content;
}

function buildTrie(pages) {
  const root = { slug: "", children: new Map(), page: null };
  for (const page of pages.filter((item) => item.sourcePath)) {
    let node = root;
    for (const segment of page.sourcePath.split("/")) {
      if (!node.children.has(segment)) node.children.set(segment, { slug: segment, children: new Map(), page: null });
      node = node.children.get(segment);
    }
    node.page = page;
  }
  return root;
}

function navEntry(node) {
  const children = [...node.children.values()].map(navEntry);
  if (node.page && children.length === 0) return node.page.localRoute;
  const entry = {
    group: node.page?.title || titleCaseSlug(node.slug),
    pages: children,
  };
  if (node.page) entry.root = node.page.localRoute;
  return entry;
}

function nodeEntries(node) {
  return node ? [...node.children.values()].map(navEntry) : [];
}

function buildBuilderGroups(trie) {
  const rootChildren = trie.children;
  const communitySegments = ["community-lms", "circles", "access-levels", "content-availability", "community-widgets", "community-notifications"];
  const videoSegments = ["video", "video-automation"];
  const consumed = new Set(["platform", ...communitySegments, ...videoSegments, "blog", "funnel-designs", "internal-integrations", "other"]);

  const groups = [
    { group: "Start here", pages: ["builder"] },
    { group: "Platform", pages: nodeEntries(rootChildren.get("platform")) },
    { group: "Community & LMS", pages: communitySegments.flatMap((segment) => {
      const node = rootChildren.get(segment);
      return node ? [navEntry(node)] : [];
    }) },
    { group: "Video", pages: videoSegments.flatMap((segment) => {
      const node = rootChildren.get(segment);
      return node ? [navEntry(node)] : [];
    }) },
    { group: "Blog", pages: nodeEntries(rootChildren.get("blog")) },
    { group: "Funnel designs", pages: nodeEntries(rootChildren.get("funnel-designs")) },
    { group: "Integrations", pages: nodeEntries(rootChildren.get("internal-integrations")) },
    { group: "Other", pages: nodeEntries(rootChildren.get("other")) },
  ].filter((group) => group.pages.length > 0);

  const remaining = [...rootChildren.entries()]
    .filter(([segment]) => !consumed.has(segment))
    .map(([, node]) => navEntry(node));
  if (remaining.length) groups.push({ group: "More", pages: remaining });
  return groups;
}

function collectNavRoutes(value, routes = []) {
  if (typeof value === "string") routes.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectNavRoutes(item, routes));
  else if (value && typeof value === "object") {
    if (value.root) routes.push(value.root);
    if (value.pages) collectNavRoutes(value.pages, routes);
  }
  return routes;
}

async function main() {
  await mkdir(IMAGE_DIR, { recursive: true });
  const sitemap = await fetchText(SITEMAP_URL);
  const sourceUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => decodeEntities(match[1]));
  const knownSourcePaths = new Set(sourceUrls.map(sourcePathFromUrl));

  const fetchedPages = await mapConcurrent(sourceUrls, PAGE_CONCURRENCY, async (sourceUrl, index) => {
    try {
      const markdownUrl = sourceUrl === SOURCE_ROOT ? SOURCE_ROOT : `${sourceUrl}.md`;
      const [markdown, html] = await Promise.all([
        fetchText(markdownUrl, { headers: { accept: "text/markdown" } }),
        fetchText(sourceUrl, { headers: { accept: "text/html" } }),
      ]);
      if (/^# Page Not Found/m.test(markdown)) throw new Error("GitBook returned a Page Not Found document");
      const sourcePath = sourcePathFromUrl(sourceUrl);
      const initial = convertGitBookMarkup(markdown, knownSourcePaths);
      const { title, body } = extractTitleAndBody(initial, sourcePath);
      const page = {
        sourceUrl,
        sourcePath,
        localRoute: localRouteForSourcePath(sourcePath),
        title,
        body,
        imageTokens: extractImageTokens(body),
        assets: new Map(),
      };
      matchImages(page, extractRenderedImageCandidates(html));
      process.stdout.write(`Fetched ${index + 1}/${sourceUrls.length}: ${sourcePath || "welcome"}\n`);
      return page;
    } catch (error) {
      pageErrors.push({ sourceUrl, error: error.message });
      return null;
    }
  });

  const pages = fetchedPages.filter(Boolean);
  const uniqueAssets = new Map();
  for (const page of pages) {
    for (const [key, asset] of page.assets) if (!uniqueAssets.has(key)) uniqueAssets.set(key, asset);
  }

  const assetRoutes = new Map();
  await mapConcurrent([...uniqueAssets.values()], IMAGE_CONCURRENCY, async (asset, index) => {
    try {
      assetRoutes.set(asset.key, await downloadAsset(asset));
      process.stdout.write(`Downloaded image ${index + 1}/${uniqueAssets.size}\n`);
    } catch (error) {
      imageErrors.push({ url: asset.target, error: error.message });
    }
  });

  for (const page of pages) {
    let body = applyImageReplacements(page, assetRoutes);
    body = convertGitBookMarkup(body, knownSourcePaths);
    const description = descriptionFor(body, page.title);
    const frontmatter = [
      "---",
      `title: ${yamlString(page.title)}`,
      `description: ${yamlString(description)}`,
      `source: ${yamlString(page.sourceUrl)}`,
      "---",
      "",
    ].join("\n");
    const outputPath = path.join(PROJECT_ROOT, `${page.localRoute}.mdx`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${frontmatter}${body}\n`, "utf8");
  }

  const docsPath = path.join(PROJECT_ROOT, "docs.json");
  const docs = JSON.parse(await readFile(docsPath, "utf8"));
  const builderTab = docs.navigation.tabs.find((tab) => tab.tab === "Builder");
  if (!builderTab) throw new Error("Could not find the Builder tab in docs.json");
  const trie = buildTrie(pages);
  builderTab.groups = buildBuilderGroups(trie);
  builderTab.directory = "card";
  await writeFile(docsPath, `${JSON.stringify(docs, null, 2)}\n`, "utf8");

  const navRoutes = collectNavRoutes(builderTab.groups);
  const pageRoutes = pages.map((page) => page.localRoute);
  const missingFromNav = pageRoutes.filter((route) => !navRoutes.includes(route));
  const duplicateNavRoutes = navRoutes.filter((route, index) => navRoutes.indexOf(route) !== index);
  const report = {
    source: SOURCE_ROOT,
    migratedAt: new Date().toISOString(),
    pageCount: pages.length,
    imageCount: assetRoutes.size,
    pageErrors,
    unresolvedImages,
    imageErrors,
    missingFromNav,
    duplicateNavRoutes: [...new Set(duplicateNavRoutes)],
  };
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (pageErrors.length || unresolvedImages.length || imageErrors.length || missingFromNav.length || duplicateNavRoutes.length) {
    process.exitCode = 1;
  }
}

await main();
