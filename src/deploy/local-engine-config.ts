/**
 * The facts about a local engine that a REFUSAL needs, and nothing else.
 *
 * `deploy --local-engine` has to answer two questions before it does any work:
 * does this machine have a platform the engine is built for, and where does
 * this run's engine come from — an override the flag names, or a published
 * release. Both answers are cheap, neither touches the network or spawns
 * anything, and both are needed before the command commits to any work.
 *
 * So this module holds them alone. Acquisition (download, verify, extract) and
 * the engine process read the same supported set and the same cache layout from
 * here, which is what keeps "where does the binary live" a single claim rather
 * than one per module. Keep it free of network and process code: the refusal
 * path must stay cheap enough to run before anything else, and testable without
 * a machine that has an engine on it.
 *
 * Node-only (it reads the filesystem), so it is reached by a lazy import from
 * the command layer and never from the browser-safe authoring bundle.
 */
import { readEnvVar } from "../util/env.js";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { LOOPBACK_HOSTS } from "./local-engine-handshake.js";

/**
 * A platform the engine publishes a binary for, spelled as node's
 * `process.platform` and `process.arch` joined — the form the cache path and
 * the refusal message both want.
 */
export type EnginePlatform = "darwin-arm64" | "linux-x64" | "linux-arm64";

/**
 * Every platform the engine has an asset for, measured against its published
 * release rather than assumed from what the SDK runs on.
 *
 * Everything absent here — Windows, Intel Macs — has no binary at all, so on
 * those machines the refusal IS the feature until the engine publishes one.
 */
export const SUPPORTED_PLATFORMS: readonly EnginePlatform[] = [
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
];

/**
 * This machine's engine platform, or `undefined` when the engine has no build
 * for it.
 *
 * Takes both halves as arguments (defaulting to the running process) so a test
 * can ask about an Intel Mac from an Apple Silicon one — the unsupported arms
 * are the ones that most need covering and the ones a developer's own machine
 * can never exercise.
 */
export function resolveEnginePlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): EnginePlatform | undefined {
  const pair = `${platform}-${arch}`;
  return SUPPORTED_PLATFORMS.find((p) => p === pair);
}

/**
 * The one variable that relocates everything this feature writes — the binary
 * cache, this tool's records, and (through {@link engineRunHome}) the engine's
 * own runtime data: its logs, run records and unpacked runtime files.
 *
 * Named here rather than read inline so the tests, the acquisition module and
 * the process module cannot disagree about its spelling.
 */
export const LOCAL_ENGINE_HOME_ENV = "XANOSDK_LOCAL_ENGINE_HOME";

/**
 * Where this feature keeps its state: `~/.xanosdk/local-engine` by default, or
 * whatever {@link LOCAL_ENGINE_HOME_ENV} names.
 *
 * Under the user's home, never the project tree — a cached binary is a property
 * of the MACHINE, shared by every project on it, and a `.gitignore` entry is a
 * poor place to keep a 100MB executable from being committed.
 */
export function localEngineHome(env: NodeJS.ProcessEnv = process.env): string {
  return readEnvVar(LOCAL_ENGINE_HOME_ENV, env) ?? join(homedir(), ".xanosdk", "local-engine");
}

/**
 * The HOME every engine process runs under — spawn, `list` and `stop` alike.
 *
 * The engine keeps everything it writes under the operating system's per-user
 * cache directory, which it derives from HOME: its logs, the records of running
 * engines, each instance's database and its unpacked runtime files. Handing it
 * a HOME under {@link localEngineHome} keeps all of that there — the one
 * directory this feature owns — instead of the developer's own cache. Every
 * spawn must use the same one: an engine started under another HOME is
 * invisible to `list` and `stop`.
 */
export function engineRunHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(localEngineHome(env), "engine");
}

/**
 * The per-user cache directory the engine derives from {@link engineRunHome}'s
 * HOME (`Library/Caches` on macOS, `.cache` on Linux). Its data directory —
 * the one holding `logs/`, one file per started engine — is inside.
 */
export function engineCacheDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  return join(engineRunHome(env), ...(platform === "darwin" ? ["Library", "Caches"] : [".cache"]));
}

/**
 * The engine's data directories left under the developer's OWN per-user cache
 * directory by builds that ran the engine under the real HOME, before
 * {@link engineRunHome} existed. Nothing runs from them now; each unpacked a
 * full runtime (hundreds of MB). Found by shape rather than spelled — the name
 * is the engine's own: a directory holding the engine's `dist`, `instances`
 * and `logs` folders.
 */
export function legacyRuntimeDirs(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  const cache = join(home, ...(platform === "darwin" ? ["Library", "Caches"] : [".cache"]));
  if (resolve(cache) === resolve(engineCacheDir(env, platform))) return [];
  let names: string[];
  try {
    names = readdirSync(cache, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names
    .map((name) => join(cache, name))
    .filter((dir) => ["dist", "instances", "logs"].every((sub) => existsSync(join(dir, sub))));
}

/**
 * Where cached executables live, one DIRECTORY per engine.
 *
 * A directory rather than a bare file because an engine is identified by more
 * than its bytes — the version or source it came from and the digest recorded
 * when it was fetched are stored beside it — and because "is anything cached"
 * then has an answer that a stray file dropped in the folder cannot fake.
 */
export function localEngineBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(localEngineHome(env), "bin");
}

/**
 * Where this run's engine comes from — decided once, as a value.
 *
 * `override` is an operator-named URL or archive path, run through the
 * prototype's pipeline and cached under its own namespace. `release` is a
 * published engine from the release manager: the `version` given, or the latest
 * release built for this platform when there is none.
 */
export type EngineSourceSpec =
  | { readonly kind: "override"; readonly source: string }
  | { readonly kind: "release"; readonly version?: string };

/**
 * The variable that names an engine to run INSTEAD of the project's pin — for
 * trying an experimental build, or a published version the project has not
 * moved to, without touching the committed `package.json`.
 *
 * It takes three forms, told apart by shape — the same three a value on
 * `--local-engine=` takes:
 *
 *   - a version, `v0.1.5` or `0.1.5` — that release, from the release manager;
 *   - an `http(s)` URL — an engine archive fetched from there;
 *   - anything else — the path to an engine archive on this machine.
 *
 * Set in the environment rather than committed, because it is one developer's
 * experiment, not the project's decision. It ranks below a value on the flag
 * and above the pin, and like the flag it never writes the pin or asks about
 * updates.
 */
export const LOCAL_ENGINE_OVERRIDE_ENV = "XANOSDK_LOCAL_ENGINE_OVERRIDE";

/** A version as an override may spell it: the leading `v` is optional. */
const OVERRIDE_VERSION = /^v?\d+\.\d+\.\d+$/;

/**
 * An override value read by its shape: a version is that release, anything
 * else is a URL or archive path for the prototype's pipeline. One reading for
 * the flag and {@link LOCAL_ENGINE_OVERRIDE_ENV}, so the same value means the
 * same engine wherever it is written.
 */
function overrideSpec(value: string): EngineSourceSpec {
  if (OVERRIDE_VERSION.test(value)) {
    return { kind: "release", version: value.startsWith("v") ? value : `v${value}` };
  }
  return { kind: "override", source: value };
}

/**
 * Whether an `http(s)` override may be fetched at all: `https`, or `http` to
 * this machine. Anything else would carry the engine — and any
 * `XANOSDK_LOCAL_ENGINE_TOKEN` — in cleartext past whoever is on the path, and
 * the bytes that come back are then EXECUTED. The rule the release index is
 * held to, applied to the override too.
 */
export function isTrustedEngineUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL at all: the fetch refuses it with its own cause.
    return true;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname.replace(/^\[|\]$/g, ""));
}

/**
 * An override that is a path, as an absolute path.
 *
 * `~` is expanded here rather than left to the shell: the glued form
 * (`--local-engine=~/Downloads/engine.tar.gz`) is the one being recommended to
 * testers, and no shell expands a tilde in the middle of a word. HOME is read
 * off the env passed in, so a test can name a home directory.
 */
export function expandArchivePath(source: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"] ?? homedir();
  const expanded = source === "~" ? home : source.startsWith("~/") ? home + source.slice(1) : source;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** An archive name is a path, whatever its first letter. */
const ARCHIVE_SUFFIX = /\.(tar\.gz|tgz|gz|tar|zip)$/i;

/**
 * Why an override value cannot be used, or `undefined` when it can — decided
 * from the value alone, before any request, so the refusal is a usage error
 * rather than a failed download.
 *
 * Two shapes are refused:
 *
 *   - an `http://` URL to anything but loopback (see {@link isTrustedEngineUrl});
 *   - a value SHAPED like a version (`vbogus`, `v1.2`, `1.2`) that is not one and
 *     names no file here — read as a path it would end in "no engine archive
 *     at …/vbogus", which answers a question the operator never asked.
 *
 * `where` names what carried the value (`--local-engine`, the variable).
 */
export function engineOverrideRefusal(
  value: string,
  where: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (/^https?:\/\//i.test(value)) {
    if (isTrustedEngineUrl(value)) return undefined;
    return (
      `${where} names an engine over plain http on a host that is not this machine. An engine is ` +
      `a program this command runs, so fetched that way anyone on the network path could swap it ` +
      `(and read XANOSDK_LOCAL_ENGINE_TOKEN if it is set). Nothing was requested.\n` +
      `Serve the archive over https://, or over http:// from 127.0.0.1, ::1 or localhost.`
    );
  }
  // A URL in any other scheme is not a path either: read as one it resolves to
  // a mangled `…/ftp:/host/file` that names nothing the operator typed.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme !== null) {
    return (
      `${where} names a URL with the ${scheme[1]!.toLowerCase()}:// scheme, and an engine is fetched only over https:// ` +
      `(or http:// from this machine). Nothing was requested.\n` +
      `Pass ${where} an https:// URL, a version like v0.1.5, or the path to an engine archive.`
    );
  }
  if (OVERRIDE_VERSION.test(value)) return undefined;
  const looksLikeVersion =
    !/[\\/~]/.test(value) &&
    !ARCHIVE_SUFFIX.test(value) &&
    (/^v[0-9a-z.+-]*$/i.test(value) || /^\d+(\.[0-9a-z+-]*)*$/i.test(value));
  if (looksLikeVersion && !existsSync(value)) {
    return (
      `"${value}" is not an engine version — they are written vMAJOR.MINOR.PATCH, like v0.1.5 — ` +
      `and no archive file has that name here.\n` +
      `Pass ${where} a version in that form, an https:// URL, or the path to an engine archive.`
    );
  }
  // A path the operator typed that names no file is fixed by retyping it — a
  // usage error, as every other path flag's is — and said before any compile.
  const path = expandArchivePath(value, env);
  if (!existsSync(path)) {
    return (
      `${MISSING_ARCHIVE} ${path}.\n` +
      `Check the path — ${where} is read exactly as passed, with \`~\` and relative paths resolved ` +
      `from where the command ran.`
    );
  }
  return undefined;
}

/**
 * How {@link engineOverrideRefusal} opens when the path names no file — a named
 * local file that is not there, which exits 8 as every such file does.
 */
export const MISSING_ARCHIVE = "There is no engine archive to read at";

/**
 * The refusal for whichever override this run would use — the flag's value,
 * else {@link LOCAL_ENGINE_OVERRIDE_ENV} — or `undefined`. A bare flag with the
 * variable unset names a published release and has nothing to refuse.
 */
export function engineSourceRefusal(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (flagValue !== undefined && flagValue !== "") return engineOverrideRefusal(flagValue, "`--local-engine`", env);
  const fromEnv = readEnvVar(LOCAL_ENGINE_OVERRIDE_ENV, env)?.trim();
  if (fromEnv === undefined) return undefined;
  return engineOverrideRefusal(fromEnv, LOCAL_ENGINE_OVERRIDE_ENV, env);
}

/**
 * The engine {@link LOCAL_ENGINE_OVERRIDE_ENV} names, or `undefined` when it is
 * unset.
 *
 * An empty or whitespace-only value is UNSET, not a source: exporting one empty
 * is an ordinary shell accident, and reading it as a path would refuse on a
 * file nobody named. The value is trimmed for the same reason.
 */
export function engineOverrideFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EngineSourceSpec | undefined {
  const value = readEnvVar(LOCAL_ENGINE_OVERRIDE_ENV, env)?.trim();
  return value === undefined ? undefined : overrideSpec(value);
}

/**
 * Where this run gets an engine from.
 *
 * **The one place the precedence is decided**, so the pre-compile refusal and
 * the acquisition that runs much later cannot drift into different readings of
 * the same run:
 *
 *   1. a value on the flag, which always wins — what the operator typed for
 *      this run beats anything set earlier;
 *   2. {@link LOCAL_ENGINE_OVERRIDE_ENV}, one developer's experiment;
 *   3. `pinned`, the version the project recorded;
 *   4. none of those, which is the latest published release.
 */
export function resolveEngineSource(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  pinned?: string,
): EngineSourceSpec {
  // Taken VERBATIM, not trimmed: what the flag carried is what the operator
  // typed, and the shell has already done its own splitting.
  if (flagValue !== undefined && flagValue !== "") return overrideSpec(flagValue);
  const fromEnv = engineOverrideFromEnv(env);
  if (fromEnv !== undefined) return fromEnv;
  return pinned === undefined ? { kind: "release" } : { kind: "release", version: pinned };
}
