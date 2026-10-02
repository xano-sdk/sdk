/**
 * What shape an environment-variable NAME has to have to survive `xano/.env`.
 *
 * Its own module because the build-time guards need `safeNames` and must stay
 * free of `node:fs` — they run on the browser-safe authoring path, where the
 * module that owns `xano/.env` cannot be imported. A second spelling of this
 * regex is a second definition of what a name is, and the failure it produces is
 * silent — a name one side writes and the other refuses to read back.
 */

/**
 * Can this NAME survive a round trip through the dotenv format?
 *
 * Names come from a remote backend or are derived from one, and nothing upstream
 * constrains their shape. Written unguarded, `MULTI\nB=injected` injects a second
 * KEY=VALUE line into `xano/.env`; `#FOO` re-reads as a comment and silently
 * loses its value; ` FOO` re-reads trimmed, so it can never be supplied or
 * excused; and `A=B` re-reads as `A` holding `B=value`. The worst of these does
 * not merely lose a value — it writes a file the parser then REFUSES, so every
 * later compile hard-fails on the default file.
 *
 * The shape is the one `namesInEnvExample` already parses back, so the writer
 * and the reader agree on what a name is.
 */
export function isRepresentableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Names, rendered for a terminal.
 *
 * Env and object names come from a remote backend and nothing upstream
 * constrains their shape. A name carrying `\r`, a newline or an ANSI escape can
 * forge or scroll away the line it appears in — which matters most where that
 * line is a decision the user is about to make, such as which doc site is about
 * to be published. Shared so every surface that prints a remote name
 * neutralizes it the same way.
 *
 * Lives beside {@link isRepresentableName} rather than with the `xano/.env`
 * reader, because the build-time guards need it too and must stay free of
 * `node:fs` — they run on the browser-safe authoring path.
 */
export function safeNames(names: readonly string[]): string {
  // eslint-disable-next-line no-control-regex
  return names.map((n) => n.replace(/[\u0000-\u001F\u007F]/g, "?")).join(", ");
}
