import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const builderDir = path.join(root, "builder");
const errors = [];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

function collectRoutes(value, routes = []) {
  if (typeof value === "string") routes.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectRoutes(item, routes));
  else if (value && typeof value === "object") {
    if (value.root) routes.push(value.root);
    if (value.pages) collectRoutes(value.pages, routes);
  }
  return routes;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const docs = JSON.parse(await readFile(path.join(root, "docs.json"), "utf8"));
const builderTab = docs.navigation.tabs.find((tab) => tab.tab === "Builder");
if (!builderTab) throw new Error("Builder tab not found in docs.json");

const nestedPages = (await walk(builderDir)).filter((file) => file.endsWith(".mdx"));
const pageFiles = [path.join(root, "builder.mdx"), ...nestedPages];
const pageRoutes = pageFiles.map((file) => path.relative(root, file).replace(/\\/g, "/").replace(/\.mdx$/, ""));
const routeSet = new Set(pageRoutes);
const navRoutes = collectRoutes(builderTab.groups);

for (const route of pageRoutes) {
  if (!navRoutes.includes(route)) errors.push(`Page missing from Builder navigation: ${route}`);
}
for (const route of navRoutes) {
  if (!routeSet.has(route)) errors.push(`Builder navigation points to a missing page: ${route}`);
}
for (const route of new Set(navRoutes)) {
  if (navRoutes.filter((item) => item === route).length > 1) errors.push(`Duplicate Builder navigation route: ${route}`);
}

let imageReferences = 0;
const referencedImages = new Set();
for (const file of pageFiles) {
  const content = await readFile(file, "utf8");
  const relative = path.relative(root, file).replace(/\\/g, "/");
  if (!/^---\n[\s\S]*?\n---\n/.test(content)) errors.push(`Missing or malformed frontmatter: ${relative}`);
  if (/\{%|\{% end|\/files\/|<\/?(?:figure|figcaption)\b|<img\b/i.test(content)) {
    errors.push(`Unconverted GitBook markup remains in ${relative}`);
  }

  for (const match of content.matchAll(/!\[[^\]]*\]\((\/images\/builder\/[^)]+)\)/g)) {
    imageReferences += 1;
    referencedImages.add(match[1]);
    const imagePath = path.join(root, ...match[1].slice(1).split("/"));
    if (!await exists(imagePath)) errors.push(`Missing image ${match[1]} referenced by ${relative}`);
    else if ((await stat(imagePath)).size === 0) errors.push(`Empty image file ${match[1]} referenced by ${relative}`);
  }

  for (const match of content.matchAll(/\]\((\/builder(?:\/[^)#?\s]+)?)(?:[?#][^)]*)?\)/g)) {
    const route = match[1].replace(/\/$/, "");
    if (!routeSet.has(route.slice(1))) errors.push(`Broken Builder link ${route} in ${relative}`);
  }
}

const imageFiles = (await walk(path.join(root, "images", "builder"))).filter((file) => !file.endsWith(".gitkeep"));
const report = {
  pages: pageFiles.length,
  navigationRoutes: navRoutes.length,
  imageReferences,
  uniqueReferencedImages: referencedImages.size,
  imageFiles: imageFiles.length,
  errors,
};

console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
