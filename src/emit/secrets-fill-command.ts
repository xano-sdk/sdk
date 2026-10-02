/**
 * `xanosdk secrets fill` — mint a token for every documentation gate that has none.
 *
 * The step after `documentation: { require_token: true }`. A gate declared in
 * source names no value, and until one exists in `xano/.secrets.json` a deploy
 * refuses rather than shipping a doc site the source says is Private. A pull
 * answers that for a workspace that ALREADY has tokens; this answers it for the
 * other direction — a gate authored here, on an object the platform has never
 * minted a token for — which otherwise leaves the user inventing a random string
 * by hand and pasting it into a file the SDK owns.
 *
 * Three properties it holds, each of which is the reason for a piece of the code
 * below:
 *
 * - it only ever ADDS. An existing value is never replaced, because replacing
 *   one silently invalidates every doc-site link already handed out, and because
 *   the value may be the one the live workspace is gating with right now. An
 *   entry no scope claims is left alone for the same reason the build refuses to
 *   prune it: a rename and a commented-out group look identical from here.
 * - it writes NOTHING when there is nothing to add, so a re-run is not a
 *   file-mtime change and a no-op does not need the ignore checks to pass.
 * - a minted token is LOCAL until a deploy sends it. That is said out loud,
 *   because the gap between "the file has a token" and "the doc site wants that
 *   token" is the one thing about this command that can surprise someone.
 *
 * Node-only (fs + the entry loader); lazily imported by the dispatcher.
 */
import { dirname } from "node:path";
import { contextFlags } from "./context-flags.js";
import { displayPath } from "../util/rel-path.js";
import { existsSync } from "node:fs";

import { loadDefault, resolveLockPath, type ParsedArgs } from "./cli.js";
import { UsageError } from "./errors.js";
import { refuseIfTracked, requireSecretPathGitignored } from "./gitignore.js";
import { resolveProjectEntry } from "./deploy-source.js";
import {
  defaultWorkspaceSecretsPath,
  generateDocumentationToken,
  entryWordOf,
  readSecretsFile,
  SECRETS_FILE_VERSION,
  writeSecretsFile,
  type SecretsTokenEntry,
} from "./secrets-file.js";
import { safeNames } from "./workspace-env.js";
import { info, success, warn } from "./ui.js";
import { isMachineOutput, writeJson } from "./output.js";
import { readLockFile } from "../lock/io.js";
import { resetLockOverrides, seedLockOverrides } from "../lock/store.js";
import { Xano } from "../workspace/xano.js";
import { documentationScopeFlagLabel } from "../workspace/documentation-token.js";

const HELP = { command: "secrets", subcommand: "fill" } as const;

export async function runSecretsFillCommand(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const file = args.file ?? resolveProjectEntry(cwd);
  if (file === undefined) {
    throw new UsageError(
      `\`xanosdk secrets fill\` reads the documentation gates your source declares, so it needs ` +
        `the project entry. Run it from a project directory, or name the entry: ` +
        `\`xanosdk secrets fill ./xano/index.ts\`.`,
      { hintFor: HELP },
    );
  }

  // The lock is seeded BEFORE the entry loads, exactly as a build does it. An
  // API group's token is keyed by its guid, the guid is stamped at
  // registration, and a lock PINS it — so an entry loaded without the lock
  // would compute a different key for the same group, and this command would
  // write a value the next `xanosdk deploy` cannot find. Read-only: nothing here
  // mints or persists a lock.
  resetLockOverrides();
  const lockPath = resolveLockPath(args, file);
  if (existsSync(lockPath)) seedLockOverrides(readLockFile(lockPath));

  const def = await loadDefault(file);
  if (!Xano.isXano(def)) {
    throw new UsageError(`Module "${file}" must default-export a Xano registry.`, { hintFor: HELP });
  }

  // GATED scopes only. An ungated block awaits a stored value too, but minting
  // one for it would invent a secret nothing reads — `fill` exists for a gate
  // declared in source that has no live value to pull.
  const declared = def.documentationTokenNames().filter((d) => d.gated);
  if (declared.length === 0) {
    info(
      `No documentation gates are declared, so there is nothing to fill. A gate is ` +
        `\`documentation: { require_token: true }\` on \`workspaceConfig\` or an \`apiGroup\`.`,
    );
    // Labels only, here and below — the document never carries a value.
    if (isMachineOutput(args)) writeJson({ path: null, minted: [], kept: [] });
    return;
  }

  const path = defaultWorkspaceSecretsPath(file);
  // BEFORE anything is written, and before the ignore rule is appended: an
  // `atomicWrite` into a directory that does not exist fails on the STAGING
  // file, so the ENOENT names a `.tmp-<pid>` path the reader has never seen and
  // arrives after `.gitignore` has already been edited. `env pull` refuses the
  // same way and for the same reason — deliberately not an mkdir, since a
  // directory holding nothing but a secrets file is a worse outcome than a
  // refusal, and this is what naming an entry outside the backend looks like.
  const dir = dirname(path);
  if (!existsSync(dir)) {
    throw new UsageError(
      `No ${displayPath(dir)} directory, so there is nowhere to put ` +
        `${displayPath(path)}. The tokens belong beside the backend they gate — ` +
        `run this against that project's entry file.`,
      { hintFor: HELP },
    );
  }
  const stored = readSecretsFile(path);
  const entries: Record<string, SecretsTokenEntry> = { ...(stored?.documentationTokens ?? {}) };

  // An entry whose value is the empty string counts as MISSING, not as supplied.
  // A build reads a stored `""` as "send the gate empty", which clears it — so
  // the one state a fill must never leave in place is the one that looks
  // filled-in and is not.
  const minted: string[] = [];
  const kept: string[] = [];
  for (const d of declared) {
    const label = documentationScopeFlagLabel(d.scope);
    const existing = entries[d.key];
    if (existing !== undefined && existing.value !== "") {
      // The label is refreshed while the scope is in hand: it is what every
      // report and both flags call this entry, and a renamed group whose stored
      // label is the old name misnames itself in the one message that exists to
      // identify it.
      if (existing.label !== label) entries[d.key] = { ...existing, label };
      kept.push(label);
      continue;
    }
    entries[d.key] = { value: generateDocumentationToken(), label };
    minted.push(label);
  }

  const rel = displayPath(path);
  if (minted.length === 0) {
    success(
      `Every declared documentation gate already has a token in \`${rel}\` ` +
        `(${kept.length}). Nothing was written.`,
    );
    if (isMachineOutput(args)) writeJson({ path: rel, minted, kept });
    return;
  }

  // Both checks fire only on the writing path, and both BEFORE the write — the
  // one ordering where a failed ignore rule is discovered while the file does
  // not yet hold a secret. A refusal here, unlike the pull's, is fatal: this
  // command has nothing else to deliver.
  // `path`, not the directory it lives in: re-deriving it here would ask a
  // SECOND resolver where the backend is, and the two can disagree in a project
  // whose backend carries no lock yet — the rule then lands on one file while
  // the token lands in the other, and this command says "gitignored" about a
  // file git will happily commit.
  requireSecretPathGitignored(path, HELP);
  // `rel`, not the constant: the refusal's remedy is a literal
  // `git rm --cached <label>`, so a label naming `xano/` in a project whose
  // backend is a sibling hands the reader a command that untracks nothing.
  refuseIfTracked(path, rel, HELP);

  writeSecretsFile(path, {
    version: SECRETS_FILE_VERSION,
    // Preserved when a pull wrote this file: those values DID come from that
    // instance, and overwriting the record because a later command added a
    // locally-minted sibling would throw away the only answer to "where did
    // these come from" that survives the terminal scrollback.
    pulledFrom: stored?.pulledFrom ?? { instance: "(generated locally)", at: new Date().toISOString() },
    documentationTokens: entries,
  });

  success(
    `Minted ${minted.length} documentation token${minted.length === 1 ? "" : "s"} into \`${rel}\` — ` +
      `${safeNames(minted)}.` +
      (kept.length > 0 ? ` ${kept.length} already had one and ${kept.length === 1 ? "was" : "were"} left alone.` : ""),
  );
  // Said every time, on the same channel the pull uses for the same file: a
  // secret landing on disk is worth a line, and the local-until-deployed gap is
  // what someone checking the live doc site in the next minute will trip over.
  warn(
    `\`${rel}\` is SECRET MATERIAL and is gitignored, so a teammate's clone and CI both need ` +
      `\`--secrets-file\` or \`--doc-token\` instead. A minted token gates nothing until it is ` +
      `sent: run \`xanosdk deploy${entryWordOf(file)}${contextFlags(args)}\` to apply ${minted.length === 1 ? "it" : "them"}.`,
    "secrets.local-only",
  );
  if (isMachineOutput(args)) writeJson({ path: rel, minted, kept });
}
