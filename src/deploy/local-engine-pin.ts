/**
 * The local-engine version a project runs, pinned in its own `package.json`.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *
 *     "xanosdk": {
 *       "@xano/sdk": { "localEngine": "v0.1.5" }
 *     }
 *
 * The SDK's own entry in the project's `"xanosdk"` block — the map from package
 * name to settings described in `src/emit/project-config.ts`. Committed with the
 * project, so every checkout resolves the same engine version. Written, it is
 * spelled exactly as the engine's releases spell it: `vMAJOR.MINOR.PATCH`. Read,
 * it accepts what every other entry point accepts (`0.1.5`, ` v0.1.5 `) and
 * hands back the `v`-prefixed form — without rewriting the user's field.
 *
 * ── Which package.json ──────────────────────────────────────────────────────
 *
 * The one in the directory the caller passes — the deploy's working directory,
 * the same notion of "the project" the engine records use. There is no upward
 * search: a pin found in some parent would name a project other than the one
 * the engine records are kept for.
 *
 * ── Failure posture ─────────────────────────────────────────────────────────
 *
 * Reading never throws. A pin that is present but not a version (`"latest"`,
 * `"^v0.1.5"`, `5`), or a manifest that does not parse, reads as
 * {@link UnusablePin} — distinct from unset — and is reported through the
 * caller's `warn`. The deploy then runs on the latest WITHOUT writing: the field
 * is the user's, and replacing it would also replace their running engine. Writing goes through `writeToolchainConfig`,
 * which preserves every other byte of the file (key order, indent, trailing
 * newline, line endings) and every other package's settings, and refuses an
 * unparseable manifest rather than overwriting it.
 *
 * Node-only; reached from the local-engine deploy and its commands.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  composeToolchainConfig,
  readProjectManifest,
  readToolchainBlock,
  SDK_PACKAGE,
  writeToolchainConfig,
} from "../emit/project-config.js";
import { RELEASE_VERSION } from "./local-engine-cache.js";
import { normalizeEngineVersion } from "./local-engine-releases.js";

/** The field under the SDK's entry that holds the pinned engine version. */
export const PIN_FIELD = "localEngine";

/**
 * A pin that is present but cannot be used: a value that is not a version, or
 * a manifest that does not parse (`unusable` is then `undefined`). Not the same
 * as unset — nothing may pin over it without the user asking.
 */
export interface UnusablePin {
  /** The value as stored, for naming it in a message. */
  readonly unusable: unknown;
}

/** What {@link readPin} found. See its doc for what each answer means. */
export type PinRead = string | null | undefined | UnusablePin;

/** Whether {@link readPin} found a pin that is present but cannot be used. */
export function isUnusablePin(pin: PinRead): pin is UnusablePin {
  return typeof pin === "object" && pin !== null;
}

/** Options for {@link readPin}. */
export interface ReadPinOptions {
  /**
   * Told when a pin exists but cannot be used — a malformed value, or a
   * manifest that does not parse. The pin then reads as {@link UnusablePin}.
   */
  readonly warn?: (message: string) => void;
}

/** What {@link writePin} did. */
export interface WritePinResult {
  /** Whether there was no `package.json`, so one holding only the pin was created. */
  readonly created: boolean;
  /** Whether the file was rewritten. False when it already held this version. */
  readonly changed: boolean;
  /** The manifest the pin lives in, so the caller can name it. */
  readonly path: string;
}

/**
 * The project's pinned engine version.
 *
 * Four answers, each meaning something different to the deploy: the version,
 * always `v`-prefixed; `null` when the project has a `package.json` but no pin
 * (the first run, which pins); {@link UnusablePin} when a pin is there but is
 * not a version (runs on the latest and leaves the field alone); and
 * `undefined` when there is no `package.json` at all (the first run creates
 * one to pin in).
 */
export function readPin(projectDir: string, opts: ReadPinOptions = {}): PinRead {
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return undefined;
  const manifest = readProjectManifest(projectDir);
  if (manifest === null) {
    opts.warn?.(
      `${path} could not be parsed as a JSON object, so its local engine pin was not read.`,
    );
    return { unusable: undefined };
  }
  const own = readToolchainBlock(projectDir, manifest)[SDK_PACKAGE];
  if (typeof own !== "object" || own === null || Array.isArray(own)) return null;
  if (!(PIN_FIELD in own)) return null;
  const value = (own as Record<string, unknown>)[PIN_FIELD];
  if (typeof value === "string") {
    try {
      return normalizeEngineVersion(value);
    } catch {
      // Falls through to the warning below.
    }
  }
  opts.warn?.(
    `the "${PIN_FIELD}" pin under "xanosdk"."${SDK_PACKAGE}" in ${path} is ` +
      `${JSON.stringify(value)}, not a version like "v0.1.5", so it was ignored.`,
  );
  return { unusable: value };
}

/**
 * Pin `version` in the project's `package.json`.
 *
 * Merges into the existing `"xanosdk"` block: every other package's settings,
 * and any other setting under the SDK's own entry, are carried forward as they
 * are. A manifest already holding this version is not rewritten.
 *
 * With no `package.json`, one is created holding only the pin — nothing else
 * the project would then have to own — so a project without one still runs a
 * pinned engine, and deploys offline once it is cached. Throws on a version
 * that is not `vMAJOR.MINOR.PATCH` — the one spelling a pin is stored in — and on a
 * manifest that cannot be parsed or written.
 */
export function writePin(projectDir: string, version: string): WritePinResult {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(
      `cannot pin local engine version ${JSON.stringify(version)}: expected vMAJOR.MINOR.PATCH, like "v0.1.5".`,
    );
  }
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) {
    // Through the same formatter every other write of this block uses, and
    // created exclusively: a manifest that appeared since the check above (a
    // concurrent first deploy, `npm init`) is merged into below, never replaced.
    const text = composeToolchainConfig("{}\n", { [SDK_PACKAGE]: { [PIN_FIELD]: version } });
    try {
      writeFileSync(path, text, { flag: "wx" });
      return { created: true, changed: true, path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const block = readToolchainBlock(projectDir);
  const own = block[SDK_PACKAGE];
  const next = {
    ...block,
    [SDK_PACKAGE]: {
      ...(typeof own === "object" && own !== null && !Array.isArray(own) ? own : {}),
      [PIN_FIELD]: version,
    },
  };
  const changed = writeToolchainConfig(projectDir, next);
  return { created: false, changed, path };
}
