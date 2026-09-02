import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const compilerPath = process.argv[2];
if (!compilerPath) throw new Error("Pass the absolute path to @mdx-js/mdx/index.js");
const { compile } = await import(pathToFileURL(compilerPath).href);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.name.endsWith(".mdx")) files.push(target);
  }
  return files;
}

const root = process.cwd();
const files = [path.join(root, "builder.mdx"), ...await walk(path.join(root, "builder"))];
const errors = [];

for (const file of files) {
  const source = await readFile(file, "utf8");
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "");
  try {
    await compile(body, { format: "mdx", development: false });
  } catch (error) {
    errors.push({
      file: path.relative(root, file).replace(/\\/g, "/"),
      line: error.line || error.position?.start?.line || null,
      message: error.reason || error.message,
    });
  }
}

console.log(JSON.stringify({ pages: files.length, errors }, null, 2));
if (errors.length) process.exitCode = 1;
