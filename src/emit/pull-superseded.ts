/**
 * What a pull SUPERSEDES without deleting it — said before the tree is
 * replaced, so a kept file is never silently dead.
 *
 * Two ways the rewritten entry stops using something the project still holds:
 *
 * - A file no decode wrote (kept, as every pull keeps one) that defines an
 *   object the pulled tree also declares — the scaffold's `tables/notes.ts`
 *   beside the decoded `table/notes.ts`. The rewritten `index.ts` registers the
 *   decoded one, so the kept file still compiles and editing it does nothing.
 * - A module registration (`registerAuth(app, …)`) in a file the pull rewrites:
 *   the decode carries the module's objects as plain copies, so a later upgrade
 *   of the module no longer reaches them.
 *
 * Read off the text — the tree is about to be replaced, so there is no compile
 * to ask. Nothing here deletes a file: the remedy is printed, not run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "../util/shell-quote.js";
import { pastePath } from "./typed-cwd.js";
import { warn } from "./ui.js";
import { registeredModules, withoutComments } from "./register-calls.js";

/** One object a file declares: its factory, its name, and its verb when it has one. */
interface DeclaredDef {
  readonly kind: string;
  readonly name: string;
  readonly verb?: string;
}

/** A kept file whose objects the pulled tree declares too. */
export interface KeptDuplicate {
  /** The kept file, `<backendDir>/…`. */
  readonly file: string;
  /** Each object it shares with the pulled tree, with the pulled file that now declares it. */
  readonly objects: ReadonlyArray<{ kind: string; name: string; verb?: string; into: string }>;
  /** Whether everything the file declares is in the pulled tree — so deleting it loses nothing. */
  readonly only: boolean;
}

/** A module registration a rewritten file carries and its pulled version does not. */
export interface ReplacedRegistration {
  readonly file: string;
  readonly pkg: string;
  readonly register: string;
}

/** The factories the decoded tree declares objects with: each `kind({ name: "…"` it writes. */
function factoriesOf(incoming: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>();
  for (const text of incoming.values()) {
    for (const m of withoutComments(text).matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(\s*\{\s*name\s*:\s*["'`]/g)) out.add(m[1]!);
  }
  return out;
}

/** The objects `text` declares through one of `factories`: the text from one call to the next is that call. */
function declaredDefs(text: string, factories: ReadonlySet<string>): DeclaredDef[] {
  if (factories.size === 0) return [];
  const code = withoutComments(text);
  const call = new RegExp(`(?<![\\w$.])(${[...factories].map((f) => f.replace(/\$/g, "\\$")).join("|")})\\s*\\(\\s*\\{`, "g");
  const starts = [...code.matchAll(call)].map((m) => ({ at: m.index, kind: m[1]! }));
  const out: DeclaredDef[] = [];
  starts.forEach(({ at, kind }, i) => {
    const chunk = code.slice(at, starts[i + 1]?.at ?? code.length);
    const name = /\bname\s*:\s*(["'`])([^"'`]+)\1/.exec(chunk)?.[2];
    if (name === undefined) return;
    const verb = /\bverb\s*:\s*(["'`])([A-Za-z]+)\1/.exec(chunk)?.[2];
    out.push({ kind, name, ...(verb === undefined ? {} : { verb: verb.toUpperCase() }) });
  });
  return out;
}

const keyOf = (d: DeclaredDef): string => `${d.kind}\0${d.name}\0${d.verb ?? ""}`;

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The kept files that define an object the pulled tree also declares. Exported for tests. */
export function keptDuplicates(
  dirAbs: string,
  incoming: ReadonlyMap<string, string>,
  kept: readonly string[],
  backendDir: string,
): KeptDuplicate[] {
  const factories = factoriesOf(incoming);
  const pulled = new Map<string, string>();
  for (const [p, text] of incoming) {
    for (const d of declaredDefs(text, factories)) if (!pulled.has(keyOf(d))) pulled.set(keyOf(d), `${backendDir}/${p}`);
  }
  const out: KeptDuplicate[] = [];
  for (const p of kept) {
    const text = read(join(dirAbs, p));
    if (text === undefined) continue;
    const defs = declaredDefs(text, factories);
    const objects = defs.flatMap((d) => {
      const into = pulled.get(keyOf(d));
      return into === undefined ? [] : [{ ...d, into }];
    });
    if (objects.length > 0) out.push({ file: `${backendDir}/${p}`, objects, only: objects.length === defs.length });
  }
  return out;
}

/** The module registrations the files this pull rewrites carry today and lose. Exported for tests. */
export function replacedRegistrations(
  dirAbs: string,
  incoming: ReadonlyMap<string, string>,
  rewritten: readonly string[],
  backendDir: string,
): ReplacedRegistration[] {
  const out: ReplacedRegistration[] = [];
  for (const p of rewritten) {
    const current = read(join(dirAbs, p));
    if (current === undefined) continue;
    const after = new Set(registeredModules(withoutComments(incoming.get(p) ?? "")).map((r) => `${r.pkg}\0${r.register}`));
    for (const r of registeredModules(withoutComments(current))) {
      if (!after.has(`${r.pkg}\0${r.register}`)) out.push({ file: `${backendDir}/${p}`, ...r });
    }
  }
  return out;
}

const label = (o: { kind: string; name: string; verb?: string }): string =>
  `${o.kind} "${o.name}"${o.verb === undefined ? "" : ` (${o.verb})`}`;

/**
 * Say both, before the confirmation. `inGit` is a clean git tree: then the
 * whole pull undoes with git alone, which is the one exact way back to a module
 * registration — the decoded copies of its objects are spread across the tree.
 */
export function reportSuperseded(
  duplicates: readonly KeptDuplicate[],
  replaced: readonly ReplacedRegistration[],
  backendDir: string,
  inCleanGit: boolean,
): void {
  if (duplicates.length > 0) {
    const one = duplicates.length === 1;
    const lines = duplicates.map(
      (d) =>
        `${pastePath(d.file)}: ${d.objects.map((o) => `${label(o)} → ${pastePath(o.into)}`).join(", ")}` +
        (d.only ? "" : ` — it declares more than that, so move the rest into the decoded tree before deleting it`),
    );
    const removable = duplicates.filter((d) => d.only).map((d) => shellQuote(pastePath(d.file)));
    warn(
      `${duplicates.length} kept file${one ? " defines" : "s define"} objects the decoded tree declares too. ` +
        `${pastePath(`${backendDir}/index.ts`)} registers the decoded copies, so ${one ? "that file is" : "those files are"} no longer ` +
        `part of the project and editing ${one ? "it" : "them"} changes nothing:`,
      "pull.kept-duplicates",
      [...lines, ...(removable.length > 0 ? [`Once the new tree is written, delete the duplicates: \`rm ${removable.join(" ")}\``] : [])],
    );
  }
  for (const r of replaced) {
    const back = inCleanGit
      ? `To keep the module registered instead, undo the replace right after it lands: ` +
        `\`git checkout HEAD -- ${shellQuote(pastePath(backendDir))} && git clean -fd -- ${shellQuote(pastePath(backendDir))}\``
      : `To keep the module registered instead, re-add its import and \`${r.register}(…)\` call to ${pastePath(r.file)} ` +
        `and drop the decoded copies of its objects from the register lists there`;
    warn(
      `${pastePath(r.file)} registers ${r.pkg} (\`${r.register}\`), and the decoded entry registers plain copies ` +
        `of the objects it contributed instead — a later ${r.pkg} upgrade no longer reaches them.`,
      "pull.module-replaced",
      [back],
    );
  }
}
