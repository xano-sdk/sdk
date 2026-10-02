/**
 * `xanosdk init --web [args...]` — the browser front door to `xanosdk init`.
 *
 * A LAUNCHER, not a second scaffolder. It runs `@xano-sdk/onboard`, a separate
 * published package that serves a local configurator, collects one answer, and
 * finishes by calling this SDK's own `init` with the flags that answer implies.
 * Everything it can produce, `xanosdk init` can produce from flags.
 *
 * Three properties are deliberate and each one is load-bearing:
 *
 *   • **No dependency.** `@xano-sdk/onboard` depends on `@xano/sdk`; an SDK that
 *     depended back would close the loop and hand this package's release cadence
 *     to the configurator. `npm exec` RUNS a package without depending on it, so
 *     the arrow stays one-way and a new configurator ships without an SDK
 *     release. A test pins the absence of the dependency, because the tempting
 *     "fix" is to turn this spawn into an import.
 *
 *   • **Raw argv, forwarded whole.** This module never parses what it forwards.
 *     `cli.ts` rejects flags it does not model, so modelling the configurator's
 *     flags here would freeze them: a flag added there would be refused here
 *     until the SDK released — the exact coupling the point above avoids. The
 *     tail is opaque on purpose.
 *
 *   • **`--help` goes to the child.** The configurator owns the list of things
 *     it accepts, so it owns the page that prints them. `xanosdk help init` is
 *     the offline description of `init` itself; `xanosdk init --web --help` is
 *     the configurator answering for itself. That this one needs the network
 *     is not a wart — the command needs the network for everything, and a help
 *     page that works offline for a command that does not would be a promise
 *     nothing else here keeps.
 *
 * Node-only (the npm spawn); lazily imported from `cli.ts` so the browser-safe
 * authoring bundle never pulls it in.
 */
import { condenseNpmError, npmViewVersion, runNpm } from "./npm.js";
import { detail, step } from "./ui.js";

/** The package this flag launches. Not a dependency — see the module header. */
export const CONFIGURATOR_PACKAGE = "@xano-sdk/onboard";

/**
 * Run the configurator, forwarding `tail` to it untouched.
 *
 * Sets `process.exitCode` from the child rather than throwing, so a
 * configurator that failed reports its own reason once instead of having a
 * second, vaguer one printed over the top of it.
 */
export function runInitWebCommand(tail: readonly string[]): void {
  // Preflight, for two reasons that happen to have one answer. A registry this
  // machine cannot reach must fail HERE, naming why, rather than as whatever
  // `npm exec` prints when it cannot resolve a spec — and the version it
  // resolves is worth saying out loud (see below).
  const resolved = npmViewVersion(CONFIGURATOR_PACKAGE);
  if (!resolved.ok) {
    // Headline stays neutral about the CAUSE. `npmViewVersion` distinguishes an
    // unreachable host from a private registry's 404 from a missing npm, and
    // announcing "could not reach the network" over the top of an E404 would
    // throw away the distinction it went to the trouble of preserving. npm's
    // own words, immediately below, are the diagnosis.
    throw new Error(
      `Could not resolve ${CONFIGURATOR_PACKAGE} from the npm registry.\n\n` +
        `${condenseNpmError(resolved.stderr)}\n\n` +
        `The configurator is downloaded on demand, so this step needs the registry. ` +
        `\`xanosdk init\` takes the same choices as flags instead — and \`--no-install\` ` +
        `skips the dependency install, which is the only other thing that reaches out.`,
    );
  }

  step(`Launching ${CONFIGURATOR_PACKAGE} ${resolved.version}`);
  // Said out loud because it is genuinely surprising: `npm exec` resolves the
  // configurator's OWN `@xano/sdk`, so the project about to be scaffolded may
  // be scaffolded by a different version of this package than the one the user
  // just invoked. A transcript that names the version can be reasoned about
  // later; one that does not, cannot.
  detail(`It brings its own @xano/sdk, which may differ from this one.`);

  // `-y` because the package name is one the user typed on purpose — an
  // install prompt here asks them to confirm the command they just ran. `--`
  // ends npm's own flags so the tail is unambiguously the child's, however it
  // is spelled.
  const status = runNpm(
    ["exec", "-y", `${CONFIGURATOR_PACKAGE}@latest`, "--", ...tail],
    process.cwd(),
  );
  // The child has already said whatever it had to say. Carrying its status is
  // the whole contract; adding a message would be talking over it.
  if (status !== 0) process.exitCode = status;
}
