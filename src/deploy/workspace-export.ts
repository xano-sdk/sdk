/**
 * The one call that reads a workspace back out of Xano:
 * `POST {base}/api:meta/workspace/{id}/export` → a gzipped archive → the bundle.
 *
 * Every environment Xano SDK can read uses it, differing only in which origin and
 * which workspace id they point at:
 *
 * - **workspace** — the caller's real workspace on the instance the OAuth token
 *   is bound to, at the id that token is scoped to.
 * - **ephemeral** — the environment's base URL, where the workspace id is always 1.
 *
 * Extracted here because the callers had drifted into near-identical copies, and
 * because the decode layer needs the parsed bundle rather than the JSON text the
 * `export` commands write.
 *
 * Both read **configuration, not table rows** — see the note on
 * {@link exportWorkspaceBundle} for why requesting rows would only ever produce
 * the same bundle, more slowly.
 *
 * Node-only (fetch); lazily imported by the command layer so the browser-safe
 * authoring bundle never pulls it in.
 */
import { withArticle } from "../util/article.js";
import type { BearerTarget, ResolvedAuth } from "../auth/token.js";
import { decodeWorkspaceArchive } from "../validate/archive.js";
import {
  fetchReadOrExplain,
  markupSummary,
  readBodyBytes,
  safeHttpFailure,
  serverMessage,
  statusLabel,
  transportTarget,
} from "../util/http.js";

/** A workspace archive can be large; bound the call generously. */
const EXPORT_TIMEOUT_MS = 120_000;

/** A decoded `packageExport` bundle, as the decode layer consumes it. */
export interface ExportedBundle {
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Export one workspace as its bundle.
 *
 * `base` is an origin (optionally with a path prefix, as a tenant-scoped meta
 * origin has), so routes are APPENDED rather than resolved against it — a `new
 * URL(path, base)` would silently drop a `/tenant/<name>` prefix.
 *
 * `label` names the caller in errors, since the same failure means different
 * things per environment ("run `xanosdk deploy` first" vs "your token is scoped
 * elsewhere").
 *
 * **Table rows are never requested.** Nothing on the read side can consume them:
 * `decodeWorkspaceArchive` takes `workspace.json` and discards the archive's
 * `content/` entries, so every row the server sent was fetched, held, and
 * dropped. Asking for them is pure cost, and an unbounded one — the server pages
 * through every row of every table and buffers the archive before emitting a
 * byte, so a workspace holding real data outlasts any client-side bound.
 *
 * This is the read half of an asymmetry, not a limitation of the format: the
 * write half ships seed rows as `content/<guid>-<page>.json` entries (see
 * `workspace/seed.ts`). When a decoder for those lands, `records` becomes a
 * caller's choice again — until something can read a row, requesting one would
 * be a slower way to produce the same bundle.
 *
 * **Stored file bytes are never requested either.** The export copies every file
 * in the workspace's file library into the archive before emitting a byte, so a
 * workspace storing large files outlasts any client-side bound the same way. The
 * read never touches them: the file library's metadata lives in
 * `workspace.json` and comes back either way.
 *
 * `records` and `vault` are hints, not a contract: an instance predating either
 * field ignores it and returns the full archive, which decodes to the same
 * bundle regardless.
 *
 * `branch` scopes the read to one branch's logic; omitted, it reads whichever
 * branch is live. Tables and microservices are workspace-scoped and come back
 * either way.
 *
 * Takes a {@link BearerTarget}: the read uses nothing but the bearer, and the
 * target comes from `opts`, so a local engine's url and token reach it without
 * being widened into a credential.
 */
/**
 * A label no workspace can hold, used to ask the instance a yes/no question.
 *
 * Randomized per call so a workspace that somehow contains the literal string
 * cannot make the probe lie, and prefixed so an operator reading the instance's
 * error log can see what produced it.
 */
function probeLabel(): string {
  return `__xanosdk_branch_probe_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Refuse to read a branch from an instance that would silently ignore the ask.
 *
 * The export route takes a `branch` and, on an instance that predates the fix
 * for it, DROPS it: the archive comes back `200`, complete and well-formed, and
 * is the LIVE branch's. Nothing in the response says so. The bundle cannot be
 * inspected to find out either — every archive reports `workspace.branch.id: 0`
 * and an empty `branch: []` whatever was requested, so there is no marker to
 * compare a bundle against.
 *
 * Comparing the bundle's API groups against the branch-aware `apigroup` route
 * would seem to close this, and does not: a branch that differs from live only
 * in a function body — the ordinary case, since a branch starts as a clone of
 * live — has exactly live's API groups, so the comparison passes on precisely
 * the workspaces where the wrong answer is hardest to notice.
 *
 * So the check is a capability probe rather than a content check, and it turns
 * on the one behaviour that separates the two engines regardless of what the
 * workspace holds: a FIXED instance rejects a branch label that does not exist,
 * and an unfixed one answers `200` with live's archive. Asking about a label
 * that cannot exist makes the two answers unambiguous.
 *
 * Ordered so the cost falls on the instance that cannot serve the request: a
 * fixed instance rejects the probe before it builds anything, while an unfixed
 * one spends one export to earn a refusal — and then does not spend a second on
 * a bundle the caller must not be given.
 *
 * Absence of a signal is refused as firmly as a wrong one, for the same reason
 * `assertXanoSdkBranchHonored` refuses it on the write side: an instance that
 * cannot say which branch it read is, from here, indistinguishable from one
 * that ignored the question.
 */
export async function assertBranchReadSupported(
  auth: ResolvedAuth,
  opts: { base: string; workspaceId: number; branch: string },
): Promise<void> {
  const base = opts.base.replace(/\/$/, "");
  const url = `${base}/api:meta/workspace/${opts.workspaceId}/export`;
  const res = await fetchReadOrExplain(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ branch: probeLabel(), password: "", records: false, vault: false }),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    },
    "branch support probe",
    EXPORT_TIMEOUT_MS,
  );
  // Any refusal is the answer we want: the instance looked the label up, did
  // not find it, and said so. The status and wording are not pinned — an engine
  // is free to reject an unknown branch however it likes, and reading the shape
  // of the error would make this brittle about the one thing it does not care
  // about.
  if (!res.ok) return;

  throw new Error(
    `Refusing to read branch "${opts.branch}": this instance ignores the branch parameter on ` +
      `workspace export.
` +
      `  instance: ${opts.base}
` +
      `It accepted a branch label that cannot exist and answered 200 with an archive, which is ` +
      `what an instance that drops the parameter does. Such an instance returns whichever branch ` +
      `is LIVE — so the project written from it would be the live branch's code under the name of ` +
      `the branch you asked for, reported as success.\n` +
      `Update the instance, or drop \`--branch\` to read the live branch deliberately.`,
  );
}

export async function exportWorkspaceBundle(
  auth: BearerTarget,
  opts: {
    base: string;
    workspaceId: number;
    label: string;
    branch?: string;
    /**
     * Never echo anything but a LABELLED server message on a failure.
     *
     * A failure normally carries the server's sentence — a JSON `message`, or
     * a plain-text body's first line. For a caller whose entire contract is
     * that no value it touches reaches the terminal, even that first line is
     * too much: a no-leak guarantee that holds only on the happy path is not one.
     */
    safeErrors?: boolean;
  },
): Promise<ExportedBundle> {
  const base = opts.base.replace(/\/$/, "");
  const url = `${base}/api:meta/workspace/${opts.workspaceId}/export`;
  // A POST, but a pure READ: it changes nothing on the workspace, so a dropped
  // connection is safe to retry.
  const res = await fetchReadOrExplain(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
      // `branch`/`password` are required; the defaults mean "current branch, no
      // archive password". `records: false` / `vault: false` skip table content
      // and stored file bytes — see above.
      // A named branch must be one the workspace ALREADY has: an unknown label
      // is an error from the route, not a fallback to live.
      body: JSON.stringify({ branch: opts.branch ?? "", password: "", records: false, vault: false }),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    },
    opts.label,
    EXPORT_TIMEOUT_MS,
  );
  if (!res.ok) {
    const body = await readBodyBytes(res, opts.label, { url, timeoutMs: EXPORT_TIMEOUT_MS });
    const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
    // `status` rides on the error so a caller can tell a server error (5xx) —
    // no answer, retry — from a refusal.
    throw Object.assign(
      new Error(
        opts.safeErrors === true
          ? safeHttpFailure(opts.label, res, text)
          : `${opts.label} failed (${statusLabel(res)})${errorDetail(body, text)}`,
      ),
      { status: res.status },
    );
  }
  const bytes = await readBodyBytes(res, opts.label, { url, timeoutMs: EXPORT_TIMEOUT_MS });
  // A 200 that is not an archive at all — a proxy's page, a login wall, a JSON
  // answer — is a bad ANSWER, said as one and naming the host: decoded as an
  // archive it read "no workspace.json (entries: none)", which blamed the export.
  if (!looksLikeArchive(bytes)) throw notAnArchive(opts.label, url, bytes, opts.safeErrors === true);
  let bundle: unknown;
  try {
    bundle = decodeWorkspaceArchive(bytes);
  } catch (err) {
    throw new Error(
      `${opts.label}: ${transportTarget(url)} answered with an archive that could not be read ` +
        `(${err instanceof Error ? err.message : String(err)}) — not a workspace export.`,
      { cause: err },
    );
  }
  if (bundle === null || typeof bundle !== "object" || !("payload" in bundle)) {
    throw new Error(`${opts.label}: the exported archive carried no \`payload\` — not a workspace bundle.`);
  }
  return bundle as ExportedBundle;
}

/** A gzip stream, or a bare ustar archive — the only two shapes an export answers with. */
function looksLikeArchive(bytes: Uint8Array): boolean {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
  return bytes.length >= 262 && new TextDecoder().decode(bytes.subarray(257, 262)) === "ustar";
}

/**
 * The failure for a 2xx export answer that is not an archive, in one line: the
 * host, and what came back — an HTML page by its title (not even that when
 * `safe`), anything else only by kind. Never the body.
 */
function notAnArchive(label: string, url: string, bytes: Uint8Array, safe: boolean): Error {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  const page = markupSummary(text);
  const what =
    page !== undefined
      ? `${safe ? "an HTML page" : page.replace(/, not an API response$/, "")}, not an export archive — a proxy or captive portal between you and the instance?`
      : bytes.length === 0
        ? "an empty body, not an export archive."
        : /^\s*[[{]/.test(text)
          ? "JSON, not an export archive."
          : "something that is not an export archive.";
  return new Error(`${label}: ${transportTarget(url)} answered with ${what}`);
}

/**
 * A failed export's body as the tail of its one-line failure: the server's own
 * message (see `serverMessage` — never a JSON payload or a whole text body),
 * or a description of a binary body. `.` when there is nothing to say.
 *
 * This route answers with an ARCHIVE, and at least one instance has been seen
 * returning `500` with a complete `.tar.gz` in the body; those bytes are
 * described, never dumped.
 */
function errorDetail(bytes: Uint8Array, text: string): string {
  // A replacement char or a C0 control (tab/newline/CR excepted) means these
  // bytes were never text to begin with.
  // eslint-disable-next-line no-control-regex
  const NOT_TEXT = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
  if (bytes.length > 0 && NOT_TEXT.test(text)) {
    const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    return gzip
      ? `: the body is a workspace archive (${bytes.length} bytes) sent with an error status — re-run the export, ` +
          `and if it persists the instance is failing mid-export.`
      : `: ${withArticle(`${bytes.length}-byte`)} binary body, not an error message.`;
  }
  const message = serverMessage(text);
  return message !== undefined ? `: ${message}` : ".";
}
