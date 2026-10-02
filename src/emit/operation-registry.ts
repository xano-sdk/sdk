/**
 * Which consequential write is in flight, for the one reader that cannot wait
 * for a `catch`: the Ctrl-C handler.
 *
 * A SIGINT handler exits synchronously, so no `catch` in the command ever runs,
 * and a request already on the wire keeps going on the server without us. The
 * command registers what it is doing before its first write, and the interrupt
 * handler asks it for its result rather than printing "Cancelled." over a write
 * that may have landed.
 *
 * Imports nothing: the interrupt handler loads it on every CLI start, before any
 * command's own modules are chosen.
 */

/**
 * Exit code for a write whose outcome is not known.
 *
 * Distinct from 1 ("failed") because the correct next step is different: read
 * first, then decide. It covers Ctrl-C during a write too, so a wrapper learns
 * "resolve before retrying" rather than "was interrupted" — which is what it
 * actually needs to know. Registered in the allocation block beside
 * `EXIT_SOURCE_UNRESOLVABLE`.
 */
export const EXIT_OUTCOME_UNKNOWN = 9;

/** What a command hands over before its first write, for the interrupt handler to read. */
export interface OperationRegistrationInput {
  /** Whether this run's stdout is the machine-readable JSON (`isMachineOutput`). */
  machine: boolean;
  /**
   * The read-only command that settles an `unknown` — `xanosdk release list
   * --json`, say. Printed on stderr whenever the run ends in `unknown`.
   */
  resolveWith: string;
  /**
   * The write in the reader's words, for the interrupt line: `the release cut`,
   * `the landing`. Omitted reads as "the write".
   */
  what?: string;
  /**
   * The command's result as it stands. Called with `interrupted: true` from the
   * interrupt handler, which is the builder's cue to mark the step it was in as
   * `unknown`. Must be synchronous: the handler exits straight after.
   */
  snapshot: (ctx: { interrupted: boolean }) => unknown;
}

/** A live registration. */
export interface OperationRegistration extends OperationRegistrationInput {
  /** True once any write request has been handed to the network. */
  readonly writeSent: boolean;
  /** Record that a write request is about to go out. Call BEFORE sending it. */
  markWriteSent(): void;
  /** Drop the registration once the result is emitted. A stale handle is a no-op. */
  clear(): void;
}

let active: OperationRegistration | undefined;

/**
 * Register the command's in-progress operation for the rest of the run.
 *
 * One at a time: a second registration while one is live is a bug in the
 * caller, and replacing it silently would let Ctrl-C report the wrong write.
 */
export function registerOperation(input: OperationRegistrationInput): OperationRegistration {
  if (active !== undefined) {
    throw new Error("An operation is already registered for this run; clear it before registering another.");
  }
  let writeSent = false;
  const registration: OperationRegistration = {
    ...input,
    get writeSent() {
      return writeSent;
    },
    markWriteSent() {
      writeSent = true;
    },
    clear() {
      if (active === registration) active = undefined;
    },
  };
  active = registration;
  return registration;
}

/** The registration the run currently holds, if any. */
export function activeOperation(): OperationRegistration | undefined {
  return active;
}
