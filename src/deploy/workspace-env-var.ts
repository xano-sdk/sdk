/**
 * Set or clear ONE backend env var by name, on whatever the bearer reaches.
 *
 * The import archive cannot do this job: a merge is add-only, so an existing
 * name keeps its value, and a replace rewrites the whole workspace. These two
 * calls change exactly one name and leave every other one as it was.
 *
 * One route for every destination. A workspace is addressed by its own id; an
 * ephemeral, a tenant and a local engine are each their own instance whose
 * workspace is always 1 — the caller resolves which, this module only sends.
 *
 * The value travels in the request body, never the URL, and never comes back:
 * the route answers with the name and what happened to it. Failures go through
 * {@link safeHttpFailure}, which never appends a response body, because the
 * request that failed was carrying a secret.
 */
import type { BearerTarget } from "../auth/token.js";
import {
  explainBindingRefusal,
  fetchOrExplain,
  readBodyText,
  safeHttpFailure,
  SENT_AFTERMATH,
  withWriteStatusAftermath,
  type BindingContext,
} from "../util/http.js";
import { recordAnswer, writeTransportFailure } from "./answer-shape.js";

const ENV_VAR_TIMEOUT_MS = 30_000;

/** What a set did: the name was new, or it held a value that was replaced. */
export type EnvSetAction = "created" | "updated";
/** What an unset did: the name was removed, or the workspace never had it. */
export type EnvUnsetAction = "deleted" | "absent";

export interface EnvVarTarget {
  /** The instance origin the route lives on (a tenant's own host for a tenant). */
  baseUrl: string;
  workspaceId: number;
  name: string;
  /** What a 403 is checked against for a workspace-binding refusal; absent for a local engine. */
  binding?: BindingContext;
}

/**
 * What a 403 means here when the workspace binding does not explain it.
 *
 * The route is gated on the workspace-settings permission, and the refusal says
 * only `Access Denied.` — so a credential that can deploy but not edit settings
 * (an access token created without that scope is the common one) read as a
 * mystery. Composed rather than extracted, like the binding explanation: the
 * body has nothing better to offer.
 */
const SETTINGS_SCOPE_REMEDY =
  `This credential may lack permission to change workspace settings, which env vars are part of. ` +
  `An access token needs the workspace settings scope (\`workspace:settings\`); grant it, or use a ` +
  `credential whose role can edit this workspace's settings, then run it again.`;

/**
 * The backend answered that it has no single-name env route at all — an older
 * engine — as opposed to refusing this name. Distinct so the caller can name
 * the way round it for the kind of backend it addressed.
 */
export class EnvVarRouteMissingError extends Error {
  override readonly name = "EnvVarRouteMissingError";
}

function endpoint(target: EnvVarTarget): string {
  return (
    `${target.baseUrl.replace(/\/$/, "")}/api:meta/workspace/${target.workspaceId}` +
    `/xanosdk/env/${encodeURIComponent(target.name)}`
  );
}

/** Create the name, or replace its value. Every other env var is left as it was. */
export async function setWorkspaceEnvVar(
  auth: BearerTarget,
  opts: EnvVarTarget & { value: string },
): Promise<EnvSetAction> {
  return send(
    auth,
    opts,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: opts.value }),
    },
    `set env var ${opts.name}`,
    ["created", "updated"],
  );
}

/** Remove the name. A name the workspace does not have is `absent`, not an error. */
export async function unsetWorkspaceEnvVar(auth: BearerTarget, opts: EnvVarTarget): Promise<EnvUnsetAction> {
  return send(auth, opts, { method: "DELETE" }, `clear env var ${opts.name}`, ["deleted", "absent"]);
}

/**
 * Exactly one attempt. A set that landed before the connection dropped is
 * harmless to repeat, but the caller decides that, not a transport retry that
 * would report one outcome for two writes.
 */
async function send<A extends string>(
  auth: BearerTarget,
  target: EnvVarTarget,
  init: RequestInit,
  action: string,
  expected: readonly A[],
): Promise<A> {
  const url = endpoint(target);
  // A write that got no answer may have been received: said so, unless the
  // connection was refused before anything was sent.
  const res = await fetchOrExplain(
    url,
    {
      signal: AbortSignal.timeout(ENV_VAR_TIMEOUT_MS),
      ...init,
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${auth.access_token}`,
        ...((init.headers ?? {}) as Record<string, string>),
      },
    },
    action,
    ENV_VAR_TIMEOUT_MS,
  ).catch((err: unknown) => {
    throw writeTransportFailure(err);
  });
  const text = await readBodyText(res, action, { url, aftermath: SENT_AFTERMATH });
  if (!res.ok) {
    // The engine's answer for a route it does not have. Said plainly, because
    // the bare 404 reads as "no such env var" — the opposite of the truth for a
    // set, and a misleading one for a clear.
    // What to do instead depends on the verb and on what kind of backend this
    // is, which only the caller knows — so this says what is missing, and the
    // caller adds the way round it.
    if (res.status === 404 && /unable to locate request/i.test(text)) {
      throw new EnvVarRouteMissingError(
        `${action} failed: ${target.baseUrl.replace(/\/$/, "")} does not support ` +
          `${init.method === "DELETE" ? "clearing" : "setting"} one env var by name yet.`,
      );
    }
    const failure = safeHttpFailure(action, res, text, target.binding);
    // Only where a real instance answered (a local engine carries no binding),
    // and never on top of the binding explanation: a credential bound to another
    // workspace is refused whatever its scopes, so naming them would send the
    // reader to the wrong fix.
    if (res.status === 403 && target.binding !== undefined && explainBindingRefusal(target.binding) === undefined) {
      throw new Error(`${failure}\n${SETTINGS_SCOPE_REMEDY}`);
    }
    // A 5xx failed somewhere inside the write, which may have run; a 4xx refused it.
    throw new Error(withWriteStatusAftermath(failure, res.status));
  }
  // The answer names what happened to the name — one of `expected`. Anything
  // else (a page, `null`, a stranger's object) is not this route's answer:
  // refused the shared way, naming the host that answered, never the body.
  const answer = recordAnswer(
    text,
    action,
    url,
    (row) => typeof row.action === "string" && (expected as readonly string[]).includes(row.action),
    { safe: true, write: true },
  );
  return answer.action as A;
}
