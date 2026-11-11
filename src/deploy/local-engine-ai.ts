/**
 * A Xano Engine's Xano AI credential: asked for on every local deploy and
 * every engine start, written to a file the engine re-reads on each run.
 *
 * The credential lasts as long as the engine does, a day at most, and is
 * exchanged for the developer's own sign-in, so nothing permanent is ever
 * handed to the engine.
 * It is billed to the signed-in user by default, or to the owner of the
 * instance that sign-in is bound to.
 *
 * **It never fails a deploy, and it never prompts.** A local deploy does not
 * need a sign-in, and must not start to. Every way this can come up empty —
 * signed out, a pasted meta token, a sign-in without the AI scope, a
 * server that is unreachable, refuses, or predates the route — is an `off`
 * outcome with one line that names the reason and the fix.
 *
 * **The credential goes to one place: the token file**, 0600 in a 0700
 * directory, replaced by rename so the engine never reads a half-written one.
 * It is registered as a secret before anything else touches it, and no outcome
 * this module returns carries it. An `off` outcome that means "stop using it"
 * (signed out, refused, no credits, and the like) removes the file, so the
 * engine stops spending an earlier credential; a transient one leaves it, and
 * says that credential stays in use until it expires.
 *
 * Node-only. The deploy path reaches it by a lazy import; the `local` command
 * imports it directly.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { registerSecret } from "../util/secrets.js";
import { serverMessage } from "../util/http.js";
import { AI_SCOPE } from "../auth/oauth.js";
import { assertHttpsOrigin } from "../auth/config.js";
import { loginCommand } from "../auth/store.js";
import { readStoredProfileQuietly } from "../auth/token.js";
import { hostLabel, safeText } from "../emit/ui.js";
import { isRecord, type Row } from "./answer-shape.js";
import { clampEngineAiTtl, engineAiDir, engineAiTokenPath, machineIdPath } from "./local-engine-config.js";

/** Who a local engine's Xano AI usage is billed to. */
export type AiBilling = "user" | "instance";

/** The route on the sign-in server that issues the credential. */
export const ENGINE_TOKEN_ROUTE = "/api:meta/ai-credits/engine-token";

/** How long the request may take before Xano AI is reported off for this run. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The fallback lifetime when the answer names no expiry: the hour a server that predates `ttl` issues. */
const DEFAULT_LIFETIME_S = 3600;

/**
 * Why Xano AI is off for this engine. Stable codes: they are what `--json`
 * output carries, so a script can tell "sign in" from "try later".
 */
export type AiOffReason =
  /** No stored sign-in to use. */
  | "signed-out"
  /** The profile is a pasted meta API token, which cannot obtain one. */
  | "not-oauth"
  /** The sign-in predates the AI scope (or its server cannot be used): sign in again. */
  | "sign-in-again"
  /** The credential file or the project's profile pin could not be read. */
  | "profile-unreadable"
  /** The stored sign-in could not be refreshed. */
  | "refresh-failed"
  /** The sign-in server could not be reached. */
  | "unreachable"
  /** The sign-in server does not issue engine credentials yet. */
  | "route-missing"
  /** The sign-in server refused: no access, or not allowed to bill the instance owner. */
  | "refused"
  /** Xano AI is not available for this account or instance right now. */
  | "unavailable"
  /** No Xano AI credits left to bill. */
  | "no-credits"
  /** Any other answer. */
  | "failed"
  /** A reused engine was started without the credential file or the gateway URL this credential needs, so it cannot use one. */
  | "restart-to-enable";

/** Xano AI is on: a credential is in the engine's token file. */
export interface AiOn {
  status: "on";
  billing: AiBilling;
  /** Epoch ms the credential stops working. */
  expiresAt: number;
  /** The gateway the engine should call, when known. */
  gatewayUrl?: string;
  /** The stored profile the credential was exchanged for. */
  profile: string;
  /** The instance that sign-in is bound to. */
  instance: string;
}

/** Xano AI is off for this engine, and why. */
export interface AiOff {
  status: "off";
  billing: AiBilling;
  reason: AiOffReason;
  /** One line: the reason and its fix. */
  message: string;
  /** The gateway the stored sign-in names, so an engine started now can still use a later credential. */
  gatewayUrl?: string;
}

export type AiOutcome = AiOn | AiOff;

/** The request seam, so tests drive every answer with no network. */
export type AiFetch = (url: string, init: RequestInit) => Promise<Response>;

/** What {@link requestEngineAiCredential} needs. */
export interface EngineAiRequest {
  billing: AiBilling;
  /** The engine's name: keys the token file and labels the credential. */
  engineName: string;
  /**
   * The lifetime to ask for, in seconds: how long the engine runs. Sent within
   * what the server issues (a minute to a day); the answer's expiry is the one
   * granted.
   */
  ttl: number;
  env?: NodeJS.ProcessEnv;
  /** Where the project's profile pin is looked for. */
  cwd?: string;
  fetch?: AiFetch;
}

const defaultFetch: AiFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

/** The line every `off` outcome opens with. */
const OFF = "Xano AI is off for this engine:";

/**
 * The reasons that say a retry may still work. The token file is kept on these:
 * a credential an earlier deploy wrote is still valid until it expires, and
 * nothing about this run says the user stopped wanting it. Every other reason
 * removes the file.
 */
const TRANSIENT: ReadonlySet<AiOffReason> = new Set<AiOffReason>(["unreachable", "refresh-failed", "failed", "route-missing"]);

/**
 * Ask for this engine's Xano AI credential and write it to the token file.
 * Never throws and never prompts — every failure is an `off` outcome.
 */
export async function requestEngineAiCredential(req: EngineAiRequest): Promise<AiOutcome> {
  const env = req.env ?? process.env;
  const billing = req.billing;
  const tokenFile = engineAiTokenPath(req.engineName, env);
  const off = (reason: AiOffReason, message: string, gatewayUrl?: string): AiOff => {
    let kept = "";
    if (TRANSIENT.has(reason)) {
      if (existsSync(tokenFile)) kept = " The earlier credential stays in use until it expires.";
    } else {
      removeTokenFile(tokenFile);
    }
    return {
      status: "off",
      billing,
      reason,
      message: `${OFF} ${message}${kept}`,
      ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
    };
  };

  const read = readStoredProfileQuietly(req.cwd ?? process.cwd());
  if (read.kind === "unreadable") {
    return off("profile-unreadable", `the stored sign-in could not be read (${firstLine(read.message)}).`);
  }
  if (read.kind === "none") {
    return off("signed-out", "no Xano sign-in is stored. Run `xanosdk login` to turn it on.");
  }
  if (read.kind === "token") {
    return off(
      "not-oauth",
      `profile "${safeText(read.profile)}" is a pasted meta API token, not an OAuth sign-in. ` +
        `Run \`${loginCommand(read.profile, { path: read.path }, ["--force"])}\` to sign in with \`xanosdk login\` and turn it on.`,
    );
  }

  const { record, profile, path } = read;
  const stored = record.ai_gateway_url;
  const relogin = loginCommand(profile, { path, origin: record.auth_host }, ["--force"]);
  if (!(record.scope ?? "").split(/\s+/).includes(AI_SCOPE)) {
    return off(
      "sign-in-again",
      `profile "${safeText(profile)}" has a sign-in without Xano AI access. ` +
        `Run \`${relogin}\` to sign in again and turn it on.`,
      stored,
    );
  }
  try {
    assertHttpsOrigin(record.auth_host, "auth_host");
  } catch {
    return off(
      "sign-in-again",
      `the sign-in server stored for profile "${safeText(profile)}" is not https. Run \`${relogin}\` to sign in again.`,
      stored,
    );
  }

  let bearer: string;
  try {
    bearer = await read.bearer();
  } catch {
    return off(
      "refresh-failed",
      `the sign-in for profile "${safeText(profile)}" could not be refreshed. ` +
        `Deploy again to retry, or run \`${relogin}\` if it keeps happening.`,
      stored,
    );
  }

  let machineId: string;
  try {
    machineId = readOrCreateMachineId(env);
  } catch (err) {
    return off("failed", `this machine's id could not be read or made (${firstLine(err instanceof Error ? err.message : String(err))}).`, stored);
  }

  const host = record.auth_host.replace(/\/+$/, "");
  let res: Response;
  let text: string;
  try {
    res = await (req.fetch ?? defaultFetch)(`${host}${ENGINE_TOKEN_ROUTE}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        billing,
        engine_name: req.engineName,
        machine_id: machineId,
        ttl: clampEngineAiTtl(req.ttl),
      }),
    });
    text = await res.text();
  } catch {
    return off("unreachable", `${hostLabel(host)} could not be reached for a credential. Deploy again to retry.`, stored);
  }

  if (res.ok) {
    const body = parseObject(text);
    const token = body?.["token"];
    // Registered before anything else looks at it: whatever happens next, it prints redacted.
    registerSecret(token);
    if (typeof token !== "string" || token.trim() === "") {
      // An older server answers "not available" with a 200 carrying the 409's body.
      const reason = answerMessage(body, text);
      return off(
        "unavailable",
        `Xano AI is not available for ${hostLabel(record.instance)} right now${reason === undefined ? "" : ` (${safeText(reason)})`}.`,
        stored,
      );
    }
    const gatewayUrl = typeof body?.["ai_gateway_url"] === "string" && body["ai_gateway_url"] !== "" ? body["ai_gateway_url"] : stored;
    try {
      writeTokenFile(req.engineName, token.trim(), env);
    } catch (err) {
      return off("failed", `the credential could not be written (${firstLine(err instanceof Error ? err.message : String(err))}).`, gatewayUrl);
    }
    return {
      status: "on",
      billing: body?.["billing"] === "instance" || body?.["billing"] === "user" ? body["billing"] : billing,
      expiresAt: expiryOf(body?.["expires_at"], body?.["expires_in"]),
      ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
      profile,
      instance: record.instance,
    };
  }

  const said = answerMessage(parseObject(text), text);
  const because = said === undefined ? "" : ` (${safeText(said)})`;
  // The server's answer for a caller with no access to the instance, on a 404 or a 500.
  if ((res.status === 404 || res.status === 500) && said !== undefined && /instance access denied or not found/i.test(said)) {
    return off(
      "refused",
      `profile "${safeText(profile)}" has no access to ${hostLabel(record.instance)}${because}. Run \`${relogin}\` to sign in to an instance you can use.`,
      stored,
    );
  }
  switch (res.status) {
    case 404:
      return off("route-missing", `${hostLabel(host)} does not issue Xano Engine credentials yet. Deploy again later.`, stored);
    case 409:
      return off("unavailable", `Xano AI is not available for ${hostLabel(record.instance)} right now${because}.`, stored);
    case 402:
      return off(
        "no-credits",
        `${billing === "instance" ? "the instance owner has" : "you have"} no Xano AI credits left${because}. Add credits, then deploy again.`,
        stored,
      );
    case 401:
    case 403:
      return off(
        "refused",
        billing === "instance"
          ? `billing the owner of ${hostLabel(record.instance)} was refused${because}. Deploy with \`--ai-billing user\` to bill yourself instead.`
          : `the credential was refused for profile "${safeText(profile)}"${because}. Run \`${relogin}\` if your access changed.`,
        stored,
      );
    default:
      return off("failed", `${hostLabel(host)} answered HTTP ${res.status}${because}. Deploy again to retry.`, stored);
  }
}

/**
 * This machine's id, made once under the engine home and reused for every
 * later credential. Created exclusively, so two deploys racing on a fresh
 * machine agree on one id. A file that holds no id (an interrupted first
 * write) is replaced whole, by rename.
 */
export function readOrCreateMachineId(env: NodeJS.ProcessEnv = process.env): string {
  const path = machineIdPath(env);
  const existing = readId(path);
  if (existing !== undefined) return existing;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${randomUUID()}\n`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const made = readId(path);
  if (made !== undefined) return made;
  const id = randomUUID();
  atomicWrite(path, `${id}\n`, { mode: 0o600 });
  return id;
}

function readId(path: string): string | undefined {
  try {
    const id = readFileSync(path, "utf8").trim();
    return /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the token file, so the engine has no credential to spend. Best-effort: a deploy never fails on it. */
function removeTokenFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* Nothing more to do: the outcome already says Xano AI is off. */
  }
}

/** The token alone, owner-only, by rename. */
function writeTokenFile(engineName: string, token: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(engineAiDir(env), { recursive: true, mode: 0o700 });
  atomicWrite(engineAiTokenPath(engineName, env), token, { mode: 0o600 });
}

/**
 * The answer's expiry as epoch ms. `expires_at` in seconds or milliseconds, or
 * an ISO date; else `expires_in` from now; else an hour.
 */
function expiryOf(at: unknown, inSeconds: unknown): number {
  if (typeof at === "number" && Number.isFinite(at) && at > 0) return at < 1e12 ? at * 1000 : at;
  if (typeof at === "string" && at !== "") {
    const parsed = Date.parse(at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const lifetime = typeof inSeconds === "number" && Number.isFinite(inSeconds) && inSeconds > 0 ? inSeconds : DEFAULT_LIFETIME_S;
  return Date.now() + lifetime * 1000;
}

/**
 * The server's own words in an answer, one line: its `message`, else its
 * `payload` when that is a sentence (how the "not available" answer is
 * shaped), else whatever {@link serverMessage} reads.
 */
function answerMessage(body: Row | undefined, text: string): string | undefined {
  const message = body?.["message"];
  const payload = body?.["payload"];
  if (typeof message === "string" && message.trim() !== "") return firstLine(message);
  if (typeof payload === "string" && payload.trim() !== "") return firstLine(payload);
  return serverMessage(text);
}

/** The answer as a JSON object, or `undefined` when it is not one. */
function parseObject(text: string): Row | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  return safeText(text.split("\n")[0]!.trim());
}

/** The `ai` object a local deploy's machine output carries. Never the credential. */
export interface AiOutcomeDocument {
  status: "on" | "off";
  billing: AiBilling;
  /** ISO time the credential stops working, when on. */
  expiresAt?: string;
  /** Why it is off — an {@link AiOffReason}. */
  reason?: AiOffReason;
}

/** {@link AiOutcome} as the machine output carries it. */
export function aiOutcomeDocument(outcome: AiOutcome): AiOutcomeDocument {
  return outcome.status === "on"
    ? { status: "on", billing: outcome.billing, expiresAt: new Date(outcome.expiresAt).toISOString() }
    : { status: "off", billing: outcome.billing, reason: outcome.reason };
}

/**
 * The one line a deploy prints about Xano AI: who is billed and until when, or
 * why it is off and the fix.
 */
export function aiOutcomeLine(outcome: AiOutcome): string {
  if (outcome.status === "off") return outcome.message;
  const until = localTime(new Date(outcome.expiresAt));
  const instance = hostLabel(outcome.instance);
  const profile = `profile ${safeText(outcome.profile)}`;
  const who =
    outcome.billing === "instance"
      ? `billed to the owner of ${instance} (${profile})`
      : `billed to you (${profile}, ${instance})`;
  return `Xano AI: on, ${who} until ${until}. Each deploy renews it.`;
}

/** `HH:MM` local time, with the `YYYY-MM-DD` date in front when it is not today. */
function localTime(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const now = new Date();
  const today = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return today ? time : `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${time}`;
}
