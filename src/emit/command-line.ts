/**
 * Commands the CLI prints for the reader to run next — the read that settles an
 * unknown outcome, the delete that removes what a refused write left behind.
 *
 * A printed command has to act on the SAME workspace the run did. A run that
 * picked its credential with `--profile` or `--config` and printed a bare
 * `xanosdk release delete v2` would send the reader to the default profile's
 * workspace: the resolver finds nothing and invites a duplicate, and the
 * removal deletes someone else's release of that name. So every such command
 * carries the flags the run was given. A profile or file chosen through the
 * environment needs none: the reader's shell still has it.
 */

/**
 * A word safe to paste into a shell, quoted when it is not. A word holding a
 * control character — a newline in a server-stored name — is ANSI-C quoted
 * (`$'a\nb'`), so the printed command stays on one line and runs as printed.
 */
export function shellWord(word: string): string {
  if (/^[A-Za-z0-9._:@/=+-]+$/.test(word)) return word;
  if (CONTROL.test(word)) return `$'${word.replace(/[\\']/g, "\\$&").replace(CONTROLS, ansiEscape)}'`;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const CONTROLS = new RegExp(CONTROL.source, "g");
const ANSI_NAMED: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function ansiEscape(c: string): string {
  // As its UTF-8 bytes: a C1 control is two of them, and `\u` is not read by every bash.
  return ANSI_NAMED[c] ?? [...Buffer.from(c, "utf8")].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
}

/** ` --profile <p>` and ` --config <path>`, as the run was given them; empty when neither was. */
export function credentialFlags(args: { profile?: string | undefined; authFile?: string | undefined }): string {
  return (
    (args.profile === undefined ? "" : ` --profile ${shellWord(args.profile)}`) +
    (args.authFile === undefined ? "" : ` --config ${shellWord(args.authFile)}`)
  );
}
