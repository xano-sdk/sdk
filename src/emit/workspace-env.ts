/**
 * Where a project's backend env VALUES come from, and what it means when one is
 * missing.
 *
 * `workspaceConfig({ env })` declares the NAMES a backend reads with
 * `env("NAME")`; a pulled tree declares them with empty placeholders so the
 * values never land in the repo. The values live in `xano/.env` — beside the
 * backend they configure, ignored by git, and preserved across a `xano/`
 * refresh (see `PRESERVED_ON_REFRESH` in `scaffold.ts`).
 *
 * One module owns three facts so `init`, the pull path and the CLI cannot
 * disagree about any of them:
 *
 * - the default path, resolved against the PROJECT rather than the cwd;
 * - the three-state classification of a declared name (supplied, deliberately
 *   empty, unsupplied) — a deploy REPLACES the target's env set, so the third
 *   state would silently clear a live value;
 * - the rendering of `xano/.env.example`, the committed template.
 *
 * The renderer takes names and a representability FLAG, never values. That
 * signature is the guard: a renderer that cannot receive a value cannot leak one
 * into a committed file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { displayPath } from "../util/rel-path.js";
import { LocalFileNotFoundError, UsageError } from "./errors.js";

/** The backend directory. Duplicated from `scaffold.ts` would be one too many. */
import { XANO_DIR } from "./scaffold.js";
import { backendDirFor, backendDirIn, projectRootFrom } from "./backend-dir.js";

/**
 * Re-exported from its new home. It moved to `backend-dir.ts` so the two
 * backend-directory resolvers could build on it without an import cycle; every
 * caller that reads it off this module keeps working.
 */
export { projectRootFrom };

/**
 * The name-shape test and the remote-name neutralizer, owned by
 * `util/env-name.ts` because the build-time guards need `safeNames` too and must
 * stay free of `node:fs` — they run on the browser-safe authoring path.
 * Re-exported here so every existing caller keeps reading them off the module
 * that owns `xano/.env`.
 */
import { isRepresentableName, safeNames } from "../util/env-name.js";
export { isRepresentableName, safeNames };

/**
 * The two filenames, without a directory.
 *
 * Separate from the `xano/`-prefixed spellings below because the prefix is no
 * longer a constant: a project keeps these beside its backend, which is `xano/`
 * for a scaffolded one and whatever directory the project chose otherwise. A
 * caller composing a path for a REAL project joins the basename onto the
 * resolved directory; the prefixed constants stay for the fallback labels, where
 * the point is to name the convention rather than a resolved file.
 */
export const WORKSPACE_ENV_BASENAME = ".env";
export const WORKSPACE_ENV_EXAMPLE_BASENAME = ".env.example";

/** `xano/.env` — the scaffold's spelling, and the label used when none resolves. */
export const WORKSPACE_ENV_FILE = `${XANO_DIR}/${WORKSPACE_ENV_BASENAME}`;

/** `xano/.env.example` — the same, for the committed template. */
export const WORKSPACE_ENV_EXAMPLE_FILE = `${XANO_DIR}/${WORKSPACE_ENV_EXAMPLE_BASENAME}`;

/**
 * The backend `.env` path for a command running in `cwd` — `xano/.env` in a
 * scaffolded project, and beside the backend wherever else it lives.
 *
 * The directory is {@link backendDirIn}'s answer rather than a hard
 * `join(root, XANO_DIR)`, so a project whose backend is a sibling reads the
 * file that sits next to its source instead of one in a directory holding no
 * source at all.
 */
export function workspaceEnvPathIn(cwd: string): string {
  return join(backendDirIn(projectRootFrom(cwd)), ".env");
}

/**
 * The same file for a build, resolved from the entry it is compiling.
 *
 * {@link backendDirFor}, not the cwd walk above: the caller NAMED this source,
 * so the values that configure it are the ones beside it. Deriving them from
 * the project root instead is what let `export ./backend/index.ts` report "no
 * `xano/.env` found" while the values sat in `backend/.env`, and then read a
 * stray `xano/.env` in preference to them.
 */
export function defaultWorkspaceEnvPath(file: string): string {
  return join(backendDirFor(file), ".env");
}

/**
 * The env var names a workspace registry declares, in authored order, with the
 * values the source itself carries.
 *
 * Reads the same `workspaceSettings()` view the deploy path already uses, so the
 * declared set is read from one place whether it came from hand-written source
 * or from a pull's placeholders.
 *
 * The values matter for exactly one decision: whether an unsupplied name would
 * be sent EMPTY. A pulled tree declares placeholders (`FOO: ""`), so every
 * unsupplied name there clears a live value; a hand-authored config that spells
 * out `APP_BASE_URL: "https://…"` carries its own value and clears nothing. The
 * two cannot be told apart from the names alone.
 */
export function declaredEnv(
  settings: Readonly<Record<string, unknown>>,
): Array<{ name: string; value: string }> {
  const env = settings.env;
  if (!Array.isArray(env)) return [];
  return env
    .map((e) => e as { name?: unknown; value?: unknown })
    .filter((e): e is { name: string; value?: unknown } => typeof e.name === "string" && e.name !== "")
    .map((e) => ({ name: e.name, value: typeof e.value === "string" ? e.value : "" }));
}

/**
 * Can this value survive a round trip through the dotenv format?
 *
 * `parseEnvFile` is strictly line-based: it splits on `\n`, trims, and strips
 * one matched quote pair. A value carrying a newline (a PEM key, a
 * service-account JSON) or significant edge whitespace cannot be expressed, and
 * writing it anyway would truncate a secret into something that still looks
 * valid. Callers derive the flag from the value; nothing that renders a file
 * ever sees the value itself.
 */
export function isRepresentable(value: string): boolean {
  return isRepresentableValue(value);
}

/** The value half of {@link isRepresentable}. */
function isRepresentableValue(value: string): boolean {
  return valueProblem(value) === undefined;
}

/** Why a value cannot live in the dotenv format, or undefined when it can. */
export type EnvValueProblem = "newline" | "edge-whitespace" | "quoted";

/** Why the dotenv format cannot carry `value`, or undefined when it can. */
export function valueProblem(value: string): EnvValueProblem | undefined {
  if (/[\n\r]/.test(value)) return "newline";
  if (value !== value.trim()) return "edge-whitespace";
  // A value that starts AND ends with the same quote would come back stripped.
  return isQuoted(value) ? "quoted" : undefined;
}

/** {@link EnvValueProblem} in words, completing "its value …". */
const VALUE_PROBLEM_WORDS: Record<EnvValueProblem, string> = {
  newline: "carries a newline",
  "edge-whitespace": "has leading or trailing whitespace",
  quoted: "is wrapped in a matching quote pair that reading the file would strip",
};

/**
 * Is this value wrapped in one matched pair of quotes?
 *
 * The write-side guard and the read-side strip ask the same question, so they
 * ask it in the same place — two spellings could drift, and what they would
 * drift out of is exactly the round-trip property {@link isRepresentable}
 * exists to assert.
 */
function isQuoted(value: string): boolean {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote);
}

/** What a build resolved its backend env to, and what it could not resolve. */
export interface EnvResolution {
  /** Name→value, ready to merge into the bundle. */
  readonly values: Record<string, string>;
  /**
   * Declared names that no file and no flag supplied a value for AND whose
   * source value is empty — i.e. the ones a deploy would write as `""`,
   * clearing whatever the target holds.
   *
   * The ONE set any policy is keyed on, which is why it is the only one
   * returned. A declared name the source spells a real value for is unsupplied
   * and harmless: that value is what gets sent, and a second array naming it
   * would only invite a future caller to refuse on the wrong one.
   */
  readonly clearing: readonly string[];
  /** Supplied names the config does not declare — legitimate, and also a typo. */
  readonly additions: readonly string[];
}

/**
 * The three-state classification, per declared name.
 *
 * | in the file | value | result |
 * |---|---|---|
 * | present | non-empty | sent |
 * | present | empty | sent as empty — explicit author intent |
 * | absent | — | unsupplied |
 *
 * The middle row is why this cannot be `values[name] ? … : …`: an author who
 * wrote `FOO=` meant to clear it, and conflating that with "no line at all"
 * would either refuse a legitimate deploy or silently clear a live value.
 *
 * No filtering: the file is backend-dedicated, so every name in it is sent,
 * exactly as an explicit `--backend-env-file` behaves.
 */
export function classifyEnv(args: {
  readonly fileValues: Readonly<Record<string, string>>;
  readonly flagValues: Readonly<Record<string, string>>;
  readonly declaredNames: readonly string[];
  /**
   * The values the SOURCE declares, name→value. Absent or unknown reads as
   * empty — the placeholder case, which is the one that clears a live value.
   */
  readonly declaredValues?: Readonly<Record<string, string>>;
}): EnvResolution {
  // Null-prototype, so a name like `__proto__` from the file is a key here too.
  const values = Object.assign(Object.create(null) as Record<string, string>, args.fileValues, args.flagValues);
  const supplied = new Set(Object.keys(values));
  const declared = new Set(args.declaredNames);
  const declaredValues = args.declaredValues ?? {};
  return {
    values,
    clearing: args.declaredNames.filter(
      (n) => !supplied.has(n) && (Object.hasOwn(declaredValues, n) ? declaredValues[n] : "") === "",
    ),
    additions: Object.keys(values).filter((n) => !declared.has(n)),
  };
}

/**
 * Read a dotenv-style `KEY=VALUE` file.
 *
 * The ONE parser, shared by the default path and the explicit `--backend-env-file`, so
 * the two cannot diverge on what a line means. Deliberately minimal: `#`
 * comments, blank lines, an optional `export ` prefix, and one matching pair of
 * surrounding quotes stripped. No interpolation, no multi-line values, no
 * escape sequences — a secret is an opaque string, and a parser that rewrites
 * it is a parser that can corrupt it silently.
 *
 * `label` names the source in an error: the flag when one was passed, the file
 * when the default found it.
 */
export function parseEnvFile(path: string, label = "--backend-env-file"): Record<string, string> {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    // A flag's path that cannot be read is a mistake in the command line —
    // usage, like `--bundle`, whether it is unreadable or not there at all. The
    // default file is only read when it exists.
    const missing = (err as { code?: unknown }).code === "ENOENT";
    throw new (!label.startsWith("--") ? Error : missing ? LocalFileNotFoundError : UsageError)(
      `${label}: could not read ${displayPath(path)}. ` +
        `Check the path, and make sure the file is present wherever this runs (a CI secret ` +
        `mounted at deploy time, not a file committed to the repo).`,
    );
  }
  // Null-prototype: `__proto__=x` on a plain `{}` sets a prototype and the
  // line is silently lost; here it is a name like any other.
  const out = Object.create(null) as Record<string, string>;
  for (const [n, raw] of source.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `${label}: ${displayPath(path)} line ${n + 1} is not ` +
          `KEY=VALUE. Comments start with "#"; blank lines are ignored.`,
      );
    }
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (isQuoted(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** Read `path` if it is there; `undefined` when it is not. */
export function readWorkspaceEnvFile(path: string): Record<string, string> | undefined {
  if (!existsSync(path)) return undefined;
  return parseEnvFile(path, WORKSPACE_ENV_FILE);
}

/**
 * A name, rendered safely inside a `#` comment line.
 *
 * The names being reported here are the ones that FAILED the shape test, so by
 * construction they may carry a newline — which would end the comment and turn
 * the rest into a live `KEY=VALUE` line, re-introducing through the explanation
 * exactly what the omission prevented.
 */
function commentSafe(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001F\u007F]/g, "?");
}

/** One declared name, plus whether its value can live in the file at all. */
export interface EnvExampleName {
  readonly name: string;
  /**
   * Derived by the CALLER from the value. `true` when no value is in hand — an
   * unknown value is not an unwritable one.
   */
  readonly representable: boolean;
  /**
   * Why it is not representable: the NAME is not one an env var can have, or
   * the value has a {@link EnvValueProblem}. Absent, a value problem is assumed.
   */
  readonly problem?: "name" | EnvValueProblem;
}

/**
 * How the two env files are named in what the renderers write: beside the
 * backend directory they were rendered for, so a tree outside `xano/` never
 * tells its reader to copy a file that is not there.
 */
function envFileLabels(backendDir: string): { env: string; example: string } {
  return {
    env: `${backendDir}/${WORKSPACE_ENV_BASENAME}`,
    example: `${backendDir}/${WORKSPACE_ENV_EXAMPLE_BASENAME}`,
  };
}

/**
 * Render the whole of `xano/.env.example` — or of `<backendDir>/.env.example`.
 *
 * A committed generated file, so this is a pure function of the name list:
 * re-rendering an unchanged workspace must produce a byte-identical file or
 * every pull ships a spurious diff.
 *
 * Every name line is COMMENTED, so the template parses to zero values and a
 * user who copies it to `xano/.env` without editing gets the refusal rather
 * than a set of empty strings sent to their backend.
 */
export function renderWorkspaceEnvExample(
  names: readonly EnvExampleName[],
  backendDir: string = XANO_DIR,
): string {
  const { env: envFile, example: exampleFile } = envFileLabels(backendDir);
  const header = `# ${exampleFile} — the template for ${envFile}.
#
# ${backendDir}/ is COMMITTED in full: the source, the lock, and this file. Two
# files are ignored on purpose, and which secret goes in which is decided by how
# that secret is ADDRESSED. Do not "tidy" this up by ignoring ${backendDir}/
# wholesale: the source is the review surface.
#
#   - ${envFile} — BACKEND variables, addressed by NAME. Declared by
#     \`workspaceConfig({ env })\` and read at request time with \`env("NAME")\`.
#     Those names are listed below; the values are yours to fill in.
#   - ${backendDir}/.secrets.json — DOCUMENTATION tokens, addressed by the OBJECT
#     that holds them (the workspace, or an API group). They have no name of
#     their own, so they are not listed here at all. \`npx xanosdk pull\` writes that
#     file and every build reads it back; nobody edits it by hand. They are NOT
#     backend variables: they never reach the workspace's env, and
#     \`env("NAME")\` does not read them.
#
# To fill it in:
#
#   cp ${exampleFile} ${envFile}   # then edit in the values
#   npx xanosdk env pull                        # or fetch them from a running backend
#
# Every command that compiles a bundle (deploy, export, preflight) reads
# ${envFile} by default. CI does not have it — the file is ignored — so an
# automated deploy mounts its own and passes \`--backend-env-file <path>\`, or supplies
# names one at a time with \`--env-var KEY=VALUE\`.
#
# A deploy REPLACES the backend's env set. A name declared in
# \`workspaceConfig({ env })\` with no line in ${envFile} therefore REFUSES the
# deploy rather than clearing the live value; \`--allow-empty-env=NAME\` opts one
# name out of that. The refusal is part of the compile, so a pre-built bundle
# (\`deploy --bundle <path>\`) ships whatever env it was built with — resolve the
# values on the \`export\` that builds it.
#
# A documentation token follows the same discipline in its own file, with
# \`--allow-empty-doc-token=<scope>\` as its opt-out — but an UNSUPPLIED one emits
# no \`documentation\` block at all, so a bundle built without it leaves the
# target's gate alone rather than clearing it. Only the opt-out clears a gate,
# and clearing one makes that doc site publicly readable.
#
# This file is generated. Every pull, and every export, rewrites it from the
# names the backend declares. ${envFile} is yours: neither touches it. Only
# \`npx xanosdk env pull\` (which asks before replacing it), and \`npx xanosdk init --from\`
# or \`npx xanosdk generate\` on a bundle that carries values, write it.
`;

  if (names.length === 0) {
    return `${header}#
# This backend declares no env vars. Add them with \`workspaceConfig({ env })\`
# and the next export or pull will list them here. (Documentation tokens are never listed
# here — they live in ${backendDir}/.secrets.json, keyed by the object they gate.)
`;
  }

  const lines = names.map(({ name, representable, problem }) =>
    representable
      ? `# ${commentSafe(name)}=`
      : problem === "name"
        ? // No `NAME=` shape: the line must not parse back as a declared name, and
          // no flag can supply a name `--env-var` refuses.
          `# "${commentSafe(name)}"   (not a usable env var name — letters, digits and _, not starting
#   with a digit — so no file or flag can supply it. Rename it in \`workspaceConfig({ env })\`.)`
        : `# ${commentSafe(name)}=   (this value cannot be written here — it ${VALUE_PROBLEM_WORDS[problem ?? "newline"]},
#   so the dotenv format cannot carry it. Pass it with
#   \`--env-var ${commentSafe(name)}=...\` instead.)`,
  );
  return `${header}#
# One line per declared name. Uncomment and fill in the ones you need.

${lines.join("\n")}
`;
}

/**
 * The names an existing `xano/.env.example` declares.
 *
 * Read from the generated file rather than from the previous source, because it
 * is OUR format — one commented `# NAME=` line per declared name — and it is
 * rewritten by the same renderer on every pull. Parsing the old `workspace.ts`
 * would mean parsing TypeScript to answer a question the template already
 * answers exactly.
 *
 * Returns an empty list for a file that is absent or carries none, which reads
 * as "nothing was declared before" — the right answer for a first pull.
 */
export function namesInEnvExample(path: string): string[] {
  if (!existsSync(path)) return [];
  const out: string[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    // Commented as generated, or uncommented by someone filling it in.
    const m = /^#?\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(raw.trim());
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * Render the real `xano/.env` — the ONE place in this SDK that writes a secret.
 *
 * Separate from {@link renderWorkspaceEnvExample} on purpose, and named so the
 * difference is unmissable: that one cannot receive a value, this one is the
 * single function that may.
 *
 * The provenance header is not decoration. One project reads one `xano/.env`
 * regardless of which environment it deploys to, so "which environment are
 * these from?" has no other answer once the terminal scrollback is gone.
 *
 * Values the format cannot represent are NOT written: truncating a secret into
 * something that still looks valid is worse than not having it, and the
 * authoritative copy is still in the workspace. They come back as `omitted` for
 * the caller to name.
 */
export function renderWorkspaceEnvFile(
  values: Readonly<Record<string, string>>,
  provenance: { source: string; at: string },
  backendDir: string = XANO_DIR,
  /**
   * Whether `<backendDir>/.env.example` exists beside it. False, the header
   * names no template: a project that was never scaffolded has none, and
   * pointing at it sends the reader looking for a file that is not there.
   */
  exampleExists = true,
  /** The command writing it, for the provenance header. */
  writer = "xanosdk env pull",
): { content: string; omitted: string[] } {
  const { env: envFile, example: exampleFile } = envFileLabels(backendDir);
  const omitted: string[] = [];
  const lines: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (isRepresentableName(name) && isRepresentableValue(value)) lines.push(`${name}=${value}`);
    else omitted.push(name);
  }
  const badNames = omitted.filter((n) => !isRepresentableName(n));
  const badValues = omitted.filter((n) => isRepresentableName(n));
  const header = `# ${envFile} — backend env values. NOT committed${exampleExists ? ` (see ${exampleFile})` : ""}.
#
# Written by \`${writer}\` from: ${provenance.source}
# at ${provenance.at}
#
# Every command that compiles a bundle reads this file by default. Re-running
# \`npx xanosdk env pull\` REPLACES it wholesale.
${
  // A NAME no env var can have is said as the name's fault: blaming its value
  // ("no newlines or edge whitespace") sent the reader to a value that was fine.
  badValues.length === 0
    ? ""
    : `#
# NOT written, because the dotenv format cannot carry ${badValues.length === 1 ? "its value" : "their values"}
# (a newline, edge whitespace, or a wrapping quote pair): ${badValues.map(commentSafe).join(", ")}.
# Pass ${badValues.length === 1 ? "it" : "each"} at deploy time with \`--env-var NAME=...\` instead.
`
}${
  badNames.length === 0
    ? ""
    : `#
# NOT written, because ${badNames.length === 1 ? "it is not a usable env var name" : "they are not usable env var names"}
# (letters, digits and _, not starting with a digit): ${badNames.map((n) => `"${commentSafe(n)}"`).join(", ")}.
`
}`;
  return {
    content:
      lines.length === 0
        ? `${header}#
# This backend declares no env vars, so there is nothing to fill in.
`
        : `${header}
${lines.join("\n")}
`,
    omitted,
  };
}
