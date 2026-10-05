/**
 * Reading an installed `@xano-sdk/*` package's own `package.json`, and the one
 * question that decides which loader gets it.
 *
 * ── Why this is its own file ────────────────────────────────────────────────
 *
 * There are two kinds of module, and they have nothing in common except how
 * they are found on disk. A WORKSPACE module (`@xano-sdk/auth`, `@xano-sdk/chatbot`)
 * adds tables and endpoints to the deployed bundle and is registered into the
 * user's `xano/index.ts`. A TOOLCHAIN module extends the CLI itself — it
 * contributes questions to `init`, fragments to the scaffold, and hooks that
 * fire on `export`, `deploy` and `preflight` — and adds nothing to the
 * workspace at all.
 *
 * Both are npm packages under the project's `dependencies`, both describe
 * themselves in a `"xanosdk"` field, and both have to be located inside
 * `node_modules` and read before anything can be said about them. That shared
 * half lives here so `init-modules.ts` (workspace) and `toolchain-modules.ts`
 * (toolchain) resolve a package the same way rather than two ways that drift.
 *
 * ── Why the discriminator has to exist ──────────────────────────────────────
 *
 * Without it, `readRegistration` hunts a toolchain module for a `register*`
 * export, finds none — correctly, because there is nothing to register — and
 * reports the package as unwired. That warning is not a degraded answer, it is
 * a false one: it tells the user their module failed to install correctly when
 * it is working exactly as designed. `kind` is what makes the two loaders able
 * to ignore each other's packages.
 *
 * Node-only; reached from the two loaders, which the CLI imports lazily.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { UsageError } from "./errors.js";
import { byCodeUnit } from "../util/code-unit.js";

/**
 * Which loader owns a module.
 *
 * `workspace` is the default for a reason beyond convention: every module
 * published before the toolchain kind existed is a workspace module, and none
 * of them declare a `kind`. Defaulting the other way would strand them.
 */
export type ModuleKind = "workspace" | "toolchain";

/** The kinds `moduleKind` accepts, in the order an error message lists them. */
const MODULE_KINDS: readonly ModuleKind[] = ["workspace", "toolchain"];

/**
 * The package NAME npm will have written into `dependencies`, recovered from
 * the specifier that was typed.
 *
 * `@scope/name@1.2.3` → `@scope/name`. Only the version/tag suffix is stripped,
 * and only when it is not the leading `@` of a scope: `@xano-sdk/auth@next` is the
 * package `@xano-sdk/auth`, while `@xano-sdk/auth` is already the name. Anything
 * else — `file:../local`, a tarball URL, a git spec — comes back unchanged and
 * simply will not resolve, which is the right outcome: guessing a name out of
 * an arbitrary specifier, to then read a manifest or print a sentence about it,
 * is not worth being wrong. The specifier is npm's business, not ours.
 *
 * Here rather than at either caller because both `init --marketplace` and
 * `marketplace install` recover the same name to read the same manifest through
 * {@link readInstalledManifestState}, and two copies of this rule would let one
 * of them classify a package the other could not find.
 */
export function packageNameOf(specifier: string): string {
  const at = specifier.lastIndexOf("@");
  return at > 0 ? specifier.slice(0, at) : specifier;
}

/** The path a local specifier names (`./m`, `file:../m`, `m.tgz`), or undefined for a name, URL or git spec. */
export function localPathOf(spec: string): string | undefined {
  if (/^file:/i.test(spec)) return spec.slice(5);
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith("~")) return undefined;
  if (/^\.{1,2}(\/|$)|^\//.test(spec) || /\.(tgz|tar\.gz)$/i.test(spec)) return spec;
  return undefined;
}

/**
 * The package name a local specifier (`./m`, `file:../m`, `./m-1.0.0.tgz`, an
 * absolute path) holds — read from the directory's package.json, or from the
 * tarball's — resolved against `dir`, the directory the specifier is relative
 * to. A path no longer on disk is the dependency `dir`'s package.json records
 * as `file:` that path. Undefined for anything else.
 */
export function localPackageName(specifier: string, dir: string): string | undefined {
  const path = localPathOf(specifier);
  if (path === undefined) return undefined;
  const abs = resolve(dir, path);
  try {
    const raw = statSync(abs).isFile() ? tarballManifest(readFileSync(abs)) : readFileSync(join(abs, "package.json"), "utf8");
    const name = raw === undefined ? undefined : (JSON.parse(raw) as { name?: unknown }).name;
    if (typeof name === "string" && name !== "") return name;
  } catch {
    // Not on disk, or not a package: the recorded dependency may still name it.
  }
  return recordedLocalDependency(dir, abs);
}

/** The dependency `dir`'s package.json records as `file:` the path `abs`. */
function recordedLocalDependency(dir: string, abs: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    for (const block of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries((manifest[block] as Record<string, unknown> | undefined) ?? {})) {
        if (typeof range === "string" && /^file:/i.test(range) && resolve(dir, range.slice(5)) === abs) return name;
      }
    }
  } catch {
    // No readable manifest: nothing recorded.
  }
  return undefined;
}

/**
 * The text of the top-level `package.json` in a package tarball (gzipped tar,
 * as `npm pack` writes it: `package/package.json`), or undefined when it has none.
 */
export function tarballManifest(tgz: Buffer): string | undefined {
  const tar = gunzipSync(tgz);
  let longName: string | undefined;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) return undefined;
    const field = (start: number, length: number): string => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? length : end).toString("utf8");
    };
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = longName ?? (prefix === "" ? field(0, 100) : `${prefix}/${field(0, 100)}`);
    const body = tar.subarray(at + 512, at + 512 + size);
    longName = type === "L" ? body.toString("utf8").replace(/\0+$/, "") : undefined;
    if ((type === "0" || type === "") && /^[^/]+\/package\.json$/.test(name.replace(/^\.\//, ""))) return body.toString("utf8");
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/**
 * What reading an installed package's manifest found.
 *
 * `absent` and `unreadable` are kept apart because they mean opposite things to
 * a guard. A package that is not in `node_modules` was never installed and
 * there is nothing to check. A package whose `package.json` is ON DISK but does
 * not parse is a BROKEN install — a partial `npm install`, an interrupted
 * download — and it is exactly the state in which a toolchain module silently
 * stops running. Collapsing the two to `null` makes the second indistinguishable
 * from "not a module of ours", which is how a check disappears without a word.
 */
export type InstalledManifest =
  | { readonly kind: "ok"; readonly manifest: Record<string, unknown> }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly why: string };

/**
 * Where a package's own `package.json` actually is, from the project's point of
 * view.
 *
 * Node's resolver first, the literal `node_modules/<pkg>` path second. The
 * literal path alone is wrong in every hoisted layout — an npm/yarn workspace
 * lifts a shared dependency to the REPO ROOT's `node_modules`, and pnpm links
 * it — so a package that is installed and importable would read as absent, and
 * a guard that depends on finding it would quietly stop running.
 *
 * The fallback matters too: a package whose `exports` map does not expose
 * `./package.json` cannot be resolved this way even when it is right there.
 */
function manifestPathOf(dir: string, pkg: string): string | null {
  try {
    return createRequire(join(dir, "package.json")).resolve(`${pkg}/package.json`);
  } catch {
    const literal = join(dir, "node_modules", ...pkg.split("/"), "package.json");
    return existsSync(literal) ? literal : null;
  }
}

/** The directory the project resolves `pkg` to, or null when it is not installed. */
export function installedPackageDir(dir: string, pkg: string): string | null {
  const path = manifestPathOf(dir, pkg);
  return path === null ? null : dirname(path);
}

/** The installed package's manifest, with the two failure modes kept apart. */
export function readInstalledManifestState(dir: string, pkg: string): InstalledManifest {
  const path = manifestPathOf(dir, pkg);
  if (path === null) return { kind: "absent" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unreadable", why: `${path} is not a JSON object` };
    }
    return { kind: "ok", manifest: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      kind: "unreadable",
      why: `${path} could not be parsed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/**
 * The installed package's manifest, or null when it could not be read either
 * way.
 *
 * The lossy form, kept for the workspace loader, which reports an unreadable
 * module through its own `unwired` channel rather than a guard.
 */
export function readInstalledManifest(dir: string, pkg: string): Record<string, unknown> | null {
  const state = readInstalledManifestState(dir, pkg);
  return state.kind === "ok" ? state.manifest : null;
}

/**
 * The peers a module needs besides `@xano/sdk`, name → declared range, sorted
 * by name. A peer `peerDependenciesMeta` marks optional is not needed, and a
 * range that is not a string is not one a manager could be handed.
 */
export function requiredPeersOf(manifest: Record<string, unknown>): [name: string, range: string][] {
  const peers = manifest["peerDependencies"];
  if (typeof peers !== "object" || peers === null) return [];
  const meta = manifest["peerDependenciesMeta"];
  const optional = (name: string): boolean => {
    const entry = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>)[name] : undefined;
    return typeof entry === "object" && entry !== null && (entry as { optional?: unknown }).optional === true;
  };
  return Object.entries(peers as Record<string, unknown>)
    .filter((e): e is [string, string] => e[0] !== "@xano/sdk" && typeof e[1] === "string" && !optional(e[0]))
    .sort(([a], [b]) => byCodeUnit(a, b));
}

/**
 * Which loader a module belongs to, from its own manifest.
 *
 * An unrecognized `kind` is REFUSED rather than defaulted. The failure a
 * default would produce is silent and confusing in equal measure: a package
 * declaring `"kind": "toolchian"` would be handed to the workspace loader,
 * which would report it as unwired, and the user would go looking for a
 * registration bug in a module whose only fault is a typo in one string. The
 * error names the package and the valid kinds so the fix is the next keystroke.
 */
export function moduleKind(pkg: string, manifest: Record<string, unknown>): ModuleKind {
  const field = manifest["xanosdk"];
  if (typeof field !== "object" || field === null) return "workspace";
  const kind = (field as Record<string, unknown>)["kind"];
  if (kind === undefined) return "workspace";
  if (typeof kind === "string" && (MODULE_KINDS as readonly string[]).includes(kind)) {
    return kind as ModuleKind;
  }
  throw new UsageError(
    `${pkg} declares "xanosdk": { "kind": ${JSON.stringify(kind)} }, which is not a module kind. ` +
      `Valid kinds are ${MODULE_KINDS.map((k) => JSON.stringify(k)).join(" and ")}. ` +
      `Omit the field entirely for a workspace module.`,
  );
}

/**
 * The module's own entry file, resolved from its manifest rather than guessed.
 *
 * `exports["."]` first, then `module`, then `main` — newest declaration wins,
 * because a package that ships all three means the modern one.
 */
export function entryFileOf(
  dir: string,
  pkg: string,
  manifest: Record<string, unknown>,
): string | null {
  const exports = manifest["exports"];
  const dot =
    typeof exports === "object" && exports !== null
      ? (exports as Record<string, unknown>)["."]
      : undefined;
  const nested =
    typeof dot === "object" && dot !== null
      ? ((dot as Record<string, unknown>)["import"] ?? (dot as Record<string, unknown>)["default"])
      : typeof dot === "string"
        ? dot
        : undefined;
  const candidate = nested ?? manifest["module"] ?? manifest["main"];
  if (typeof candidate !== "string") return null;
  // Beside the manifest {@link manifestPathOf} found, so a package an npm or
  // yarn workspace hoisted to the repository root is read where it is.
  return fileInPackage(dir, pkg, candidate);
}

/**
 * A file inside an installed package, resolved and checked.
 *
 * The toolchain loader needs this for `xanosdk.plugin`, which names a path the
 * way `main` does but is not any of the fields {@link entryFileOf} reads.
 * Returns null when the path does not exist, so a stale `plugin` path after a
 * version bump reads as "not there" rather than throwing from an import.
 */
export function fileInPackage(dir: string, pkg: string, relative: string): string | null {
  // Resolved against wherever the package's manifest actually is, so a hoisted
  // install finds its plugin file too. Contained to that directory: the value
  // comes from the package's own manifest, and a resolver whose promise is "a
  // file inside this package" should keep it literally.
  const manifest = manifestPathOf(dir, pkg);
  if (manifest === null) return null;
  const root = dirname(manifest);
  const file = resolve(root, relative);
  if (file !== root && !file.startsWith(root + sep)) return null;
  return existsSync(file) ? file : null;
}

/**
 * What came back from trying to import a module's entry.
 *
 * Tagged rather than sentinel-keyed. The obvious shortcut — return the module
 * namespace, or `{ failed }` on error, and tell them apart with `"failed" in x`
 * — is wrong against a namespace whose own exports we do not control: a module
 * exporting a binding named `failed` would read as a failed import.
 */
export type LoadedEntry =
  | { readonly kind: "loaded"; readonly exports: Record<string, unknown> }
  | { readonly kind: "missing"; readonly why: string }
  | { readonly kind: "failed"; readonly why: string };

/**
 * The module's entry, imported — its real exports, or why there were none to
 * be had.
 *
 * Both questions the workspace loader asks a package that has not fully
 * declared itself go through here: which `register*` it exports, and whether
 * that function takes a second argument. Node caches an ESM URL, so asking both
 * costs one load.
 */
export async function loadEntryExports(
  dir: string,
  pkg: string,
  manifest: Record<string, unknown>,
): Promise<LoadedEntry> {
  const entry = entryFileOf(dir, pkg, manifest);
  if (entry === null) {
    return { kind: "missing", why: "its package.json names no entry we could read" };
  }
  return loadFile(entry);
}

/**
 * One resolved file, imported, reported the same way as {@link loadEntryExports}.
 *
 * Split out because the toolchain loader imports a path from `xanosdk.plugin`
 * rather than the package entry, and both sides want identical failure
 * reporting — a plugin that throws on import must be indistinguishable, at the
 * call site, from an entry that throws on import.
 */
export async function loadFile(file: string): Promise<LoadedEntry> {
  try {
    return {
      kind: "loaded",
      exports: (await import(pathToFileURL(file).href)) as Record<string, unknown>,
    };
  } catch (error) {
    return {
      kind: "failed",
      why: `importing it failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/** The module's own `homepage`, when it names a usable one. */
export function homepageOf(manifest: Record<string, unknown>): string | undefined {
  const homepage = manifest["homepage"];
  return typeof homepage === "string" && /^https?:\/\//.test(homepage) ? homepage : undefined;
}
