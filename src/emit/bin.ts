#!/usr/bin/env node
/**
 * Executable entry for the `xanosdk` bin.
 *
 * Deliberately tiny and separate from `cli.ts` (the library surface that exports
 * `run`/`parseArgs`/`loadDefault`): the CLI is driven by an *unconditional*
 * `run()` call, never by `import.meta.url` self-detection. Self-detection breaks
 * the moment the bundler code-splits the guard into a shared chunk — then
 * `import.meta.url` is the chunk, not the bin, the guard is always false, and the
 * CLI exits silently. An always-run bin can't regress that way.
 */
import { run, readVersion } from "./cli.js";
import { reportFailure, processExitCode } from "./errors.js";
import { maybeNotifyUpdate } from "./update-check.js";
import { installInterruptHandler } from "./interrupt.js";
import { installCliDiagnosticSink } from "./errors.js";
import { installStdoutPipeGuard } from "./output.js";
import { installCliPrefix } from "./invocation.js";
import { fileURLToPath } from "node:url";
import { installSentWriteTracking } from "../util/sent-writes.js";
import { installSecretRedaction } from "../util/secrets.js";

// Every token a credential reader registered prints as `<redacted>` — on
// stderr and in a `--json` document alike — whatever message quoted it.
installSecretRedaction(process.stdout);
installSecretRedaction(process.stderr);
// Ctrl-C is an ANSWER, not a crash: erase the in-flight spinner line, print
// `✗ Cancelled.`, exit 130. Installed before the run so it covers every command.
installInterruptHandler();
// Every write request on the wire is recorded until it is answered, so a
// signal mid-write reports the write as sent (exit 9), never "Cancelled.".
installSentWriteTracking();
// A workspace's build warnings print as every other CLI warning does (`! …`).
installCliDiagnosticSink();
// A reader that closed stdout early ends the output, not the command.
installStdoutPipeGuard();
// Printed commands spelled as the reader runs the CLI: `npx xanosdk …` unless
// it is installed globally.
installCliPrefix(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);

run(argv)
  // After a successful command, nudge if a newer @xano/sdk is on npm.
  // Best-effort and swallowed internally — it can never fail the run. A command
  // that resolved but set a non-zero `process.exitCode` is NOT successful, and
  // `maybeNotifyUpdate` checks that itself (see `runExitedClean`), so the banner
  // never lands under a failed run from either ending.
  .then(() => maybeNotifyUpdate())
  .catch((err) => {
    // Deliberately no update nudge here: an "a newer version is available"
    // banner under a failed command is noise at the exact moment the user is
    // trying to read what went wrong.
    reportFailure(err, readVersion(), argv);
    // A failure that names its own code keeps it (a verification that ran and
    // disagreed is not the same event as a bundle that could not be read); every
    // other failure is a plain 1.
    //
    // Exits once stdout has DRAINED: a write to a pipe can be asynchronous, and
    // a `--json` failure document cut off by an immediate exit is worse than
    // none. The empty write's callback runs after every write queued before it.
    const code = processExitCode(err);
    // Recorded first, so a signal arriving while stdout drains exits with it.
    process.exitCode = code;
    process.stdout.write("", () => process.exit(code));
  });
