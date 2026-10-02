/**
 * The one place that knows how to run npm.
 *
 * Several commands shell out to npm — `init`/`codegen` install a fresh
 * scaffold's dependencies (scaffold.ts), `marketplace install` adds a package
 * to an existing project (marketplace-command.ts), `upgrade` replaces this very
 * package (upgrade-command.ts), and `init --web` runs a package it deliberately
 * does not depend on (init-web.ts). The platform detail they share is
 * how npm is STARTED: on Windows the thing on PATH is `npm.cmd`, a batch file
 * that a current Node refuses to spawn, so npm has to be reached another way
 * (see {@link npmCommand}). That is exactly the kind of thing that gets fixed
 * in one caller and not the other, so it lives here instead.
 *
 * Deliberately free of UI calls and of any opinion about failure. The callers
 * disagree about fatality — a failed scaffold install is non-fatal (the tree is
 * still valid and the user can retry), a failed marketplace install is the
 * whole command — so this returns the status and lets them decide.
 *
 * Node-only (`node:child_process`); reached only from the lazily-imported
 * command modules, so the browser-safe authoring bundle never pulls it in.
 */
import { spawn, spawnSync } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The npm executable for this platform. */
export function npmBinary(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/** How to actually start npm: the file to spawn, its argv, and whether a shell is needed. */
export interface NpmInvocation {
  readonly file: string;
  readonly args: readonly string[];
  /** Only ever true on the Windows last resort — see {@link npmCommand}. */
  readonly shell: boolean;
}

/**
 * Where npm's own JS entry point lives, if it is where npm puts it.
 *
 * On Windows `npm.cmd` sits beside `node.exe` and its last line is
 * `"%NODE_EXE%" "%~dp0\node_modules\npm\bin\npm-cli.js" %*`. This resolves the
 * same path, so calling it is not a guess about npm's layout — it is the shim's
 * own arithmetic, minus the batch file.
 *
 * (The shim also prefers a globally-installed npm at the configured prefix when
 * one exists. Reproducing that would mean running `npm-prefix.js` first, which
 * costs a process on every call to honour a case where the two npms differ.
 * The co-located one is the shim's default and is what ships with the running
 * Node.)
 *
 * The Unix layouts are checked too, though only Windows needs the answer. They
 * are what make this resolver verifiable: the suite runs it against the Node
 * running the suite, so a layout that moves fails in CI rather than on a user's
 * Windows box. That guard has already earned its keep — it caught the third
 * candidate below being missing.
 *
 * Three layouts, in the order they are cheapest to be right about:
 *
 * 1. `<dir>/node_modules` — beside `node.exe`. The Windows shim's own path.
 * 2. `<dir>/../lib/node_modules` — the ordinary Unix prefix, and what `nvm`,
 *    `fnm` and a distro package all produce.
 * 3. `<dir>/../libexec/lib/node_modules` — Homebrew. `brew` resolves
 *    `/opt/homebrew/bin/node` to a Cellar path, and the Cellar's own `lib` does
 *    NOT carry npm; it lives under `libexec`. Walking up from the RESOLVED
 *    `process.execPath` therefore misses layout 2 entirely on the most common
 *    macOS development setup.
 */
export function findNpmCli(nodeExecPath: string = process.execPath): string | undefined {
  const bin = dirname(nodeExecPath);
  const tail = ["node_modules", "npm", "bin", "npm-cli.js"];
  const candidates = [
    join(bin, ...tail),
    join(bin, "..", "lib", ...tail),
    join(bin, "..", "libexec", "lib", ...tail),
  ];
  return candidates.find((c) => existsSync(c));
}

/**
 * Resolve how to start npm on `platform`. Pure given its inputs, so every
 * branch is testable from any host —
 * the same shape as `browserCommand` in auth/loopback.ts, and for the same
 * reason: the branch that matters cannot be exercised on the host that runs CI.
 *
 * Windows needs the indirection. `npm.cmd` is a batch file, and since the
 * fix for CVE-2024-27980 (Node 18.20.2 / 20.12.2 / 21.7.3, April 2024)
 * `spawn` refuses to run a `.cmd` or `.bat` without `shell: true` — so every
 * npm call in this package fails EINVAL on a current Node for Windows before
 * npm is ever reached.
 *
 * Running npm's JS directly is the fix rather than `shell: true`, because a
 * shell reintroduces the problem it solves: Node does not escape arguments
 * when it builds the command line for `cmd.exe`, and this package forwards
 * user-supplied argv straight through (`init --web`). An unquoted `&` in a
 * directory name would end the command and start another one. Spawning
 * `node npm-cli.js` passes argv as argv, where nothing is re-parsed.
 *
 * `shell: true` survives only as the last resort for a layout where npm's JS
 * is not beside `node.exe`, and `quoteForCmd` covers the arguments there.
 */
export function npmCommand(
  platform: NodeJS.Platform,
  args: readonly string[],
  nodeExecPath: string = process.execPath,
  // A resolver rather than a resolved path: only the Windows branch needs the
  // answer, and a default that computed it eagerly would put two discarded
  // `existsSync` calls in front of every npm invocation on macOS and Linux.
  // Taking a function also keeps "not found" unambiguous in tests, where a
  // plain `undefined` argument cannot be told from an omitted one.
  resolveNpmCli: (node: string) => string | undefined = findNpmCli,
): NpmInvocation {
  if (platform !== "win32") return { file: "npm", args, shell: false };
  const cli = resolveNpmCli(nodeExecPath);
  if (cli !== undefined) return { file: nodeExecPath, args: [cli, ...args], shell: false };
  return { file: "npm.cmd", args: args.map(quoteForCmd), shell: true };
}

/**
 * Quote one argument for `cmd.exe`.
 *
 * Reached only on the Windows last resort above, where Node hands the joined
 * string to `cmd /c` without escaping anything. Everything cmd treats as
 * syntax — the redirection and chaining operators and the grouping parentheses
 * — forces quoting, not just whitespace: `a&b` has no space in it and is two
 * commands. Inside double quotes cmd stops honouring those operators.
 *
 * Two things quoting handles and one it cannot:
 *
 *   • A literal `"` becomes `""`, the CRT's own convention.
 *   • Backslashes immediately before the closing quote are DOUBLED. The CRT
 *     treats `\` as an escape only when it precedes a quote, so a path ending
 *     in one — `C:\My Projects\` — would otherwise escape its own terminator
 *     and swallow every argument after it.
 *   • `%VAR%` is expanded by cmd even inside double quotes, and `!VAR!` too
 *     when delayed expansion is on. There is no escape for it on a `cmd /c`
 *     command line, so a directory named `%TEMP%-old` is substituted before
 *     npm ever sees it. Quoted anyway — it is no worse — but this path cannot
 *     make that argument survive, which is one more reason it is the last
 *     resort and not the strategy.
 */
export function quoteForCmd(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^()%!]/.test(arg)) return arg;
  // `(\\*)"` doubles the run before an embedded quote; `(\\*)$` does the same
  // for the run that would collide with the terminator this adds.
  const escaped = arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * Run npm in `cwd` with npm's own output streaming through, and return its exit
 * status.
 *
 * A spawn that never started (npm missing from PATH) reports `status: null`
 * alongside an `error`. That is a failure, but a caller checking `status === 0`
 * would read `null` as merely "not zero" only by accident — and one comparing
 * `status !== 0` gets the right answer for the wrong reason. Normalize it to a
 * non-zero number so every caller sees an unambiguous failure.
 */
export function runNpm(
  args: readonly string[],
  cwd: string,
  opts?: RunNpmOptions,
): number {
  // `2` shares the parent's stderr as the child's stdout. npm prints its
  // summary ("added 1 package in 117ms") to STDOUT, which for a command whose
  // stdout is a data channel would land in front of the JSON document and make
  // a piped run unparseable. Routing it to stderr keeps the progress visible
  // without corrupting the artifact.
  const stdout = opts?.stdout === "stderr" ? 2 : "inherit";
  const npm = managerCommand(opts?.manager, args);
  const res = spawnSync(npm.file, [...npm.args], {
    cwd,
    stdio: ["inherit", stdout, "inherit"],
    shell: npm.shell,
    // Bounded on the same budget as the captured runs. This one STREAMS to the
    // user's terminal, so a stall is at least visible — but visible is not the
    // same as escapable in CI, where nobody is there to press Ctrl-C.
    timeout: opts?.timeoutMs ?? NPM_RUN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return res.status ?? 1;
}

/**
 * {@link runNpm} without blocking the event loop: npm's output still streams
 * through, and the status arrives as a promise.
 *
 * For an install the run must be able to report an interrupt over. While a
 * synchronous spawn runs, a Ctrl-C handler cannot: the signal waits until npm
 * has exited, and the caller reads npm's own interrupted exit as an ordinary
 * failure — over an install that may already have landed. Awaiting the child
 * leaves the handler free to answer at once.
 */
export function runNpmStreaming(args: readonly string[], cwd: string, opts?: RunNpmOptions): Promise<number> {
  const stdout = opts?.stdout === "stderr" ? 2 : "inherit";
  const npm = managerCommand(opts?.manager, args);
  return new Promise<number>((resolve) => {
    const child = spawn(npm.file, [...npm.args], { cwd, stdio: ["inherit", stdout, "inherit"], shell: npm.shell });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts?.timeoutMs ?? NPM_RUN_TIMEOUT_MS);
    const settle = (status: number): void => {
      clearTimeout(timer);
      resolve(status);
    };
    // A spawn that never started (npm missing from PATH) is a failure, as in `runNpm`.
    child.once("error", () => settle(1));
    child.once("close", (code) => settle(code ?? 1));
  });
}

export interface RunNpmOptions {
  /**
   * Where npm's own stdout goes. `"inherit"` (the default) is right when the
   * caller's stdout is already human-facing; `"stderr"` is required of any
   * caller that also writes a machine-readable document to stdout.
   */
  readonly stdout?: "inherit" | "stderr";
  /** The budget, in milliseconds. Defaults to {@link NPM_RUN_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** The package manager to run instead of npm — see `package-manager.ts`. */
  readonly manager?: "npm" | "pnpm" | "yarn" | "bun";
}

/**
 * How to start `manager` (npm when unset). npm takes {@link npmCommand}'s
 * Windows route; pnpm, yarn and bun are run by name, through a quoted
 * `cmd.exe` line on Windows, where what is on PATH is a `.cmd` shim.
 */
function managerCommand(manager: RunNpmOptions["manager"], args: readonly string[]): NpmInvocation {
  if (manager === undefined || manager === "npm") return npmCommand(process.platform, args);
  if (process.platform !== "win32") return { file: manager, args, shell: false };
  return { file: `${manager}.cmd`, args: args.map(quoteForCmd), shell: true };
}

/** What a captured npm run did: its status, and everything it printed. */
export interface NpmRunOutput {
  readonly status: number;
  /** stdout and stderr, interleaved in the order npm wrote them. */
  readonly output: string;
}

/**
 * Run npm with nothing shown, and hand the caller everything it printed.
 *
 * For a job that has its own progress line. `npm install` narrates twenty lines
 * of tree summary, funding pitch and audit count on SUCCESS — none of which the
 * reader asked for, all of which arrives in the middle of a questionnaire and
 * pushes the questions off the screen. A spinner says the same thing in one
 * self-erasing line, so the noise is kept rather than shown: captured here,
 * printed by the caller only when npm fails, which is the one time those lines
 * carry a reason.
 *
 * ASYNC, and that is the whole reason it is not `spawnSync`. A spinner animates
 * off a `setInterval`, and Node runs one thread: a synchronous spawn blocks the
 * event loop for the entire install, so the timer cannot fire and the caller's
 * spinner freezes on its first frame with no elapsed counter — silent AND
 * frozen, which is worse than the npm output it replaced. Awaiting a streamed
 * child leaves the loop free, so the spinner is a live one.
 *
 * Streaming also removes a ceiling: `spawnSync` caps a captured pipe at 1MB and
 * SIGTERMs the child on overflow, which would have turned a chatty install (a
 * native build, a noisy postinstall) into a killed one reported as an ordinary
 * failure. Chunks are concatenated as they arrive, so there is no cap and the
 * two streams are genuinely in the order npm wrote them.
 *
 * stdin is INHERITED, as it was before capture. npm rarely reads it, but when
 * it does — a private registry's credential prompt — a closed stdin turns a
 * question into an unexplained failure.
 */
export function runNpmQuiet(
  args: readonly string[],
  cwd: string,
  opts: CaptureOptions & Pick<RunNpmOptions, "manager"> = {},
): Promise<NpmRunOutput> {
  return captureCommand(managerCommand(opts.manager, args), cwd, opts);
}

/** How long an install or uninstall may take before it is killed. */
export const NPM_RUN_TIMEOUT_MS = 10 * 60_000;

/** What a captured run was allowed. */
export interface CaptureOptions {
  /**
   * The budget, in milliseconds. Defaults to {@link NPM_RUN_TIMEOUT_MS}.
   *
   * Generous rather than tight: a cold cache, a native build or a large tree is
   * legitimately slow, and a budget that fires on a SLOW install rather than a
   * STUCK one would be worse than none. What it rules out is the unbounded
   * case — a registry that accepts the connection and then says nothing, which
   * otherwise hangs until CI's outer timeout kills the whole job with npm's
   * output never printed and no clue which step was stuck.
   */
  readonly timeoutMs?: number;
}

/** npm's peer-conflict signature, which is worth one retry rather than a shrug. */
export function isPeerConflict(stderr: string): boolean {
  return /ERESOLVE|peer dep|peerinvalid/i.test(stderr);
}

// `installWithPeerRetry`, which orchestrates two calls to `runNpmQuiet`, lives
// in `npm-install.ts`. This file stays the layer that only runs npm and reports
// what happened; see that file's header for why the boundary matters to a
// caller's tests.

/**
 * Run one resolved invocation and collect everything it printed.
 *
 * The body of {@link runNpmQuiet}, separated from the npm-specific part so the
 * streaming contract above — interleaved capture, no ceiling, a spawn failure
 * that still says something — can be driven against a deterministic child
 * rather than against a real `npm install`.
 */
export function captureCommand(
  npm: NpmInvocation,
  cwd: string,
  opts: CaptureOptions = {},
): Promise<NpmRunOutput> {
  return new Promise<NpmRunOutput>((resolve) => {
    const child = spawn(npm.file, [...npm.args], {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      shell: npm.shell,
    });
    let output = "";
    const budget = opts.timeoutMs ?? NPM_RUN_TIMEOUT_MS;
    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    // SIGTERM first, so npm can unwind a half-written `node_modules` the way a
    // Ctrl-C would; SIGKILL only if it will not go.
    //
    // Enforced here rather than through `spawn`'s own `timeout`/`killSignal`
    // (which `runNpm` does use) because this path has to REPORT the timeout,
    // and the built-in leaves only the exit signal to infer it from — which
    // cannot tell our SIGTERM from a CI runner cancelling the job, and would
    // put "npm timed out after 600s" on a run that was cancelled at 10.
    //
    // Killing the child still fires `close`, so the resolve below is the one
    // that answers — which is why `timedOut` is a flag and not a second
    // `resolve`.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        child.kill("SIGKILL");
        // Settle from HERE as a last resort, so the budget bounds the CALL and
        // not merely the child. `close` fires only once the process has exited
        // AND its stdio streams are closed, so a grandchild that inherits the
        // pipe and outlives its parent holds it open indefinitely — npm's own
        // lifecycle scripts spawn exactly that shape. Waiting for a `close`
        // that never comes would leave the caller on a promise that never
        // resolves, which is the hang this timeout exists to remove.
        //
        // `close` stays the normal path; the promise settles once, so whichever
        // arrives first wins and the other is discarded.
        detach();
        done(stalled());
      }, 5_000);
      escalation.unref();
    }, budget);
    // Never hold the process open on account of the budget itself.
    timer.unref();
    const done = (result: NpmRunOutput): void => {
      clearTimeout(timer);
      // A child that went on SIGTERM must not leave a SIGKILL pending against
      // a pid the OS is free to reuse.
      if (escalation !== undefined) clearTimeout(escalation);
      resolve(result);
    };
    /**
     * Stop waiting on a child that will not go.
     *
     * Only reached when the deadline settles the call itself. Dropping the
     * pipes and the child reference is what lets the CLI exit afterwards: an
     * inherited pipe an orphan still holds would otherwise keep the event loop
     * alive long past the answer we already gave.
     */
    const detach = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };
    /** Whatever it printed before it stalled, plus the reason. */
    const stalled = (): NpmRunOutput => {
      const reason =
        `npm timed out after ${Math.round(budget / 1000)}s and was killed. ` +
        `A registry that accepts the connection and then says nothing looks exactly like this.`;
      return { status: 1, output: output !== "" ? `${output}\n${reason}` : reason };
    };
    const collect = (stream: Readable | null) => {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        output += chunk;
      });
    };
    collect(child.stdout);
    collect(child.stderr);
    // Both can fire — a spawn that fails still emits `close`. `resolve` is
    // idempotent, so the first one wins and the second is discarded.
    child.on("error", (error) => {
      done({ status: 1, output: output !== "" ? output : describeSpawnFailure(npm.file, error) });
    });
    child.on("close", (code) => {
      const status = code ?? 1;
      if (timedOut) {
        // Whatever it managed to print before it stalled is the diagnosis —
        // which registry, which package it was reifying — so it is kept and the
        // reason is appended rather than replacing it.
        const killed = stalled();
        done({ ...killed, status: status === 0 ? 1 : status });
        return;
      }
      done({
        // A failure with nothing to show still has to say something, and the
        // something must be about THIS command: npm silenced by a `loglevel`
        // in .npmrc, or killed by a signal, prints nothing at all.
        output: output !== "" ? output : `npm exited ${status} without printing anything.`,
        status,
      });
    });
  });
}

/** What the registry said about a package, or why it could not be asked. */
export type NpmVersionResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly stderr: string };

/**
 * Ask the registry for a package's latest published version.
 *
 * Fully captured, unlike the two above: nothing is echoed, because the caller
 * is asking a question rather than running a job, and npm's answer is the
 * return value rather than something to look at. `stderr` comes back verbatim
 * on failure so the caller can say WHY — an unreachable registry, a private
 * one that 404s, and a missing npm are three different problems with three
 * different fixes, and a caller that only sees a status can describe none of
 * them.
 *
 * Runs in the process cwd. A version is a property of the registry, not of a
 * directory — but npm reads `.npmrc` from the cwd upward, so the registry it
 * asks is still the one this project is configured against.
 *
 * An empty answer with a zero status is a FAILURE, not a version of `""`.
 * npm exits 0 having printed nothing when a query matches no version, and a
 * caller that trusted the status would go on to `pkg@` — a spec that resolves
 * to something, just not the thing anyone asked for.
 */
export function npmViewVersion(pkg: string, cwd?: string): NpmVersionResult {
  const npm = npmCommand(process.platform, ["view", pkg, "version"]);
  const res = spawnSync(npm.file, [...npm.args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: npm.shell,
    // Bounded, like every other outbound call in this CLI. A registry that
    // accepts the connection and then says nothing — a stalled proxy, a
    // captive portal — would otherwise hang the command with no way out but
    // Ctrl-C, and this one runs BEFORE the user has been asked anything.
    timeout: NPM_VIEW_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const stderr = (res.stderr ?? "").trim();
  const version = (res.stdout ?? "").trim();
  if ((res.status ?? 1) !== 0 || version === "") {
    if (stderr !== "") return { ok: false, stderr };
    return {
      ok: false,
      stderr:
        res.error !== undefined
          ? describeSpawnFailure(npm.file, res.error)
          : "npm exited without reporting a version.",
    };
  }
  return { ok: true, version };
}

/** How long to wait for `npm view`. Matches the catalogue reads' budget. */
const NPM_VIEW_TIMEOUT_MS = 30_000;

/**
 * A spawn that never started still has to say something: there is no child
 * output at all, only an `error`. npm missing from PATH is the case that forces
 * it; a `timeout` kill is the other.
 *
 * Names the file actually spawned, which on Windows is node running npm's JS
 * rather than `npm.cmd`. Pointing a user at a binary this code no longer runs
 * sends them to check the wrong thing.
 */
function describeSpawnFailure(file: string, error: Error): string {
  return `Could not run ${file}: ${error.message}`;
}

/**
 * npm's diagnosis, minus its stack trace.
 *
 * A refused connection prints twenty-five lines, of which four say anything: a
 * code, the URL it tried, and the proxy hint. The rest are Node internals, and
 * they push the one line naming the offline alternative off the bottom of the
 * message that exists to offer it.
 *
 * Only frames and the error object's own dump are dropped — never a line that
 * could carry a reason. Trimming into silence would be worse than the noise: an
 * auth failure and an unreachable host look identical without npm's own words.
 */
export function condenseNpmError(stderr: string): string {
  const kept: string[] = [];
  for (const line of stderr.split("\n")) {
    const body = line.replace(/^npm (?:error|ERR!)\s?/, "");
    if (body.trim() === "") continue;
    if (/^\s*at\s/.test(body)) continue; // a stack frame
    // A field of the error object's dump: indented, `name: value`. The
    // indentation is what separates it from a real message that happens to
    // lead with a word and a colon (`FetchError: request to ... failed`),
    // which sits flush against the prefix and must survive.
    if (/^\s{2,}\S+:\s/.test(body)) continue;
    if (/^\s*[{}],?\s*$/.test(body)) continue; // the dump's own braces
    // npm masks what looks like a secret in the log path it prints (an id in a
    // directory name reads as one), so the path opens nothing. Where the log
    // lives is still worth saying; not un-masked — the mask is npm's call.
    if (/^A complete log of this run can be found in: .*\*\*\*/.test(body.trim())) {
      kept.push(`${line.slice(0, line.indexOf(body))}A complete log of this run is in npm's debug log directory ` +
        "(`_logs` under `npm config get cache`); npm masked part of the path it printed.");
      continue;
    }
    // The line that OPENS the dump is usually the last stack frame, already
    // dropped above. When it is not, it carries a reason worth keeping — so
    // take the line and leave the brace behind.
    kept.push(/\{\s*$/.test(body) ? line.replace(/\s*\{\s*$/, "") : line);
  }
  return kept.join("\n").trim();
}

/**
 * Whether two {@link condenseNpmError} reasons are the same registry failure.
 *
 * Compared with what is specific to ONE request taken out: the URL it fetched
 * (`…/@xano-sdk%2fauth` against `…/@tailwindcss%2fvite`), the package spec it
 * names (`'@xano-sdk/auth@*'`), and the debug log's timestamped path. Two installs
 * that met the same unreachable or misconfigured registry then read as one
 * failure, and the second says "the same npm error" instead of repeating it.
 */
export function sameNpmFailure(a: string, b: string): boolean {
  return a === b || npmFailureKey(a) === npmFailureKey(b);
}

function npmFailureKey(reason: string): string {
  return reason
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/'(?:@[^/'\s]+\/)?[^@'\s]+@[^'\s]*'/g, "'<package>'")
    .replace(/(?:[A-Za-z]:)?[\\/]\S*\.log\b/g, "<log>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d_:.-]+Z?/g, "<time>");
}
