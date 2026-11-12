#!/usr/bin/env node
/**
 * `prepack` guard: refuse to pack a `dist/` that is incomplete or stale.
 *
 * Two builds racing in one checkout once produced a tarball with no `.d.ts`
 * files — every consumer lost its types, and nothing said so until install.
 * This checks the files `package.json` promises (every `exports` target, `main`,
 * `types`, `bin`) exist and are non-empty, and that nothing in `src/` is newer
 * than the oldest of them. Plain Node, no build step: it runs in well under a
 * second, so it can sit in front of every `npm pack` / `npm publish`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Every `./dist/…` path the manifest names. */
function promised() {
  const out = new Set();
  const visit = (v) => {
    if (typeof v === "string") {
      if (v.startsWith("./dist/")) out.add(v);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) visit(x);
    }
  };
  visit(pkg.exports);
  visit(pkg.main);
  visit(pkg.types);
  visit(pkg.bin);
  return [...out].sort();
}

/** The newest modification time under `dir`, and the file that has it. */
function newest(dir) {
  let best = { mtime: 0, file: "" };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const found = entry.isDirectory() ? newest(path) : { mtime: statSync(path).mtimeMs, file: path };
    if (found.mtime > best.mtime) best = found;
  }
  return best;
}

const problems = [];
let oldest = Infinity;
for (const rel of promised()) {
  const path = join(root, rel);
  if (!existsSync(path)) {
    problems.push(`${rel} is missing`);
    continue;
  }
  const stat = statSync(path);
  if (stat.size === 0) problems.push(`${rel} is empty`);
  oldest = Math.min(oldest, stat.mtimeMs);
}
if (problems.length === 0) {
  const src = newest(join(root, "src"));
  if (src.mtime > oldest) problems.push(`${src.file.slice(root.length + 1)} is newer than the build`);
}

if (problems.length > 0) {
  process.stderr.write(
    `prepack: dist/ is not fit to pack — ${problems.join("; ")}.\n` +
      `Run \`npm run build\` (one build at a time) and pack again.\n`,
  );
  process.exit(1);
}
