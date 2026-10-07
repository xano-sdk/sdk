/**
 * `xanosdk local mcp --stdio`: an MCP stdio server that forwards a coding
 * agent's messages to the MCP server a Xano Engine serves on this machine.
 *
 * Why a bridge rather than the engine's url in the agent's config: a restarted
 * engine may come back on a new port and always mints a new bearer, so a url
 * and token pasted into `.mcp.json` break on the next restart and leave a live
 * secret in the repo. The bridge looks the engine up when it needs it, and
 * again when the engine stops answering or stops accepting the bearer.
 *
 * The engine's endpoint is stateless: one JSON-RPC message (or batch) per POST,
 * answered with JSON, 202 for a notification, no session. So forwarding is a
 * line from stdin, one POST, and the answer re-serialized to one line on stdout.
 *
 * The bridge answers the handshake itself (`initialize`, `ping`), so an agent
 * that starts before any engine exists — the first session after `init`, as a
 * rule — still connects. With no engine it lists no tools, and tells the agent
 * the list changed once one appears (`notifications/tools/list_changed`).
 *
 * stdout carries MCP frames and nothing else, on every path: every diagnostic
 * goes to the log sink (stderr), and nothing here throws past {@link runMcpBridge}.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isLoopbackUrl } from "./local-engine-handshake.js";
import type { EngineLookup } from "./local-engine-lookup.js";
import { isRecord as isObject } from "./answer-shape.js";

/** Protocol revisions the bridge's own `initialize` answer can speak, newest first. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** How often the bridge checks for an engine while it has none. */
export const POLL_INTERVAL_MS = 2_000;

/**
 * How long connecting to the engine may take. Only connecting: once a request
 * is sent, the agent owns its timeout and cancellation, and a tool that runs a
 * long function must not be cut off here.
 */
export const CONNECT_TIMEOUT_MS = 5_000;

/** JSON-RPC error codes. `SERVER_ERROR` is every bridge-side refusal. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;
const SERVER_ERROR = -32000;

/** What one POST to the engine came back with. */
export interface EngineReply {
  status: number;
  contentType: string;
  body: string;
}

/**
 * Why a POST did not come back. `refused`: it never reached the engine (nothing
 * listening, or the connection could not be made), so sending it again cannot
 * repeat work. `unknown`: the connection failed after the request may have
 * been sent, so whether it ran is not known.
 */
export type PostFailureKind = "refused" | "unknown";

export class PostFailure extends Error {
  constructor(
    readonly kind: PostFailureKind,
    message: string,
  ) {
    super(message);
  }
}

/** POST `body` to `url`. Rejects only with a {@link PostFailure}. */
export type EnginePost = (url: string, headers: Record<string, string>, body: string) => Promise<EngineReply>;

export interface BridgeOptions {
  /** Lines from the agent: stdin, split on newlines. Ends when stdin closes. */
  lines: AsyncIterable<string>;
  /** Write one frame, without its newline, to stdout. */
  write: (frame: string) => void;
  /** Write one diagnostic line to stderr. Redaction is the caller's sink's job. */
  log: (line: string) => void;
  /** Find the engine. Called on the first message, on a poll that sees a change, and after a refusal. */
  lookup: () => Promise<EngineLookup>;
  /**
   * A value that changes when this project's (or the named engine's) record
   * does — read on each poll, so a deploy elsewhere on the machine does not
   * cost a lookup.
   */
  recordSignal: () => string;
  /** Called with each bearer the lookup hands back, before it is first sent. */
  registerSecret: (token: string) => void;
  /** How the fix in a no-engine answer spells a command (`npx xanosdk`). */
  cli?: string;
  post?: EnginePost;
  pollMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

type JsonRpcId = string | number | null;
type Message = Record<string, unknown>;

/** Run the bridge until `lines` ends. Never rejects. */
export async function runMcpBridge(opts: BridgeOptions): Promise<void> {
  const bridge = new Bridge(opts);
  try {
    await bridge.run();
  } catch (err) {
    opts.log(`xano-local MCP bridge stopped: ${(err as Error).message}`);
  }
}

class Bridge {
  private readonly post: EnginePost;
  private readonly cli: string;
  /** The engine in use, or why there is none. Undefined until first looked up. */
  private state: EngineLookup | undefined;
  private resolving: Promise<EngineLookup> | undefined;
  /** The agent sent `notifications/initialized`: notifications may now be sent to it. */
  private initialized = false;
  private lastSignal: string | undefined;
  /** The lookup failure last said on stderr, so one that persists is said once, not every poll. */
  private lastFailure: string | undefined;
  private timer: unknown;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly opts: BridgeOptions) {
    this.post = opts.post ?? defaultPost;
    this.cli = opts.cli ?? "npx xanosdk";
  }

  async run(): Promise<void> {
    try {
      for await (const line of this.opts.lines) {
        if (line.trim() === "") continue;
        // Concurrently: a long tool call must not hold up a ping behind it.
        const handling = this.handleLine(line).catch((err: unknown) => {
          this.opts.log(`xano-local MCP bridge: ${(err as Error).message}`);
        });
        this.pending.add(handling);
        void handling.finally(() => this.pending.delete(handling));
      }
      await Promise.all(this.pending);
    } finally {
      this.stopPolling();
    }
  }

  // ── messages ──────────────────────────────────────────────────────────────

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.send(errorFrame(null, PARSE_ERROR, "Parse error: the line is not JSON."));
      return;
    }
    if (Array.isArray(parsed)) return this.handleBatch(parsed, line);
    if (!isObject(parsed)) {
      this.send(errorFrame(null, INVALID_REQUEST, "Invalid request: expected a JSON-RPC object."));
      return;
    }
    if (typeof parsed.method !== "string") {
      if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
        // A response — to a request this bridge never sends.
        this.opts.log("xano-local MCP bridge: dropped a response to a request it did not send.");
      } else {
        this.send(errorFrame(idOf(parsed), INVALID_REQUEST, "Invalid request: no method."));
      }
      return;
    }
    const answer = await this.handleMessage(parsed, line);
    if (answer !== undefined) this.send(answer);
  }

  /** One message's answer, or undefined when it gets none (a notification). */
  private async handleMessage(msg: Message, raw: string): Promise<Message | Message[] | undefined> {
    const method = msg.method as string;
    const isRequest = "id" in msg;
    if (method === "ping") return isRequest ? { jsonrpc: "2.0", id: idOf(msg), result: {} } : undefined;
    if (method === "notifications/initialized") this.initialized = true;
    const state = await this.current();
    if (method === "initialize") return this.initialize(msg, raw, state);
    if (state.state !== "usable") return isRequest ? this.noEngineAnswer(msg, state) : undefined;
    return this.forward(raw, msg, state);
  }

  private async handleBatch(items: unknown[], raw: string): Promise<void> {
    const state = await this.current();
    if (state.state === "usable" && items.every((m) => isObject(m) && m.method !== "initialize")) {
      const answer = await this.forward(raw, undefined, state);
      if (answer !== undefined) this.send(answer);
      // Nothing to say for a notification-only batch; but when the engine was
      // gone by the retry, the batch never ran and each request still needs
      // its answer, which the loop below gives.
      if (answer !== undefined || this.state?.state === "usable") return;
    }
    // No engine (or an initialize inside): each message answered as if alone.
    const answers: Message[] = [];
    for (const item of items) {
      if (!isObject(item) || typeof item.method !== "string") {
        answers.push(errorFrame(isObject(item) ? idOf(item) : null, INVALID_REQUEST, "Invalid request: no method."));
        continue;
      }
      const answer = await this.handleMessage(item, JSON.stringify(item));
      if (Array.isArray(answer)) answers.push(...answer);
      else if (answer !== undefined) answers.push(answer);
    }
    if (answers.length > 0) this.send(answers);
  }

  /**
   * The bridge's own `initialize` answer, with the engine's server info and
   * instructions when there is an engine to ask. `listChanged` is the bridge's
   * promise either way: it is the bridge that notices an engine come and go.
   */
  private async initialize(msg: Message, raw: string, state: EngineLookup): Promise<Message> {
    const id = idOf(msg);
    const params = isObject(msg.params) ? msg.params : {};
    const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
    const local: Message = {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: asked !== undefined && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "xano-local", title: "Xano Engine (local, via xanosdk)", version: "1" },
        instructions: noEngineText(state, this.cli),
      },
    };
    if (state.state !== "usable") return local;
    const answer = await this.forward(raw, msg, state);
    if (!isObject(answer) || !isObject(answer.result)) return local;
    const result = answer.result;
    const capabilities = isObject(result.capabilities) ? result.capabilities : {};
    const tools = isObject(capabilities.tools) ? capabilities.tools : {};
    return { ...answer, result: { ...result, capabilities: { ...capabilities, tools: { ...tools, listChanged: true } } } };
  }

  /** The answer a request gets while there is no engine: what to do, in words the model reads. */
  private noEngineAnswer(msg: Message, state: EngineLookup): Message {
    const id = idOf(msg);
    const text = noEngineText(state, this.cli);
    if (msg.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [] } };
    if (msg.method === "tools/call") {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
    }
    return errorFrame(id, SERVER_ERROR, text);
  }

  // ── forwarding ────────────────────────────────────────────────────────────

  /**
   * POST `raw` to the engine and turn its answer into what the agent gets.
   * `msg` is undefined for a batch. Resent once, after a fresh lookup, only when
   * the first attempt provably did not run: refused, an HTTP 401 (no bearer
   * reached the route), or the engine's in-band refusal of a stale bearer (the
   * Meta API refuses it before the route runs).
   */
  private async forward(raw: string, msg: Message | undefined, state: EngineLookup): Promise<Message | Message[] | undefined> {
    const first = await this.attempt(raw, state);
    if (!needsRetry(first)) return this.answerFor(first, msg);
    const fresh = await this.refresh();
    if (fresh.state !== "usable") return msg !== undefined && "id" in msg ? this.noEngineAnswer(msg, fresh) : undefined;
    return this.answerFor(await this.attempt(raw, fresh), msg);
  }

  private async attempt(raw: string, state: EngineLookup): Promise<Attempt> {
    if (state.state !== "usable") return { kind: "refused", message: "no engine" };
    // Checked before every send, not once: this is where the bearer leaves.
    if (!isLoopbackUrl(state.mcpUrl)) {
      return { kind: "refused", message: `the engine's MCP url is not on this machine (${state.mcpUrl})` };
    }
    try {
      const reply = await this.post(
        state.mcpUrl,
        {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${state.engine.token}`,
        },
        raw,
      );
      return { kind: "reply", reply, frames: parseReply(reply) };
    } catch (err) {
      if (err instanceof PostFailure && err.kind === "refused") return { kind: "refused", message: err.message };
      return { kind: "unknown", message: (err as Error).message };
    }
  }

  private answerFor(attempt: Attempt, msg: Message | undefined): Message | Message[] | undefined {
    const id = msg === undefined ? null : idOf(msg);
    const isRequest = msg === undefined || "id" in msg;
    if (attempt.kind === "refused") {
      this.opts.log(`xano-local MCP bridge: the engine refused the connection (${attempt.message}).`);
      return isRequest
        ? errorFrame(id, SERVER_ERROR, `The Xano Engine is not answering. Deploy again with \`${this.cli} deploy --local\`, then retry.`)
        : undefined;
    }
    if (attempt.kind === "unknown") {
      this.opts.log(`xano-local MCP bridge: the connection to the engine failed after sending (${attempt.message}).`);
      if (!isRequest) return undefined;
      const what = msg?.method === "tools/call" ? describeCall(msg) : `this ${typeof msg?.method === "string" ? msg.method : "batch"} request`;
      return errorFrame(
        id,
        SERVER_ERROR,
        `The connection to the Xano Engine failed after ${what} was sent, so whether it ran is unknown. ` +
          `It was not sent again. Check what it would have changed before retrying.`,
      );
    }
    const { reply, frames } = attempt;
    if (reply.status === 202) return undefined;
    if (frames === undefined) {
      if (!isRequest) return undefined;
      return errorFrame(id, INTERNAL_ERROR, `The Xano Engine answered HTTP ${reply.status} without a JSON-RPC message.`);
    }
    // The engine's 401 names no id; the agent needs its own back.
    if (reply.status === 401 && !Array.isArray(frames) && frames.id === null && msg !== undefined) {
      return isRequest ? { ...frames, id } : undefined;
    }
    return frames;
  }

  // ── the engine ────────────────────────────────────────────────────────────

  /** The state, looked up on first use. */
  private async current(): Promise<EngineLookup> {
    return this.state ?? this.refresh();
  }

  /** Look the engine up again; one lookup at a time, shared by whoever asks. */
  private refresh(): Promise<EngineLookup> {
    this.resolving ??= this.lookup().finally(() => {
      this.resolving = undefined;
    });
    return this.resolving;
  }

  private async lookup(): Promise<EngineLookup> {
    this.lastSignal = this.readSignal();
    let found: EngineLookup;
    try {
      found = await this.opts.lookup();
      this.lastFailure = undefined;
    } catch (err) {
      const failure = (err as Error).message;
      if (failure !== this.lastFailure) this.opts.log(`xano-local MCP bridge: could not look up the Xano Engine: ${failure}`);
      this.lastFailure = failure;
      found = { state: "not-running" };
      // Not a confirmed absence: forget the signal so the next poll looks again
      // instead of waiting for a record change that may never come.
      this.lastSignal = undefined;
    }
    if (found.state === "usable") this.opts.registerSecret(found.engine.token);
    const before = this.state;
    this.state = found;
    if (found.state === "usable") this.stopPolling();
    else this.startPolling();
    if (before !== undefined && connectionOf(before) !== connectionOf(found)) this.notifyToolsChanged();
    return found;
  }

  private notifyToolsChanged(): void {
    if (this.initialized) this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  private readSignal(): string | undefined {
    try {
      return this.opts.recordSignal();
    } catch {
      return undefined;
    }
  }

  private startPolling(): void {
    if (this.timer !== undefined) return;
    const every = this.opts.setInterval ?? ((fn, ms) => setInterval(fn, ms).unref());
    this.timer = every(() => {
      const signal = this.readSignal();
      if (signal === this.lastSignal || this.resolving !== undefined) return;
      void this.refresh();
    }, this.opts.pollMs ?? POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.timer === undefined) return;
    (this.opts.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout)))(this.timer);
    this.timer = undefined;
  }

  private send(frame: Message | Message[]): void {
    this.opts.write(JSON.stringify(frame));
  }
}

type Attempt =
  | { kind: "reply"; reply: EngineReply; frames: Message | Message[] | undefined }
  | { kind: "refused"; message: string }
  | { kind: "unknown"; message: string };

/** Which engine a state talks to: its MCP url, or nothing. A change is a tool-list change. */
function connectionOf(state: EngineLookup): string | undefined {
  return state.state === "usable" ? state.mcpUrl : undefined;
}

function needsRetry(attempt: Attempt): boolean {
  if (attempt.kind === "refused") return true;
  if (attempt.kind === "unknown") return false;
  if (attempt.reply.status === 401) return true;
  const { frames } = attempt;
  return frames !== undefined && !Array.isArray(frames) && isBearerRefusal(frames);
}

/**
 * The engine's answer to a tool call whose bearer the Meta API refused: a
 * successful JSON-RPC response carrying a tool error, whose text is the Meta
 * API's 401 plus the engine's hint that it was this server's bearer. The engine
 * re-mints its bearer on a schedule without restarting, so this — not a refused
 * connection — is what an expired bearer looks like.
 *
 * The hint is part of the match, not decoration: a function, task or endpoint
 * the agent runs can throw its own unauthorized error, which arrives in the
 * same wrapper with the same code and status after its side effects ran.
 * Resending that would run them twice.
 */
export function isBearerRefusal(frame: Message): boolean {
  const result = frame.result;
  if (!isObject(result) || result.isError !== true || !Array.isArray(result.content)) return false;
  return result.content.some((part) => {
    if (!isObject(part) || part.type !== "text" || typeof part.text !== "string") return false;
    try {
      const body = JSON.parse(part.text) as unknown;
      return (
        isObject(body) &&
        body.status === 401 &&
        body.code === "ERROR_CODE_UNAUTHORIZED" &&
        typeof body.hint === "string" &&
        /refused this server's bearer/.test(body.hint)
      );
    } catch {
      return false;
    }
  });
}

/** The engine's body as JSON-RPC: JSON, or an event stream's `data:` payloads. */
function parseReply(reply: EngineReply): Message | Message[] | undefined {
  if (/text\/event-stream/i.test(reply.contentType)) {
    const frames: Message[] = [];
    for (const event of reply.body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "") continue;
      const parsed = parseJson(data);
      if (Array.isArray(parsed)) frames.push(...parsed.filter(isObject));
      else if (isObject(parsed)) frames.push(parsed);
    }
    if (frames.length === 0) return undefined;
    return frames.length === 1 ? frames[0] : frames;
  }
  const parsed = parseJson(reply.body);
  if (Array.isArray(parsed)) return parsed.filter(isObject);
  return isObject(parsed) ? parsed : undefined;
}

/** The fix for a state with no usable engine, as a sentence the model can act on. */
export function noEngineText(state: EngineLookup, cli: string): string {
  if (state.state === "usable") return "Operates the workspace deployed to the Xano Engine on this machine.";
  const deploy = `Deploy with \`npm run xano:deploy\` (or \`${cli} deploy --local\`) and the tools appear here.`;
  const named = state.name === undefined ? "This project's Xano Engine" : `Xano Engine "${state.name}"`;
  switch (state.state) {
    case "none-cached":
    case "not-recorded":
      return `No Xano Engine is running for this project. ${deploy}`;
    case "not-running":
      return (
        `${named} is not running.` +
        (state.suggestion === undefined ? "" : ` Did you mean "${state.suggestion}"? It is running.`) +
        ` ${deploy}`
      );
    case "no-mcp":
      return `${named} serves no MCP server. Run \`${cli} local update\`, then deploy again, and the tools appear here.`;
    case "not-loopback":
      return (
        `${named} listens beyond this machine, so its bearer is not sent to it. ` +
        `Stop it with \`${cli} local stop${state.name === undefined ? "" : ` ${state.name}`}\`, then deploy again.`
      );
  }
}

function describeCall(msg: Message): string {
  const params = isObject(msg.params) ? msg.params : {};
  return typeof params.name === "string" ? `the call to ${params.name}` : "the tool call";
}

function errorFrame(id: JsonRpcId, code: number, message: string): Message {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function idOf(msg: Message): JsonRpcId {
  const id = msg.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The real POST, over `node:http` rather than `fetch`: `fetch` puts a default
 * deadline on waiting for an answer, and here only connecting may be bounded.
 * It also tells apart the two failures the bridge treats differently — a
 * connection that was never made (safe to send again) and one lost after the
 * request went out (not).
 */
export const defaultPost: EnginePost = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    let connected = false;
    const req = send(target, {
      method: "POST",
      // A fresh connection per request: a pooled socket the engine already
      // closed would fail after "connecting" and read as an unknown outcome
      // for a request that never left. On loopback the handshake is free.
      agent: false,
      headers: { ...headers, "content-length": Buffer.byteLength(body) },
    });
    const connectTimer = setTimeout(() => {
      req.destroy(new PostFailure("refused", `could not connect within ${CONNECT_TIMEOUT_MS / 1000}s`));
    }, CONNECT_TIMEOUT_MS);
    req.on("socket", (socket) => {
      const onConnect = (): void => {
        connected = true;
        clearTimeout(connectTimer);
      };
      // A reused keep-alive socket is already connected.
      if (!socket.connecting) onConnect();
      else socket.once("connect", onConnect);
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(connectTimer);
      if (err instanceof PostFailure) return reject(err);
      const refused = !connected || err.code === "ECONNREFUSED";
      reject(new PostFailure(refused ? "refused" : "unknown", err.message));
    });
    req.on("response", (res: IncomingMessage) => {
      clearTimeout(connectTimer);
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", (err) => reject(new PostFailure("unknown", err.message)));
      res.on("aborted", () => reject(new PostFailure("unknown", "the answer was cut off")));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.end(body);
  });
