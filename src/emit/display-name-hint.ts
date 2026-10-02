/**
 * "That is the display name of X" — the hint a gone tenant or ephemeral gets
 * when the name typed is the one people CALL it.
 *
 * Every tenant and ephemeral has a NAME, which the routes address it by, and a
 * display name, which the dashboard shows and people repeat. Given the display
 * name, a lookup finds nothing, and "No tenant named" reads as a backend that
 * does not exist. One list read, made only on that failure, turns it into the
 * name to type.
 *
 * Shared by the selector resolver (`tenant:<display>`, `ephemeral:<display>`,
 * wherever a selector is taken) and by the verbs that take a bare name
 * (`tenant get|deploy|delete`, `ephemeral get`), so the lookup is one thing and
 * each caller only chooses how the fix is spelled.
 */
import type { ResolvedAuth } from "../auth/token.js";
import { listTenants } from "../deploy/tenant.js";
import { listEphemeral } from "../deploy/ephemeral.js";
import { shellWord } from "./command-line.js";
import { safeText } from "./ui.js";

/** The kinds that carry a display name beside their name. */
export type DisplayNamedKind = "tenant" | "ephemeral";

/** One of several backends that share a display name, with what tells them apart. */
export interface DisplayOwnerRow {
  kind: DisplayNamedKind;
  name: string;
  /** `running, https://…, last release #12` — the parts the row carries. */
  detail: string;
}

/**
 * A display name more than one backend carries. No one of them is "the" one
 * meant, so a caller names every one, each with its own command, and never
 * hands out a confirmed (`--yes`) command for a guess.
 */
export interface SharedDisplay {
  owners: readonly DisplayOwnerRow[];
}

/** The answer of a display-name lookup: the one NAME, or every owner when it is shared. */
export type DisplayOwner = string | SharedDisplay;

/** `true` for a display name several backends share. */
export function isShared(owner: unknown): owner is SharedDisplay {
  return typeof owner === "object" && owner !== null && "owners" in owner;
}

type ListedRow = { name: string; display?: string | undefined; url?: string | undefined; state?: string | undefined; deployedReleaseId?: number | undefined };

function ownerRow(kind: DisplayNamedKind, r: ListedRow): DisplayOwnerRow {
  const parts = [r.state, r.url, r.deployedReleaseId === undefined ? undefined : `last release #${r.deployedReleaseId}`].filter(
    (p): p is string => p !== undefined && p !== "",
  );
  return { kind, name: r.name, detail: parts.join(", ") };
}

async function listedOwners(auth: ResolvedAuth, kind: DisplayNamedKind, display: string): Promise<DisplayOwnerRow[]> {
  const rows: readonly ListedRow[] =
    kind === "tenant"
      ? await listTenants(auth, { workspaceId: auth.workspaceId })
      : await listEphemeral(auth, { parentWorkspaceId: auth.workspaceId });
  return rows.filter((t) => t.display === display && t.name !== display).map((r) => ownerRow(kind, r));
}

function asOwner(rows: readonly DisplayOwnerRow[]): DisplayOwner | undefined {
  if (rows.length === 0) return undefined;
  return rows.length === 1 ? rows[0]!.name : { owners: rows };
}

/**
 * The NAME of the tenant or ephemeral whose display name is `display` — every
 * owner ({@link SharedDisplay}) when several carry it — or `undefined` when
 * none does, or when the list cannot be read, which leaves the original answer
 * standing rather than replacing it with a transport error. A display name
 * that is also the name of the one being looked for is no match: that lookup
 * would have found it.
 */
export async function displayNameOwner(
  auth: ResolvedAuth,
  kind: DisplayNamedKind,
  display: string,
): Promise<DisplayOwner | undefined> {
  try {
    return asOwner(await listedOwners(auth, kind, display));
  } catch {
    return undefined;
  }
}

/**
 * The hint for a display name several backends share: every one, with what
 * tells them apart and its own `fix` — a command that asks before acting,
 * since which one was meant is unknown.
 */
export function sharedDisplayHint(display: string, shared: SharedDisplay, fix: (row: DisplayOwnerRow) => string): string {
  const kinds = new Set(shared.owners.map((o) => o.kind));
  const noun = kinds.size === 1 ? `${[...kinds][0]}s` : "backends";
  return (
    `"${safeText(display)}" is the display name of ${shared.owners.length} ${noun} — commands take a name, so pick the one you mean:` +
    shared.owners.map((o) => `\n  ${o.kind} "${safeText(o.name)}"${o.detail === "" ? "" : ` (${safeText(o.detail)})`}: ${fix(o)}`).join("")
  );
}

/**
 * The tenant or ephemeral whose NAME — or DISPLAY name — is closest to `name`:
 * a typo's did-you-mean (E2E pass 26), read from the same lists as the
 * display-name check and only on a miss. A near display name answers with the
 * name it belongs to, and `display` says which one matched (E2E pass 27:
 * `e2e27a-eph2`, one letter from a display name, got nothing). `undefined`
 * when nothing is close, or no list reads.
 *
 * `strict`: a list that cannot be read throws instead of reading as empty —
 * for a caller whose answer turns on there being no near name (a delete's
 * "already gone", exit 0), where an unread list is not "nothing is close".
 */
export async function nearBackendName(
  auth: ResolvedAuth,
  kinds: readonly DisplayNamedKind[],
  name: string,
  strict = false,
): Promise<NearBackend | undefined> {
  const { suggestAll } = await import("../util/suggest.js");
  // Every list asked is one pool: a near display name a tenant and an
  // ephemeral share names both (E2E pass 53), each under its own kind.
  const rows: Array<ListedRow & { kind: DisplayNamedKind }> = [];
  for (const kind of kinds) {
    const read =
      kind === "tenant" ? listTenants(auth, { workspaceId: auth.workspaceId }) : listEphemeral(auth, { parentWorkspaceId: auth.workspaceId });
    rows.push(...(strict ? await read : await read.catch(() => [])).map((r) => ({ ...r, kind })));
  }
  const displayed = rows.filter((r) => r.display !== undefined && r.display !== "" && r.display !== r.name && r.display !== name);
  // Every name at the nearest distance, the look-alike first (E2E pass 27):
  // a tie is named, not settled by list order. A display name answers with
  // every backend that carries it.
  const near = suggestAll(name, [...rows.map((r) => r.name).filter((n) => n !== name), ...displayed.map((r) => r.display!)]);
  if (near.length === 0) return undefined;
  const isName = (hit: string): boolean => rows.some((r) => r.name === hit);
  const ownersOf = (hit: string): string[] => (isName(hit) ? [hit] : displayed.filter((r) => r.display === hit).map((r) => r.name));
  const names = [...new Set(near.flatMap(ownersOf))];
  const kindOf = (n: string): DisplayNamedKind => rows.find((r) => r.name === n)!.kind;
  const first = near[0]!;
  // The display name each tied candidate was matched by, when that is what was close.
  const displays: Record<string, string> = {};
  for (const hit of near) if (!isName(hit)) for (const owner of ownersOf(hit)) if (!near.includes(owner)) displays[owner] ??= hit;
  const mixed = new Set(names.map(kindOf)).size > 1;
  return {
    kind: kindOf(names[0]!),
    name: names[0]!,
    ...(isName(first) ? {} : { display: first }),
    ...(names.length > 1
      ? {
          names,
          ...(Object.keys(displays).length > 0 ? { displays } : {}),
          ...(mixed ? { kinds: Object.fromEntries(names.map((n) => [n, kindOf(n)])) } : {}),
        }
      : {}),
  };
}

/** A near miss: the backend's name, and the display name when that is what was close. */
export interface NearBackend {
  kind: DisplayNamedKind;
  name: string;
  display?: string;
  /** Every backend name a tie at the nearest distance named, `name` first — only when there are several. */
  names?: readonly string[];
  /** With `names`: the display name each one was matched by, for those a display name matched. */
  displays?: Readonly<Record<string, string>>;
  /** With `names`, when they are of more than one kind: each one's kind. */
  kinds?: Readonly<Record<string, DisplayNamedKind>>;
}

/** `ephemeral "e4f2-9ab1"`, plus `(display name "My App")` when the display is what matched. */
export function nearBackendLabel(near: NearBackend): string {
  if (near.names !== undefined && near.names.length > 1) {
    if (near.kinds !== undefined) return near.names.map((n) => `${near.kinds![n] ?? near.kind} "${safeText(n)}"`).join(" or ");
    return `${near.kind} ${near.names.map((n) => `"${safeText(n)}"`).join(" or ")}`;
  }
  return `${near.kind} "${safeText(near.name)}"${near.display === undefined ? "" : ` (display name "${safeText(near.display)}")`}`;
}

/**
 * The did-you-mean lines for a near miss, one per candidate, each with its own
 * `fix` — a tie names every candidate, never one command for the first of them
 * (E2E pass 41: three equally near names, and a ready delete of the first).
 * Each line starts with `\n`.
 */
export function nearBackendLines(near: NearBackend, fix: (name: string) => string): string {
  if (near.names === undefined || near.names.length < 2) return `\nDid you mean ${nearBackendLabel(near)}? ${fix(near.name)}`;
  return near.names
    .map((n) => {
      const display = near.displays?.[n];
      return `\nDid you mean ${near.kinds?.[n] ?? near.kind} "${safeText(n)}"${display === undefined ? "" : ` (display name "${safeText(display)}")`}? ${fix(n)}`;
    })
    .join("");
}

/** A fix phrase opening its own sentence — after a `Did you mean …?`. */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Which backend — tenant OR ephemeral — carries `display` as its display name.
 *
 * For a verb that takes either kind by one name (`tenant delete` deletes an
 * ephemeral too): the tenant list does not show ephemerals, so asking only it
 * answered an ephemeral's display name with "already gone" while the ephemeral
 * kept running. Both lists are asked, so a display name a tenant and an
 * ephemeral share reads as shared; `undefined` when neither list names it, or
 * neither can be read.
 */
export async function displayNameOwnerOfEither(
  auth: ResolvedAuth,
  display: string,
): Promise<{ kind: DisplayNamedKind; name: string } | SharedDisplay | undefined> {
  const rows: DisplayOwnerRow[] = [];
  for (const kind of ["tenant", "ephemeral"] as const) rows.push(...(await listedOwners(auth, kind, display).catch(() => [])));
  if (rows.length === 0) return undefined;
  return rows.length === 1 ? { kind: rows[0]!.kind, name: rows[0]!.name } : { owners: rows };
}

/**
 * The hint line: `"acme" is the display name of tenant "tcnv-hkmc-f8ae" — …`,
 * ending with `fix`, the spelling this caller takes (a selector, a verb).
 */
export function displayNameHint(kind: DisplayNamedKind, display: string, name: string, fix: string): string {
  return `"${safeText(display)}" is the display name of ${kind} "${safeText(name)}" — ${fix}`;
}

/**
 * The fix as a selector spells it: `tenant:<name>`, `ephemeral:<name>`. For a
 * `typo` of a name, the selector alone — "takes its name" answers a display name.
 */
export function selectorFix(kind: DisplayNamedKind, name: string, typo = false): string {
  return `${typo ? "the selector is" : "a selector takes its name:"} \`${kind}:${shellWord(name)}\`.`;
}
