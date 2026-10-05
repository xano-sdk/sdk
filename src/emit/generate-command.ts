/**
 * `xanosdk generate <source>` — decode a backend into a Xano SDK source tree, and
 * write nothing else.
 *
 * The third shape of the same decode. `init --from` writes a whole project
 * around it; `pull` refreshes the backend of a project that already exists.
 * Neither answers "give me the `xano/` folder for this backend" — to drop into
 * a repo that already has its own shell, to read, or to diff against another
 * source. This does, from every source the rest of the CLI can name — the
 * spellings `generate <source>` declares in the registry:
 *
 *   workspace | release:<name> | ephemeral[:<name>] | local[:<name>] |
 *   tenant:<name> | ./bundle.json
 *
 * A Xano Engine is read through its own bearer, so `generate local`
 * needs no Xano sign-in — and refuses `--profile`, which would select one.
 *
 * ## It creates, and replaces only its own output
 *
 * The target is a directory this command owns: absent, empty, or a tree an
 * earlier decode wrote. "An earlier decode wrote it" is proved by the codegen
 * marker — the file `init --from` already leaves, and this command now writes
 * too — never by an `index.ts`, which every TypeScript `src/` and many repo
 * roots also have. A non-empty directory without the marker is refused even
 * with `--force`, and so is the working directory or any directory above it:
 * `--force` means "replace the backend tree that is here", and honoring it
 * anywhere else would delete files no decode ever produced.
 *
 * A replace removes only what the previous decode WROTE. The marker records
 * the files each decode wrote, and a `--force` over the tree removes those and
 * nothing else: a file someone added beside them (`notes.md`, a hand-written
 * `custom/helper.ts`) is kept and named, never deleted, and a directory the
 * removal empties is removed with it. A marker with no record — one `init
 * --from` wrote — vouches for no file in particular, so nothing is removed on
 * its word; the new decode overwrites what it writes and the rest is named.
 *
 * The files `PRESERVED_ON_REFRESH` names survive a replace, as they do for
 * `pull`: `.env` and `.secrets.json` hold values that exist nowhere else.
 * `xano.lock` survives too, but reconciled against the new source the same way
 * `pull` does it: an entry is kept only when the source still carries an
 * object with that key AND identity. A lock carried across unchanged from a
 * different backend pins identities a later promote uses to claim URLs and
 * scope a prune — a wrong prune waiting to happen.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";
import { LocalFileNotFoundError, UsageError } from "./errors.js";
import { step, success, detail, info, warn, terminalText } from "./ui.js";
import { isMachineOutput, writeJson } from "./output.js";
import { decodeWorkspaceArchive } from "../validate/archive.js";
import { decodeBundle } from "../codegen/index.js";
import type { ExportedBundle } from "../deploy/workspace-export.js";
import {
  carriedSeedRows,
  fetchWorkspaceBundle,
  placeGeneratedFiles,
  reportSeedRows,
  type SeedRowsReport,
  readBundleFile,
  refuseDuplicateSourceGuids,
  writeBundleEnvValues,
  writeDocumentationTokens,
} from "./codegen-command.js";
import { PRESERVED_ON_REFRESH } from "./scaffold.js";
import { contextFlags } from "./context-flags.js";
import { fetchSourceArchive } from "./deploy-source.js";
import { parseSlot, requireBackendSlot, slotValueMissing } from "./backend-slot.js";
import { memoCredential, refuseProfileForLocal } from "./tracked-backend.js";
import { WORKSPACE_SECRETS_BASENAME } from "../workspace/documentation-token.js";
import { relForwardSlash } from "../util/rel-path.js";
import { safeNames } from "../util/env-name.js";
import type { CodegenOrigin } from "./init-templates.js";
import {
  containedWrites,
  decodeMarkerHead,
  decodeMarkerWith,
  describeDecodeReplace,
  filesUnder,
  planDecodeReplace,
  readDecodeRecord,
  removeEmptiedDirs,
  removeFiles,
} from "./backend-tree.js";
import { confirm } from "./prompt.js";
import { yesRerun } from "./retry-command.js";
import { ROUTES_MANIFEST_BASENAME } from "./routes-manifest.js";
import { readVersion } from "./cli.js";
import { projectRootFrom } from "./backend-dir.js";
import { shellWord } from "./command-line.js";
import { ensureSecretPathGitignored, type IgnorePlacement } from "./gitignore.js";
import { WORKSPACE_ENV_BASENAME } from "./workspace-env.js";
import { pulledIdentities, pulledLock, reconcileLock, type Reconciliation } from "./pull-command.js";
import { readLockFile, writeLockFile } from "../lock/io.js";
import type { LockFile } from "../lock/lock.js";

/**
 * A one-line pointer at `generate --help`, for `--branch` beside a source that
 * has none: both parsed, and the message says which to drop. The refusals of
 * what is on disk carry no help at all — the usage block cannot say what fills
 * the directory, and each message names its own way out.
 */
const HINT = { hintFor: { command: "generate" } } as const;
// `.gitignore` too, here only: in a tree generated outside any project it is
// where the secret files' rules live (see ignoreRootFor), and a `--force` that
// cleared it would leave `.env` unignored until the rules are re-added.
const PRESERVED = new Set([...PRESERVED_ON_REFRESH, ".gitignore"]);
const DEFAULT_OUT = "xano";
/** Same basename `init --from` writes, so either command can refresh the other's tree. */
export const CODEGEN_MARKER = ".xanosdk-codegen.json";

/** The marker already in the tree, whose other fields a replace keeps; none is an empty record. */
function previousMarker(root: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(root, CODEGEN_MARKER), "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // None, or unreadable: a fresh record.
  }
  return {};
}

/** The bundle to decode, and how it names itself. */
interface Loaded {
  readonly bundle: ExportedBundle;
  readonly label: string;
  /** What kind of source it was — a bundle file and a release have no running backend to re-read. */
  readonly kind: CodegenOrigin["source"];
  /** The seed rows a fetched archive carries (a release cut with `--seed`), which the tree does not. */
  readonly seed?: { rows: SeedRowsReport[]; provenance: string };
  /** The backend read, as a `--json` document names one (see `json-target.ts`); absent for a file. */
  readonly backend?: { selector?: string; workspaceId?: number };
}

async function loadSource(args: ParsedArgs, raw: string, cwd: string): Promise<Loaded> {
  // Through the slot the registry declares, so the spellings a refusal lists are
  // the ones help shows — a bundle path among them. A kind-shaped word is a
  // kind or refused, never a filename: `generate local` names the
  // engine, and no file called `local` is looked up.
  const slot = requireBackendSlot("generate", undefined, "subject");
  const source = parseSlot(slot, raw);
  if (source.kind === "file") {
    if (args.branch !== undefined) {
      throw new UsageError(
        "`--branch` does not apply to a bundle file: it is one archive already exported from one " +
          "branch. Re-export it with `xanosdk workspace export --branch <label>`, or generate from " +
          "`workspace --branch <label>`.",
        HINT,
      );
    }
    step(`Reading ${raw}`);
    return { bundle: readBundleFile(source.path), label: raw, kind: "file" };
  }
  // A Xano Engine selects no credential, so a `--profile` beside one is
  // refused rather than silently dropped (R9) — before anything is resolved.
  refuseProfileForLocal(args.profile, [source.kind], slot);
  // Read only if a hosted source asks: the resolver never calls it for a local
  // engine, so a signed-out developer can still decode their own engine.
  const credential = memoCredential(() => getAccessToken(args));
  if (source.kind === "workspace" && args.branch !== undefined) {
    return {
      bundle: await fetchWorkspaceBundle(await credential(), args.branch),
      label: `workspace branch "${args.branch}"`,
      kind: "workspace",
      backend: { selector: "workspace", workspaceId: (await credential()).workspaceId },
    };
  }
  if (args.branch !== undefined) {
    throw new UsageError(
      `\`--branch\` applies to \`workspace\` only. "${raw}" carries the logic it was built from, ` +
        `not a branch to choose between.`,
      HINT,
    );
  }
  step(`Reading ${raw}`);
  // A bare tracked source (`local`, `ephemeral`) is the one recorded for
  // the PROJECT this run stands in — its root, from a subdirectory of it. Only
  // the lookup moves: `--out` stays relative to where the command was typed.
  const { projectDirFrom } = await import("./xanosdk-project.js");
  const fetched = await fetchSourceArchive(credential, raw, projectDirFrom(cwd) ?? cwd);
  const bundle = decodeWorkspaceArchive(fetched.archive) as ExportedBundle;
  return {
    bundle,
    label: fetched.label,
    kind: source.kind as CodegenOrigin["source"],
    // The provenance is the selector of whatever backend was read; a release is not one.
    backend: {
      ...(source.kind === "release" ? {} : { selector: fetched.provenance }),
      ...(source.kind === "local" ? {} : { workspaceId: (await credential()).workspaceId }),
    },
    seed: {
      rows: carriedSeedRows(fetched.archive, (bundle.payload ?? {}) as Record<string, unknown>),
      provenance: fetched.provenance,
    },
  };
}

/**
 * The directory whose `.gitignore` keeps a generated tree's secrets out of git:
 * the project the tree sits in (a `package.json` or a repo above it), else the
 * tree itself. Never a bare cwd — a `.gitignore` written into a directory that
 * is no project protects nothing and litters one the command does not own.
 */
function ignoreRootFor(root: string): string {
  const project = projectRootFrom(dirname(root));
  const isProject = existsSync(join(project, "package.json")) || existsSync(join(project, ".git"));
  return isProject ? project : root;
}

export async function runGenerateCommand(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const raw = args.positionals[0];
  if (raw === undefined) {
    // Rendered from the declaration, so the list cannot drift from help.
    throw slotValueMissing(requireBackendSlot("generate", undefined, "subject"));
  }
  // `-` means stdout everywhere else; a decode is a tree of files, so it has no
  // stdout form — refused rather than written into a directory named `-`.
  if (args.out === "-") {
    throw new UsageError("`generate` writes a tree of files, so `--out -` (stdout) has no meaning here — name a directory.", {
      hintFor: { command: "generate" },
    });
  }
  // A bundle path that is not there is the first thing wrong with the command
  // line: said before anything about --out, whose refusal ("xano/ is not
  // empty…") sent the reader to fix a directory when the typo was the path.
  const typed = parseSlot(requireBackendSlot("generate", undefined, "subject"), raw);
  if (typed.kind === "file" && !existsSync(resolve(cwd, typed.path))) {
    throw new LocalFileNotFoundError(`No bundle file at "${resolve(cwd, typed.path)}".`);
  }
  const outArg = args.out ?? DEFAULT_OUT;
  const root = resolve(cwd, outArg);
  // How the target is named in messages: relative when it sits under cwd.
  const shown = (isAbsolute(outArg) ? "" : relForwardSlash(cwd, root)) || root;

  // A path that exists as something other than a directory cannot hold a tree.
  // Said here, as the retype it is, rather than as the filesystem's ENOTDIR.
  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new UsageError(
      `--out ${shown} is a file, not a directory. Nothing was written. Pick an empty or new ` +
        `directory with \`--out <dir>\`.`,
      HINT,
    );
  }
  // Ownership BEFORE any network: a refusal here should cost nothing.
  const existing = filesUnder(root);
  const replaceable = existing.filter((p) => !PRESERVED.has(p));
  if (replaceable.length > 0) {
    // The working directory, or anything above it, is a project, never a tree
    // a decode owns — refused before the marker is even consulted.
    const cwdWithin = cwd === root || cwd.startsWith(`${root}${sep}`);
    if (cwdWithin || !existing.includes(CODEGEN_MARKER)) {
      // The reason is the one that applies: a decoded tree the command is run
      // from carries its marker, and "no marker" there sends the reader
      // looking for a file that is present.
      const why = cwdWithin
        ? `it is the working directory or above it, and generate never replaces the directory it runs in` +
          (existing.includes(CODEGEN_MARKER) ? "" : ` (and it holds no ${CODEGEN_MARKER})`)
        : `it is not a backend tree a decode wrote — no ${CODEGEN_MARKER}`;
      throw new UsageError(
        `${shown}/ is not empty and ${why}. Nothing was written. Pick an empty or new directory ` +
          `with \`--out <dir>\`${cwdWithin && existing.includes(CODEGEN_MARKER) ? `, or run from outside it` : ""}.`,
      );
    }
    if (args.force !== true) {
      throw new UsageError(
        `${shown}/ already holds a backend tree. Re-run with \`--force\` to replace it ` +
          `(${[...PRESERVED].join(", ")} are kept), or pick another directory with \`--out <dir>\`.`,
      );
    }
  }

  const loaded = await loadSource(args, raw, cwd);
  const project = decodeBundle(loaded.bundle, { secretsFile: `${shown}/${WORKSPACE_SECRETS_BASENAME}`, writesSecrets: args.noSecrets !== true });
  refuseDuplicateSourceGuids(project);
  // Placed with an empty prefix and joined onto `root` here, so an absolute
  // `--out` works the same as a relative one. The committed `.env.example`
  // names the tree the way its commands are run from the project: `--out gen`
  // is `gen/`, but an absolute `--out` or one outside the working directory
  // (`../xano`) is true only from where generate happened to run, so those
  // take the directory's own name.
  const projectRelative = !isAbsolute(outArg) && !isAbsolute(shown) && shown !== ".." && !shown.startsWith("../");
  // The route manifest's refusal, if any, is said AFTER the files it follows
  // are reported, and its remedy names the entry as pasted from here. A tree
  // with no package.json above it cannot load `@xano/sdk`, so that remedy
  // would fail as printed — say what to add first.
  const routesDeferred: string[] = [];
  const decoded = placeGeneratedFiles(project, "", projectRelative ? shown : basename(root) || shown, {
    entry: shellWord(`${shown}/index.ts`),
    deferred: routesDeferred,
  }).map((f) => ({
    path: f.path.replace(/^\//, ""),
    content: f.content,
  }));
  // `files` is the record the NEXT `--force` removes by: exactly what this
  // decode wrote, and nothing a person later adds beside it. `digests` is what
  // lets that replace — or a `pull`/`init --from` over this tree — tell a file
  // you edited from one only the source changed; without them a later decode
  // deleted an edited file and said nothing about the edits.
  const markerHead = decodeMarkerHead(previousMarker(root), "generate", raw, readVersion(), project.report.toJson());
  const markerFor = (wrote: typeof decoded): string => `${JSON.stringify(decodeMarkerWith(markerHead, wrote), null, 2)}\n`;
  const files = [...decoded, { path: CODEGEN_MARKER, content: markerFor(decoded) }];

  // Containment before the clear, so a refusal leaves the existing tree intact.
  const planned = containedWrites(
    root,
    files,
    (path) =>
      new UsageError(
        `${loaded.label} carries a file that would be written outside ${shown}/ ("${path}"). ` +
          `Nothing was written.`,
      ),
  );

  const lockPath = join(root, "xano.lock");
  const lock: LockFile | undefined = existsSync(lockPath) ? readLockFile(lockPath) : undefined;
  const reconciliation: Reconciliation | undefined =
    lock === undefined ? undefined : reconcileLock(lock, pulledIdentities(loaded.bundle.payload));

  // The planner `pull` and `init --from` share: only what the previous decode
  // recorded writing is removed, everything else it did not write is the
  // author's and stays (named below), and a file edited since that decode is
  // told apart by its recorded digest. `[]` as the existing set: a marker with
  // no file record (an old one) vouches for no file in particular, so nothing
  // is removed on its word.
  const incoming = new Map(decoded.map((f) => [f.path, f.content] as const));
  const plan = planDecodeReplace(
    root,
    incoming,
    replaceable.filter((p) => p !== CODEGEN_MARKER),
    readDecodeRecord(root, []),
  );
  const removed = plan.removals;
  const kept = plan.kept;
  // `--force` said "replace the tree", not "throw away my edits": a file edited
  // since the last decode that this one deletes or rewrites is listed and
  // confirmed, as `pull` does, before anything is touched.
  if (plan.removedEdited.length > 0 || plan.edited.length > 0) {
    describeDecodeReplace(plan, shown, loaded.label, (line, files) => warn(line, "generate.replace", files));
    if (args.yes !== true) {
      // Off a terminal the refusal carries the edited files as `details.files`,
      // as `init --force`'s does, so a script sees WHAT `--yes` would lose.
      const files = [...plan.removedEdited, ...plan.edited].map((p) => `${shown}/${p}`);
      const { rerun, note } = yesRerun(args, "generate");
      const ok = await confirm(`Replace ${shown}/ from ${loaded.label}, losing those edits?`, {
        flag: "--yes",
        refusal: { details: { written: false, files }, rerun, note },
      });
      if (!ok) {
        info("Generate cancelled. Nothing was written.");
        if (isMachineOutput(args)) {
          writeJson({
            source: raw,
            out: root,
            declined: true,
            files: 0,
            removed: [],
            removedEdited: [],
            rewrittenEdited: [],
            kept: [],
          });
        }
        return;
      }
    }
  }
  removeFiles(root, removed);
  removeEmptiedDirs(root, removed);
  step(`Writing ${shown}/ from ${loaded.label}`);
  // The marker FIRST: a write that fails part-way leaves a tree this command
  // owns, so `generate --force` replaces it instead of refusing it as foreign.
  const marker = planned.at(-1)!;
  const write = (file: { full: string; content: string }): void => {
    mkdirSync(dirname(file.full), { recursive: true });
    writeFileSync(file.full, file.content, "utf8");
  };
  const unwritten = (file: { full: string }, err: unknown): string =>
    `${shown}/${relForwardSlash(root, file.full)} could not be written (${
      (err as NodeJS.ErrnoException | undefined)?.code ?? (err instanceof Error ? err.message : String(err))
    })`;
  write(marker);
  const routesFull = join(root, ROUTES_MANIFEST_BASENAME);
  for (const file of planned.slice(0, -1)) {
    try {
      write(file);
    } catch (err) {
      // The route manifest is derived — `routes --emit` rewrites it — so the
      // tree is still whole without it: said, and dropped from the record.
      if (file.full === routesFull) {
        warn(`${unwritten(file, err)}. The tree is complete without it; fix the path and run \`xanosdk routes ${shown}/index.ts --emit ${shown}/${ROUTES_MANIFEST_BASENAME}\`.`, "routes.not-written");
        write({ full: marker.full, content: markerFor(decoded.filter((f) => f.path !== ROUTES_MANIFEST_BASENAME)) });
        continue;
      }
      throw new UsageError(
        `${unwritten(file, err)}. The tree is partial; fix the path and re-run with \`--force\` to replace it.`,
      );
    }
  }
  if (lock !== undefined && reconciliation !== undefined) {
    writeLockFile(lockPath, pulledLock(lock, reconciliation, loaded.bundle.payload));
  }

  // Both secret files get a rule, the `.env` included: the tree's own
  // `.env.example` tells its reader to create one. Placed in the project the
  // tree sits in, or — when the cwd is no project — inside the tree itself.
  const ignoreRoot = ignoreRootFor(root);
  const placement = (basename: string): IgnorePlacement => ({
    root: ignoreRoot,
    label: `${shown}/${basename}`,
  });
  ensureSecretPathGitignored(join(root, WORKSPACE_ENV_BASENAME), placement(WORKSPACE_ENV_BASENAME));
  writeDocumentationTokens(
    root,
    project.documentationTokens,
    args,
    loaded.label,
    join(root, WORKSPACE_SECRETS_BASENAME),
    placement(WORKSPACE_SECRETS_BASENAME),
  );

  // The env VALUES the bundle carried land in the tree's `.env`, owner-only and
  // gitignored — what `init --from` does with the same bundle. `generate` used
  // to drop them, and a piped run did not even say it had. `--no-secrets`
  // declines both secret files. Said on stderr under machine output too.
  const env = writeBundleEnvValues(root, project.env, args, loaded.label, loaded.kind, {
    dir: root,
    rel: `${shown}/${WORKSPACE_ENV_BASENAME}`,
    command: "generate",
    place: placement(WORKSPACE_ENV_BASENAME),
  });
  // A declared name the bundle stores empty and the tree's `.env` does not carry
  // (declined or not written): a deploy refuses until it is supplied.
  const valueless = env.declared.filter((n) => project.env[n] === "" && !env.written.includes(n));
  if (valueless.length > 0) {
    warn(
      `${valueless.length} env var${valueless.length === 1 ? "" : "s"} declared with no value in the bundle ` +
        `(${safeNames(valueless)}) — see ${shown}/.env.example. Supply ${valueless.length === 1 ? "it" : "them"} ` +
        `in ${shown}/${WORKSPACE_ENV_BASENAME} or with \`--env-var\` at deploy.`,
      "workspace-env.valueless",
    );
  }

  // Said under machine output too (stderr): a file left in a tree the reader
  // believes is decoded is exactly what a script's author needs to see.
  if (kept.length > 0) {
    warn(
      `Kept ${kept.length} file${kept.length === 1 ? "" : "s"} no decode wrote — ` +
        `${kept.length === 1 ? "it is" : "they are"} yours, and ${kept.length === 1 ? "it is" : "they are"} ` +
        `not part of the decoded tree:`,
      "pull.kept-files",
      [...kept.slice(0, 20).map((p) => `  ${shown}/${p}`), ...(kept.length > 20 ? [`  … and ${kept.length - 20} more`] : [])],
    );
  }
  // Said beside the kept list and under machine output too (stderr): a file the
  // replace DELETED is the half of the change a reader can least afford to miss.
  if (removed.length > 0) {
    info(
      `Removed ${removed.length} file${removed.length === 1 ? "" : "s"} the previous decode wrote ` +
        `and this one does not:`,
    );
    for (const p of removed.slice(0, 20)) detail(`  ${shown}/${p}`);
    if (removed.length > 20) detail(`  … and ${removed.length - 20} more`);
  }
  const routesNotes = (): void => {
    if (routesDeferred.length === 0) return;
    const bare = !existsSync(join(projectRootFrom(dirname(root)), "package.json"));
    for (const line of routesDeferred) {
      warn(
        bare
          ? `${line} No package.json holds this tree, so that export cannot load \`@xano/sdk\` yet — ` +
              `run \`npm init -y && npm install @xano/sdk\` here first.`
          : line,
        "routes.not-written",
      );
    }
  };
  // The decode's findings: the README lists them, and machine output carries
  // them as data under `report` — the shape `init --from` answers with. The
  // headline is said on stderr either way, so a problem never sits unread.
  const headline = project.report.headline();
  const reportLine = (): void => {
    if (headline === "") return;
    const summary = project.report.summarize();
    const line = `Decode report: ${headline} — listed in ${shown}/README.md.`;
    if (summary.bySeverity.error + summary.bySeverity.warning > 0) warn(line, "decode.findings");
    else info(line);
    // The files the tree reads but the source did not carry are each a line to
    // act on (save the image, the hostedFile() to write), so they are printed
    // here as `init --from` prints them rather than left to the README.
    const notRecovered = project.report.renderCli({ categories: ["file-not-recovered"], fileBase: `${shown}/` });
    if (notRecovered !== "") process.stderr.write(`${terminalText(notRecovered)}\n`);
  };
  // As `pull` and `init --from` say it: a seeded release's rows are not in the tree.
  const seedNote = (): void => {
    if (loaded.seed !== undefined) reportSeedRows(loaded.seed.rows, loaded.label, loaded.seed.provenance, shown, contextFlags(args));
  };
  if (isMachineOutput(args)) {
    routesNotes();
    reportLine();
    seedNote();
    // Paths as the human lines print them — under `--out` as the reader named
    // it (`xano/function/x.ts`), the way `pull` and `init --from` report
    // project-relative paths — never bare tree-relative ones a script would
    // have to re-root.
    const under = (p: string): string => `${shown}/${p}`;
    writeJson({
      source: raw,
      ...loaded.backend,
      out: root,
      declined: false,
      files: files.length,
      removed: removed.map(under),
      removedEdited: plan.removedEdited.map(under),
      // The other half of "your edits were lost": files you edited that this
      // decode REWROTE rather than removed. `--yes` answered for both.
      rewrittenEdited: plan.edited.map(under),
      kept: kept.map(under),
      lockKept: reconciliation?.kept.length ?? 0,
      lockDropped: reconciliation?.dropped.length ?? 0,
      // Names only — a value never reaches stdout.
      env: {
        declared: env.declared,
        written: env.written,
        notWritten: [...new Set([...env.notWritten, ...valueless])],
        ...(env.reason !== undefined ? { declined: env.reason } : {}),
      },
      report: project.report.toJson(),
      seedRows: loaded.seed?.rows ?? [],
    });
    return;
  }
  success(`Generated ${shown}/ from ${loaded.label}`);
  detail(`${files.length} files written${removed.length > 0 ? `, ${removed.length} removed` : ""}`);
  routesNotes();
  reportLine();
  seedNote();
  if (reconciliation !== undefined) {
    detail(`lock: ${reconciliation.kept.length} kept, ${reconciliation.dropped.length} dropped`);
    if (reconciliation.disjoint) {
      warn(
        `None of xano.lock's entries appear in ${loaded.label}, so this tree now points at a ` +
          `different backend. Its lock was emptied rather than carried across.`,
        "lock.repointed",
      );
    }
  }
}
