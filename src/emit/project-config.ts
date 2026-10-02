/**
 * The consuming project's own `"xanosdk"` block — where a toolchain module's
 * per-project configuration lives between `init` and every later `deploy`.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *
 * In the PROJECT's `package.json`, namespaced by package name:
 *
 *     "xanosdk": {
 *       "@acme/reviewable": { "enabled": true, "dir": "rendered" }
 *     }
 *
 * ── Why this key, and why that is a little confusing ────────────────────────
 *
 * The same `"xanosdk"` key means two different things depending on whose
 * `package.json` it is in. In a PUBLISHED MODULE it is the module describing
 * itself — `kind`, `plugin`, `register`. In a CONSUMING PROJECT it is this: a
 * map from package name to that module's settings.
 *
 * Sharing the key is a documentation cost taken deliberately. The alternative
 * is a second top-level field that means almost the same thing, and the two
 * schemas never collide in practice — a project is not a published module, and
 * `moduleKind()` reads the module side correctly either way because a package
 * name is never one of the fields it looks at.
 *
 * ── Failure posture ─────────────────────────────────────────────────────────
 *
 * A corrupt or absent block yields `null` rather than throwing, following
 * `readMarker` in `scaffold.ts`. A project whose `package.json` cannot be
 * parsed has a much larger problem than its plugin config, and npm will say so
 * far more usefully than this file could.
 *
 * ── Who WRITES it ──────────────────────────────────────────────────────────
 *
 * Two writers now, and they write the same key for different reasons.
 *
 * `init` folds each module's block into the manifest it RENDERS
 * (`withXanoSdkBlock` in `init-command.ts`), and the scaffold's two-pass merge
 * carries it across — composed as part of a file written from scratch.
 *
 * {@link writeToolchainConfig} is the other: the reconciler PATCHES the key in
 * a manifest that already exists, because a module can arrive long after the
 * scaffold — `marketplace install`, a plain `npm install`, a merged PR. It
 * rewrites one key and preserves every other byte it can: key order, indent,
 * and the trailing newline.
 *
 * They do not race. `init` owns a manifest it just rendered; the reconciler
 * owns one it just read. What they share is the rule below.
 *
 * ── The rule both writers obey ─────────────────────────────────────────────
 *
 * A run only knows about the modules it loaded THIS time, so what the project
 * already stored has to be read back — {@link readToolchainBlock} — and merged
 * in by package name, the writing side winning only for the packages it
 * actually names. Anything less deletes another module's settings, and an
 * `enabled: false` deleted is an `enabled: false` reversed, because absent
 * config reads as enabled.
 *
 * Node-only; reached from the toolchain loader, from `init`, and from the
 * reconciler.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertWritable, atomicWrite } from "../util/atomic-write.js";

/**
 * The SDK's own package name, as a key of the project's `"xanosdk"` block.
 *
 * The block is a map from package name to settings, and the SDK stores its own
 * there too — the local-engine version pin (`src/deploy/local-engine-pin.ts`).
 * That entry is NOT a toolchain module's config, so every reader that treats a
 * key as "a module is expected" has to skip it, and every pass that drops keys
 * for packages no longer depended on has to keep it: a globally installed SDK
 * is not a dependency, and its pin still is the project's engine version.
 */
export const SDK_PACKAGE = "@xano/sdk";

/** One module's settings, as the project recorded them. */
export type ToolchainConfig = Readonly<Record<string, unknown>>;

/**
 * The project's `package.json`, parsed, or null when it cannot be read.
 *
 * Exported so the toolchain loader reads the project manifest through the same
 * function this file does, rather than a third opinion about what counts as one
 * — and so a command can parse it ONCE and pass it to every reader below.
 */
export function readProjectManifest(
  projectDir: string,
): Record<string, unknown> | null {
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Every package the project DEPENDS ON, in declaration order.
 *
 * THE one definition of "depended on", and it has to be: discovery loads a
 * module because this says the project depends on it, and the reconciler drops
 * a package's block and config because this says it no longer does. Two
 * readings would let a module be loaded and configured on one pass and deleted
 * on the next — `marketplace remove`'s whole design rests on the two agreeing.
 *
 * A Set, because a package listed in BOTH maps is legal JSON and a common state
 * after moving a dependency between them and forgetting to delete the old
 * entry. Loaded twice it would fire every hook twice — a tree write applied
 * twice, with no idempotency contract — and during `init` the second pass would
 * find the flag already consumed and overwrite the user's answer with the
 * module's default. `parseMarketplaceFlag` de-duplicates for the same reason.
 *
 * Order is kept and is cheap to keep: two modules contributing to the same file
 * produce their lines in the order the project lists them, which is stable
 * across runs and matches what a reader would expect.
 *
 * Takes the ALREADY-PARSED manifest rather than a directory, so one command
 * reads the project's `package.json` once instead of once per reader.
 */
export function declaredDependencies(
  manifest: Record<string, unknown>,
): readonly string[] {
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = manifest[field];
    if (typeof deps === "object" && deps !== null && !Array.isArray(deps)) {
      for (const name of Object.keys(deps as Record<string, unknown>))
        names.add(name);
    }
  }
  return [...names];
}

/**
 * Every package name the project's `"xanosdk"` block configures.
 *
 * The loader uses this to tell an uninstalled TOOLCHAIN module from an ordinary
 * dependency that is not one: only a toolchain module ever gets a block here,
 * so a name in it is the project saying one is expected. Without that, a
 * configured module that is not installed is indistinguishable from any other
 * missing package, and its check vanishes silently.
 *
 * {@link SDK_PACKAGE} is left out: its entry holds the SDK's own settings, and
 * an SDK that is not installed locally is not a missing toolchain module.
 */
export function configuredPackages(
  projectDir: string,
  parsed?: Record<string, unknown> | null,
): readonly string[] {
  const manifest =
    parsed !== undefined ? parsed : readProjectManifest(projectDir);
  if (manifest === null) return [];
  const block = manifest["xanosdk"];
  if (typeof block !== "object" || block === null || Array.isArray(block))
    return [];
  return Object.keys(block as Record<string, unknown>).filter(
    (pkg) => pkg !== SDK_PACKAGE,
  );
}

/**
 * One module's config block, or `null` when the project records none.
 *
 * `null` and `{}` are deliberately different answers. `{}` is a project that
 * configured the module and gave it nothing; `null` is a project that never
 * mentioned it. Only the second should fall back to a module's own defaults.
 */
export function readToolchainConfig(
  projectDir: string,
  pkg: string,
  parsed?: Record<string, unknown> | null,
): ToolchainConfig | null {
  // `parsed` lets a caller that already read the manifest skip a second read.
  // Discovery does: it reads the file once for the dependency list and would
  // otherwise re-read and re-parse it per toolchain module.
  const manifest =
    parsed !== undefined ? parsed : readProjectManifest(projectDir);
  if (manifest === null) return null;
  const block = manifest["xanosdk"];
  if (typeof block !== "object" || block === null || Array.isArray(block))
    return null;
  const own = (block as Record<string, unknown>)[pkg];
  if (typeof own !== "object" || own === null || Array.isArray(own))
    return null;
  return own as ToolchainConfig;
}

/**
 * The whole `"xanosdk"` block — every package's settings, as the project
 * recorded them — or `{}` when there is none to read.
 *
 * The per-package readers above answer "what did the project choose for THIS
 * module"; this answers "what has the project chosen at all", which is the
 * question a WRITER has to ask. `init --force` rewrites `package.json` from a
 * template that carries no block of its own, so without reading the whole thing
 * first it would publish only the modules that happened to load on that run and
 * silently drop every other package's settings.
 *
 * `{}` rather than `null`: a caller merging over this wants a map either way,
 * and there is nothing a writer would do differently for "absent" than for
 * "empty" — unlike {@link readToolchainConfig}, where the distinction decides
 * whether a module falls back to its own defaults.
 */
export function readToolchainBlock(
  projectDir: string,
  parsed?: Record<string, unknown> | null,
): Readonly<Record<string, unknown>> {
  const manifest =
    parsed !== undefined ? parsed : readProjectManifest(projectDir);
  if (manifest === null) return {};
  const block = manifest["xanosdk"];
  if (typeof block !== "object" || block === null || Array.isArray(block))
    return {};
  return block as Record<string, unknown>;
}

/**
 * Compose the next `package.json` text with `block` as its `"xanosdk"` value.
 *
 * Pure, and separate from the write so a caller can decide the whole next state
 * of several files before touching any of them.
 *
 * What survives, and why each one is listed rather than hoped for: KEY ORDER
 * (`JSON.parse`/`stringify` preserve insertion order, and re-assigning an
 * existing key does not move it — only a new `"xanosdk"` is appended, at the
 * end); the INDENT the file already uses, sniffed rather than assumed, because
 * rewriting a two-space manifest as four turns a one-key change into a
 * whole-file diff; the TRAILING NEWLINE, present or absent; and the LINE
 * ENDINGS, because `JSON.stringify` emits LF unconditionally and a CRLF
 * manifest rewritten wholly to LF is that same whole-file diff in its loudest
 * form. `upsertBlock` — the other writer this one reconcile runs — has always
 * preserved them, and two writers must not disagree about one file the user
 * owns.
 *
 * An EMPTY block deletes the key rather than writing `"xanosdk": {}`. The last
 * module removed from a project should leave a manifest that looks like one
 * that never had any.
 */
export function composeToolchainConfig(
  raw: string,
  block: Readonly<Record<string, unknown>>,
): string {
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  if (Object.keys(block).length === 0) delete manifest["xanosdk"];
  else manifest["xanosdk"] = block;
  const trailing = /(?:\r?\n)*$/.exec(raw)?.[0] ?? "";
  const next =
    JSON.stringify(manifest, null, detectIndent(raw)) +
    (trailing === "" ? "" : trailing);
  // Any CRLF makes it a CRLF file — the same rule `detectEol` applies in
  // `managed-blocks.ts`, so the two writers cannot read one file two ways.
  return raw.includes("\r\n") ? next.replace(/\r?\n/g, "\r\n") : next;
}

/**
 * The indent the manifest already uses — the whitespace before its first
 * nested key. Two spaces when there is nothing to read, matching npm's own.
 */
function detectIndent(raw: string): string | number {
  const match = /\{[^\n]*\r?\n([ \t]+)"/.exec(raw);
  return match?.[1] ?? 2;
}

/**
 * Write the project's whole `"xanosdk"` block, replacing what is there.
 *
 * Returns whether anything was written. An unchanged manifest is NOT rewritten:
 * the reconciler runs on every install and re-running it must not bump an
 * mtime, which is how a tool earns a place in someone's `.gitignore` and how a
 * repository fills with no-op commits.
 *
 * `block` is the WHOLE key, not a patch — merging by package name is the
 * caller's job, because only the caller knows which packages this run actually
 * reconciled and which it must carry forward untouched.
 *
 * Refuses rather than guessing when the manifest is absent or unparseable: this
 * is a writer, and the reader's null-over-throw posture would silently create a
 * `package.json` out of thin air or overwrite one somebody is mid-edit on.
 */
export function writeToolchainConfig(
  projectDir: string,
  block: Readonly<Record<string, unknown>>,
): boolean {
  const path = join(projectDir, "package.json");
  const raw = readFileSync(path, "utf8");
  const next = composeToolchainConfig(raw, block);
  if (next === raw) return false;
  // Atomic, like the reconciler's other target: a manifest torn by a crash
  // mid-write is not merely stale, it is unparseable — and npm, the reconciler
  // and every later `deploy` all refuse a manifest they cannot parse. The
  // permission check is explicit because rename asks the DIRECTORY rather than
  // the file, so a read-only manifest would otherwise be replaced in silence.
  assertWritable(path);
  atomicWrite(path, next);
  return true;
}
