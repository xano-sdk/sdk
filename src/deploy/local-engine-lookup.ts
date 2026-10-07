/**
 * Find this project's (or a named) Xano Engine without changing anything.
 *
 * The selector resolver's local arm does the same matching, and also tidies up
 * as it goes: a recorded engine the listing no longer shows has its record
 * cleared and what it left running swept, and the listing runs synchronously.
 * Right for a command a person ran; wrong for the long-lived MCP bridge, which
 * polls in the background while an agent talks to it. A background process
 * that cleared records would race `deploy --local`, which owns them, and one
 * that blocked on a subprocess would stop answering the agent.
 *
 * So this is the same rules — name or the project's record, matched by NAME
 * against the listing, loopback before the bearer comes back — with no writes,
 * no sweep, and an asynchronous listing. What it cannot find comes back as a
 * reason rather than a throw, because the bridge answers every reason the same
 * way (stay connected, tell the agent how to fix it) and only the words differ.
 */
import { suggest } from "../util/suggest.js";
import { isLoopbackUrl, type LocalEngine } from "./local-engine-handshake.js";
import { getEngineRecord } from "./local-engine-state.js";

/** Why no usable engine was found. Each maps to one fix the bridge names. */
export type EngineLookupReason =
  /** Nothing is cached on this machine, so nothing here can list engines. */
  | "none-cached"
  /** No name was given and this project has never deployed locally. */
  | "not-recorded"
  /** The engine named or recorded is not in the listing. */
  | "not-running"
  /** It runs, but does not serve an MCP server (an older release, or MCP off). */
  | "no-mcp"
  /** It runs bound to somewhere off this machine, so its bearer may not follow. */
  | "not-loopback";

export type EngineLookup =
  | { state: "usable"; engine: LocalEngine; mcpUrl: string }
  | { state: EngineLookupReason; name?: string; suggestion?: string };

export interface EngineLookupOptions {
  /** The project directory whose record names the engine when no name is given. */
  cwd: string;
  /** An engine named explicitly. Empty reads as none. */
  name?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * The listing, or undefined when no engine is cached to ask. Defaults to the
   * cached binary the lifecycle verbs pick, run asynchronously. A throw passes
   * through: a listing that could not run says nothing about what is running.
   */
  listEngines?: () => Promise<readonly LocalEngine[] | undefined>;
}

export async function lookupEngine(opts: EngineLookupOptions): Promise<EngineLookup> {
  const env = opts.env ?? process.env;
  const name = opts.name !== undefined && opts.name !== "" ? opts.name : getEngineRecord(opts.cwd, env)?.name;
  // First and without a subprocess: a project that never deployed has nothing
  // to look for.
  if (name === undefined) return { state: "not-recorded" };
  const running = await (opts.listEngines ?? defaultListing(env, opts.cwd))();
  if (running === undefined) return { state: "none-cached" };
  const engine = running.find((e) => e.name === name);
  if (engine === undefined) {
    const near = suggest(name, running.map((e) => e.name));
    return { state: "not-running", name, ...(near === undefined ? {} : { suggestion: near }) };
  }
  if (!isLoopbackUrl(engine.url)) return { state: "not-loopback", name };
  if (engine.mcpUrl === undefined) return { state: "no-mcp", name };
  return { state: "usable", engine, mcpUrl: engine.mcpUrl };
}

/** Imported lazily: the process module is the one that spawns. */
function defaultListing(env: NodeJS.ProcessEnv, cwd: string): () => Promise<readonly LocalEngine[] | undefined> {
  return async () => {
    const { cachedEngineEntry, listEnginesAsync } = await import("./local-engine-process.js");
    const entry = cachedEngineEntry(env, cwd);
    return entry === undefined ? undefined : listEnginesAsync({ entry, env });
  };
}
