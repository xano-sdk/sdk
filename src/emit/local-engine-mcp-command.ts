/**
 * `xanosdk local mcp [--stdio]` — how a coding agent reaches a Xano Engine's
 * MCP server, and the stdio bridge an agent's config launches to reach it.
 *
 * Split from `local-engine-command.ts`, which dispatches here lazily: the
 * bridge is the one verb an agent runs, for a whole session, and neither half
 * shares anything with the lifecycle verbs beyond resolving the engine.
 *
 * `mcp` reads the engine's bearer and only ever SENDS it: the details point at
 * `local token`, and the `--stdio` bridge hands it to the engine and nowhere
 * else.
 */
import { resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { isMachineOutput, writeJson } from "./output.js";
import { MCP_CONFIGS, MCP_SERVER_NAME, mcpServerCommand, projectFileCli } from "./invocation.js";
import { detectPackageManager } from "./package-manager.js";
import { info, printHuman } from "./ui.js";
import { resolveLiveEngine, type LocalEngineCommandOptions } from "./local-engine-command.js";

/**
 * How a coding agent reaches a Xano Engine's MCP server, or — under `--stdio` —
 * the bridge that reaches it.
 *
 * The details never carry the bearer: an agent's config must not hold one (a
 * restart re-mints it), so what they give is the command the config launches,
 * which looks the bearer up each time it needs one.
 */
export async function runMcp(args: ParsedArgs, opts: LocalEngineCommandOptions): Promise<void> {
  if (args.stdio) return runMcpStdio(args, opts);
  if (args.project !== undefined) process.chdir(resolve(args.project));
  const engine = await resolveLiveEngine(args.positionals[0], opts, "connect an agent to");
  const dir = process.cwd();
  const manager = detectPackageManager(dir, opts.env ?? process.env);
  const server = mcpServerCommand(dir, manager);
  if (engine.mcpUrl === undefined) {
    info(`Xano Engine ${engine.name} serves no MCP server for coding agents; \`xanosdk local update\` moves the project to one that does.`);
  }
  if (isMachineOutput(args)) {
    // Field by field, for the reason `token` is: the listing carries the bearer
    // and the sign-in url, and neither belongs here.
    writeJson({
      name: engine.name,
      url: engine.url,
      mcpUrl: engine.mcpUrl ?? null,
      workspaceId: engine.workspaceId,
      command: [server.command, ...server.args],
    });
    return;
  }
  if (engine.mcpUrl === undefined) return;
  const labels = MCP_CONFIGS.map((c) => `${c.path} (${c.agent})`);
  const width = Math.max(...labels.map((l) => l.length));
  const configs = MCP_CONFIGS.map((c, i) => {
    const block = mcpServerCommand(dir, manager, c.workspaceFolder === undefined ? {} : { workspaceFolder: c.workspaceFolder });
    return `  ${labels[i]!.padEnd(width)}  ${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: block } })}`;
  });
  printHuman(
    [
      `Xano Engine ${engine.name}`,
      `  URL      ${engine.url}`,
      `  MCP      ${engine.mcpUrl}`,
      `  Bearer   \`xanosdk local token\` (the bridge fetches it itself; never put it in a config)`,
      `  Command  ${[server.command, ...server.args].join(" ")}`,
      ``,
      `Connect a coding agent with this server (\`xanosdk init\` writes each):`,
      ...configs,
      ``,
      `Use it to look at the backend, seed and edit rows, and run functions, tasks, triggers, endpoints and tests.`,
      `Tables, functions, endpoints and every other primitive change in xano/ and ship with \`xanosdk deploy\`.`,
    ].join("\n") + "\n",
  );
}

/**
 * The bridge. stdout is the agent's MCP channel from here on, so nothing but
 * MCP frames may reach it — not a failure document, and nothing the CLI's
 * interrupt handler would write. Every failure is caught and said on stderr,
 * and the signal handlers are replaced with ones that only say so there and
 * exit: an agent stopping its server is the normal end of a session, not a
 * cancelled command, and the handler's reports (a write left in flight among
 * them) describe a run this is not.
 */
async function runMcpStdio(args: ParsedArgs, opts: LocalEngineCommandOptions): Promise<void> {
  const log = (line: string): void => void process.stderr.write(line + "\n");
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.removeAllListeners(signal);
    process.on(signal, () => {
      log(`xano-local MCP bridge: stopped by ${signal}.`);
      process.exit(code);
    });
  }
  try {
    // Inside the catch: a --project that is gone must be said on stderr, never
    // reach the CLI's failure document on stdout.
    if (args.project !== undefined) process.chdir(resolve(args.project));
    const env = opts.env ?? process.env;
    const cwd = process.cwd();
    const name = args.positionals[0];
    const [{ createInterface }, { runMcpBridge }, { lookupEngine }, { registerSecret, writeData }, { projectKey, readLocalEngineState }] =
      await Promise.all([
        import("node:readline"),
        import("../deploy/local-engine-mcp-bridge.js"),
        import("../deploy/local-engine-lookup.js"),
        import("../util/secrets.js"),
        import("../deploy/local-engine-state.js"),
      ]);
    await runMcpBridge({
      lines: createInterface({ input: process.stdin, crlfDelay: Infinity }),
      // Unredacted on purpose: a frame is data the agent asked for (a row may
      // well hold a token-shaped value), and rewriting it would corrupt it.
      write: (frame) => void writeData(process.stdout, frame + "\n"),
      log,
      lookup: () => lookupEngine({ cwd, ...(name === undefined ? {} : { name }), env }),
      // This project's row, or the rows naming the engine asked for: a deploy
      // in another project rewrites the same file and must not cost a lookup.
      recordSignal: () => {
        const { engines } = readLocalEngineState(env);
        return JSON.stringify(
          name === undefined ? engines[projectKey(cwd)] : Object.values(engines).filter((r) => r.name === name),
        );
      },
      registerSecret,
      // Spelled as the project's own files spell it: the reader is an agent
      // working in the project, whatever launched this process.
      cli: projectFileCli(cwd, detectPackageManager(cwd, env)),
    });
  } catch (err) {
    log(`xano-local MCP bridge stopped: ${(err as Error).message}`);
  }
}
