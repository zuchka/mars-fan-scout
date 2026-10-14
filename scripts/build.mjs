import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { transform } from "esbuild";

const roots = ["public", "scout", "review-agent", "cloudflare"];
const sources = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.m?ts$/.test(entry.name)) sources.push(path);
  }
}

for (const root of roots) await collect(root);
for (const path of ["server.mts", "demo-access.mts"]) {
  try {
    await access(path);
    sources.push(path);
  } catch { /* The runtime entry points are migrated in later commits. */ }
}
for (const source of sources) {
  const output = source.replace(/\.mts$/, ".mjs").replace(/\.ts$/, ".js");
  const input = await readFile(source, "utf8");
  const compiled = await transform(input, {
    sourcefile: source,
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  await writeFile(output, compiled.code);
}
console.log(`Built ${sources.length} TypeScript modules`);
