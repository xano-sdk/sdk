/**
 * Config + token resolution for `xanosdk preflight`.
 *
 * The engineer's path is a plain base-URL + bearer token read from the
 * environment (a cwd `.env` is autoloaded when present): no OAuth, no login
 * handshake, and switching a cloud instance ↔ local Docker is just a different
 * `XANO_VALIDATE_INSTANCE`. That path still WINS whenever it is configured.
 *
 * It is no longer the only one, because `preflight` is offered in the public
 * help. When the environment names no target at all, the command falls back to
 * the credential every other command uses — see {@link envNamesValidateTarget}
 * for where that boundary sits and why it is drawn around ABSENCE rather than
 * around a preference.
 *
 * Node-only (reads process.env / the filesystem); lazily imported by the command
 * layer so the browser-safe authoring bundle never pulls it in.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { debugEnabled, fetchReadOrExplain, serverMessage, statusLabel } from "../util/http.js";
import { readEnvVar } from "../util/env.js";
import { registerSecret, tokenTextProblem } from "../util/secrets.js";
import { UsageError } from "../emit/errors.js";

/** Bound the whoami check so a stalled endpoint can't hang the CLI. */
const AUTH_CHECK_TIMEOUT_MS = 30_000;

/** Environment variable names the config reads (documented in `.env.example`). */
const ENV_INSTANCE = "XANO_VALIDATE_INSTANCE";
const ENV_TOKEN = "XANO_VALIDATE_TOKEN";
const ENV_WORKSPACE = "XANO_VALIDATE_WORKSPACE_ID";

/** A resolved validation target: which instance, which token, optional workspace. */
export interface ValidateConfig {
  /** Instance origin the meta API is served from (e.g. `https://x.xano.io` or `http://localhost:8080`). */
  instance: string;
  /** Meta bearer token. */
  token: string;
  /** Optional workspace id override; when omitted the import response supplies it. */
  workspaceId: number | undefined;
}

/** CLI overrides that win over the environment (never a token — that stays env-only). */
export interface ValidateOverrides {
  instance?: string;
  workspaceId?: number;
}

/**
 * The ONLY keys a cwd `.env` may set. Everything else in the file is ignored.
 *
 * `preflight` is the one command that reads a `.env` at all, and it does so from
 * whatever directory it was invoked in — so this file is attacker-supplied the
 * moment someone clones a repo and runs `xanosdk preflight` inside it. An
 * unfiltered load put every key it contained into `process.env`, and the
 * credential resolver reads `XANO_INSTANCE_URL` / `XANO_WORKSPACE_ID` /
 * `XANO_META_TOKEN` (and `XANO_REFRESH_TOKEN`) ahead of the stored credential:
 * a checked-in `.env` could therefore choose which instance this run uploads
 * the caller's backend to. Narrowing the load to the three variables this
 * module documents closes that without changing a maintainer's workflow, whose
 * `.env` holds exactly these.
 */
const DOTENV_ALLOWED_KEYS = new Set([ENV_INSTANCE, ENV_TOKEN, ENV_WORKSPACE]);

/** What the cwd `.env` put into `process.env`, so a rejection of a value it set names the file, not the environment. */
const dotEnvSet = new Map<string, string>();

/**
 * Load the allowed keys of a cwd `.env` into `process.env` WITHOUT clobbering
 * already-set vars, so a real environment variable always wins over the file.
 * Deliberately a tiny KEY=VALUE parser (no dependency, predictable precedence)
 * rather than Node's built-in `loadEnvFile`, whose override semantics differ
 * across versions.
 */
function loadDotEnv(): void {
  const path = resolvePath(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!DOTENV_ALLOWED_KEYS.has(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === ENV_TOKEN) registerSecret(val);
    if (readEnvVar(key) === undefined) {
      process.env[key] = val;
      dotEnvSet.set(key, val);
    }
  }
}

/** Parse + validate the instance into a bare origin, or throw with an actionable message. */
function resolveOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${ENV_INSTANCE} must be a full URL (got "${raw}"), e.g. https://your-instance.xano.io or http://localhost:8080.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${ENV_INSTANCE} must be an http(s) URL (got protocol "${url.protocol}").`);
  }
  return url.origin;
}

/**
 * Does the environment (or an explicit `--instance`) NAME a validation target?
 *
 * The question a caller actually has to answer before choosing between this
 * module and a stored credential, and it is deliberately about ABSENCE: either
 * variable being set means someone is pointing this run somewhere on purpose,
 * so {@link resolveValidateConfig} runs and ITS errors stand. A half-configured
 * environment must keep naming the variable it is missing — falling back to the
 * credential there would quietly validate against the wrong instance, which is
 * the one outcome worse than an error message.
 *
 * All THREE variables count, each on its own, for that reason — a maintainer
 * with only `ENV_TOKEN` or only `ENV_WORKSPACE` exported and the instance
 * forgotten gets "Missing target instance", exactly as before, instead of a
 * green run against their own workspace. Leaving `ENV_WORKSPACE` out of this
 * list would have made the one variable that names a WORKSPACE the one that
 * silently redirected the run to a different one.
 */
export function envNamesValidateTarget(instanceOverride?: string): boolean {
  loadDotEnv();
  if (instanceOverride !== undefined && instanceOverride !== "") return true;
  return [ENV_INSTANCE, ENV_TOKEN, ENV_WORKSPACE].some((name) => readEnvVar(name) !== undefined);
}

/**
 * Resolve `{ instance, token, workspaceId }` from CLI overrides + env (+ `.env`).
 * Throws a clear, variable-naming error when a required value is missing.
 */
export function resolveValidateConfig(overrides: ValidateOverrides = {}): ValidateConfig {
  loadDotEnv();

  const rawInstance = overrides.instance ?? readEnvVar(ENV_INSTANCE);
  if (rawInstance === undefined || rawInstance === "") {
    throw new Error(`Missing target instance. Set ${ENV_INSTANCE} (a base URL) or pass --instance <url>.`);
  }
  const instance = resolveOrigin(rawInstance);

  const rawToken = readEnvVar(ENV_TOKEN);
  if (rawToken === undefined) {
    // Two routes reach this line and they need different remedies. A maintainer
    // who exported an instance is one variable from done. Someone who only
    // passed `--instance` may have a perfectly good login and no idea what
    // these variables are — sending them to set one is the dead end that
    // reaching a credential at all was meant to remove.
    throw new Error(
      overrides.instance !== undefined
        ? `Missing token. \`--instance\` selects the maintainer path, which carries its own token: ` +
          `set ${ENV_TOKEN} in your environment or a .env file (kept out of git). To validate against ` +
          `the instance your login already pins, drop \`--instance\`.`
        : `Missing token. Set ${ENV_TOKEN} in your environment or a .env file (kept out of git).`,
    );
  }

  // Registered before anything else touches it, and refused BEFORE any request:
  // a value no header can carry otherwise surfaces as the transport's own error,
  // which quotes the header — token included.
  registerSecret(rawToken);
  const token = rawToken.trim();
  const problem = tokenTextProblem(token);
  if (problem !== undefined) {
    const where = dotEnvSet.get(ENV_TOKEN) === rawToken ? `in ${resolvePath(process.cwd(), ".env")}` : "in the environment";
    throw new UsageError(
      `\`${ENV_TOKEN}\` ${where} ${problem}, which no request can carry. ` +
        `Set it to the meta API token alone — one line, nothing else.`,
    );
  }

  // An override arrives already typed as a number, so trust it — the same way
  // the `instance` override is trusted. Only the raw env-string path needs
  // parsing + validation here.
  let workspaceId = overrides.workspaceId;
  if (workspaceId === undefined) {
    const raw = readEnvVar(ENV_WORKSPACE);
    if (raw !== undefined) {
      workspaceId = Number(raw);
      if (!Number.isInteger(workspaceId) || workspaceId < 1) {
        throw new Error(`${ENV_WORKSPACE} must be a positive integer (got "${raw}").`);
      }
    }
  }

  return { instance, token, workspaceId };
}

/** The projected, secret-free slice of `GET /api:meta/auth/me` the command surfaces. */
export interface WhoAmI {
  /** Best-effort account label, when the endpoint returns one. */
  name: string | undefined;
}

/** Which resolver produced the token, so a rejection names the right remedy. */
export type ValidateTokenSource = "env" | "credential";

/**
 * Verify the token against the instance via `GET /api:meta/auth/me`. Throws on a
 * non-2xx (the whole point of the early check: fail before importing anything).
 *
 * `source` exists only for that throw. The token can now come from a stored
 * login, and telling someone their `XANO_VALIDATE_TOKEN` is invalid when they
 * never set one sends them to configure a path they were not on; the remedy
 * there is `xanosdk login`. Defaulted to `"env"` so the maintainer path and its
 * existing message are unchanged.
 */
export async function verifyToken(
  config: ValidateConfig,
  source: ValidateTokenSource = "env",
): Promise<WhoAmI> {
  const url = new URL("/api:meta/auth/me", config.instance);
  // A pure read: retried on a dropped connection, and a transport failure names the host.
  const res = await fetchReadOrExplain(
    url.href,
    { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS) },
    "The token check",
    AUTH_CHECK_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token check failed (${statusLabel(res)}) against ${url.host}. ` +
        (source === "credential"
          ? `The stored credential was rejected — run \`xanosdk login\` to refresh it.`
          : `Is ${ENV_TOKEN} valid for this instance?`) +
        // The server's own sentence at most; the body is `XANOSDK_DEBUG`'s.
        (serverMessage(text) !== undefined ? `\n${serverMessage(text)}` : "") +
        (debugEnabled() && text.trim() !== "" ? `\n${text}` : ""),
    );
  }
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON but 2xx — treat as a valid, unlabeled session */
  }
  const name = typeof data.name === "string" ? data.name : undefined;
  return { name };
}
