/**
 * Node-only: resolve the numeric workspace id the caller's OAuth token is scoped
 * to. The static-host meta routes key on a NUMERIC workspace id, which the
 * token itself does not carry directly (it carries the workspace *guid* it
 * consented to).
 *
 * `GET /api:meta/auth/me` returns both halves of the mapping:
 *   - `extras.oauth.workspace`               — the guid the token is scoped to
 *   - `extras.instance.membership.workspace` — `[{ guid, id }]` for the account
 * so we match the scoped guid against the membership list to get its id. When the
 * token carries no scoped guid but the account has exactly one workspace, we use
 * that; anything ambiguous is a hard error rather than a wrong-workspace deploy.
 *
 * Lazily imported by the command layer so the browser-safe authoring bundle never
 * pulls this Node-only transport in.
 */
import type { BearerTarget } from "../auth/token.js";
import { debugEnabled, fetchReadOrExplain, parseJsonAnswer, serverMessage, transportTarget } from "../util/http.js";

const RESOLVE_TIMEOUT_MS = 30_000;

interface MembershipWorkspace {
  guid?: unknown;
  id?: unknown;
}

/** The token answered, but names no single workspace — its own remedy, not a retry. */
class AmbiguousWorkspace extends Error {}

/**
 * Resolve the numeric id of the workspace the token is scoped to (see module
 * header). Called in exactly two places: `login` (to pin it) and the
 * `XANO_REFRESH_TOKEN` CI path (which has no stored record to read it from).
 *
 * Takes a `BearerTarget`, not a `ResolvedAuth`: this function *produces* the
 * workspace id the fuller type carries.
 *
 * `again` is `login`'s own re-run line: a failure there is worded as the sign-in
 * it ends ("Signed in, but reading your workspace failed: … run `<again>`
 * again"), with every flag that decides where that sign-in goes. Without it
 * (the CI path) the same reason is said with no sign-in to repeat.
 */
export async function resolveScopedWorkspaceId(auth: BearerTarget, opts: { again?: string } = {}): Promise<number> {
  const again = opts.again ?? "xanosdk login";
  try {
    return await lookup(auth);
  } catch (err) {
    const said = (err instanceof Error ? err.message : String(err)).trimEnd();
    // One sentence end, whatever the reason ended on: a question stays a question.
    const reason = /[.?!]$/.test(said) ? said.slice(0, -1) + (said.endsWith("?") ? "?" : "") : said;
    const lead =
      opts.again === undefined
        ? "Reading the workspace this token is scoped to failed"
        : "Signed in, but reading your workspace failed";
    const remedy =
      err instanceof AmbiguousWorkspace
        ? `Run \`${again}\` again and pick a single workspace at the consent screen. ` +
          `There is no workspace override — a credential addresses exactly one workspace.`
        : opts.again === undefined
          ? ""
          : `Nothing was saved — run \`${again}\` again.`;
    if (opts.again === undefined) {
      const unanswered = await unansweredAfterExchange(lead, reason, err);
      if (unanswered !== undefined) throw unanswered;
    }
    const end = reason.endsWith("?") ? "" : ".";
    throw new Error(`${lead}: ${reason}${end}${remedy === "" ? "" : ` ${remedy}`}`, { cause: err });
  }
}

/**
 * The CI path's lookup that got no answer — a network failure, a 5xx, a rate
 * limit — as exit 8 with this command as the rerun, saying the refresh token
 * the run exchanged first is spent: one exchange consumes it, so the rerun
 * needs a fresh one. `undefined` for any other failure.
 */
async function unansweredAfterExchange(lead: string, reason: string, err: unknown): Promise<Error | undefined> {
  const { isUnansweredLookup, LookupFailedError, unansweredCause } = await import("../emit/source-resolve.js");
  if (!isUnansweredLookup(err)) return undefined;
  const head = (reason.split("\n")[0] ?? reason).trim().replace(/[.:]$/, "");
  const failed = new LookupFailedError(
    `${lead}: ${head}. ${unansweredCause(err)} — nothing was changed`,
    "unreachable",
    "workspace",
  );
  failed.trailer =
    " The XANO_REFRESH_TOKEN exchange before this lookup succeeded, and a refresh token is single-use, so that " +
    "token is spent: set XANO_REFRESH_TOKEN to a fresh one (and XANO_CLIENT_ID to the client it was minted for) " +
    "before the rerun.";
  failed.message += failed.trailer;
  failed.cause = err;
  return failed;
}

async function lookup(auth: BearerTarget): Promise<number> {
  const url = new URL("/api:meta/auth/me", auth.instance);
  const res = await fetchReadOrExplain(
    url.href,
    {
      headers: { Authorization: `Bearer ${auth.access_token}` },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    },
    "the workspace lookup",
    RESOLVE_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) {
    // The words every other sign-in failure uses: the host, and `HTTP <status>`
    // with the server's one-line reason — never the route or the raw body.
    const said = serverMessage(text);
    const head = `${transportTarget(url.href)} answered HTTP ${res.status}${said === undefined ? "" : ` — ${said}`}`;
    throw Object.assign(new Error(debugEnabled() && text.trim() !== "" ? `${head}\n${text}` : head), {
      status: res.status,
    });
  }
  const data = (parseJsonAnswer(text, "the workspace lookup", url.href) ?? {}) as Record<string, unknown>;

  const extras = (data.extras ?? {}) as Record<string, unknown>;
  const oauth = (extras.oauth ?? {}) as Record<string, unknown>;
  const instance = (extras.instance ?? {}) as Record<string, unknown>;
  const membership = (instance.membership ?? {}) as Record<string, unknown>;
  const list = Array.isArray(membership.workspace) ? (membership.workspace as MembershipWorkspace[]) : [];

  const scopedGuid = typeof oauth.workspace === "string" ? oauth.workspace : undefined;
  if (scopedGuid !== undefined && scopedGuid !== "") {
    const match = list.find((w) => w.guid === scopedGuid);
    if (match !== undefined && typeof match.id === "number") return match.id;
  }
  // No scoped guid (or it wasn't in the membership list): only safe to guess when
  // the account has exactly one workspace.
  const ids = list.filter((w): w is { id: number } => typeof w.id === "number");
  if (ids.length === 1) return ids[0]!.id;

  throw new AmbiguousWorkspace(
    `could not resolve which workspace this token is scoped to ` +
      `(scoped workspace ${scopedGuid ?? "(none)"} not found among ${ids.length} membership workspaces)`,
  );
}
