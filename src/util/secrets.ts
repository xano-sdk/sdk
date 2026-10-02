/**
 * Secret values this process has read, and the one place they are scrubbed
 * from what it prints.
 *
 * Every credential reader registers the token it read here BEFORE it validates
 * or uses it, so a message that ends up quoting one — a transport library's
 * error text, a server's echo, a value folded into a `--json` document — prints
 * `<redacted>` instead. The CLI's stdout and stderr pass through
 * {@link installSecretRedaction}; the set is process-wide on purpose, because a
 * secret read by one step must stay hidden in every later line.
 *
 * Redaction covers what the CLI SAYS, never the data a command was asked to
 * write: an export or artifact streamed to stdout goes through
 * {@link writeData}, which passes it byte for byte. A backend env var can hold
 * the very token the CLI read, and rewriting it would corrupt the payload.
 *
 * Its own module, importing nothing, so any reader can register without a cycle.
 */

const secrets = new Set<string>();

/** What every registered secret prints as. */
export const REDACTED = "<redacted>";

/**
 * A secret shorter than this is not registered: it would match ordinary words
 * in unrelated output, and nothing that short is a bearer credential.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Remember `value` as a secret. Its trimmed form, its JSON-escaped form (how it
 * appears inside a `--json` string) and each of its lines are registered too, so
 * a message that quotes a fragment — one line of a token pasted twice — is still
 * scrubbed. Blank or short values are ignored.
 */
export function registerSecret(value: unknown): void {
  if (typeof value !== "string") return;
  const forms = new Set<string>([value, value.trim()]);
  let piece = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || /\s/.test(ch)) {
      forms.add(piece);
      piece = "";
    } else piece += ch;
  }
  forms.add(piece);
  for (const form of [...forms]) forms.add(JSON.stringify(form).slice(1, -1));
  for (const form of forms) {
    if (form.length >= MIN_SECRET_LENGTH) secrets.add(form);
  }
}

/** `text` with every registered secret replaced by {@link REDACTED}, longest first. */
export function redactSecrets(text: string): string {
  if (secrets.size === 0) return text;
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Forget every registered secret — for tests, which share one process. */
export function clearSecrets(): void {
  secrets.clear();
}

type Writable = Pick<NodeJS.WriteStream, "write">;

/** Streams whose current write is command data, passed through unredacted. */
const dataWrites = new WeakSet<object>();

/**
 * Write a command's DATA — an export, a bundle, a compiled artifact — to
 * `stream` exactly as given, bypassing {@link installSecretRedaction}. Any
 * other wrapper on the stream still sees the write.
 */
export function writeData(stream: Writable, data: string | Uint8Array): boolean {
  dataWrites.add(stream);
  try {
    return stream.write(data);
  } finally {
    dataWrites.delete(stream);
  }
}

/**
 * Route every write to `stream` through {@link redactSecrets}. A string chunk
 * is scrubbed as text; a byte chunk only when it holds a registered secret's
 * bytes, so binary output is passed through untouched otherwise.
 */
export function installSecretRedaction(stream: Writable): void {
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (secrets.size > 0 && !dataWrites.has(stream)) {
      if (typeof chunk === "string") chunk = redactSecrets(chunk);
      else if (chunk instanceof Uint8Array) chunk = redactBytes(chunk);
    }
    return original(chunk, ...rest);
  }) as Writable["write"];
}

function redactBytes(chunk: Uint8Array): Uint8Array {
  const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (const secret of secrets) {
    if (buf.includes(secret)) return Buffer.from(redactSecrets(buf.toString("utf8")), "utf8");
  }
  return chunk;
}

/**
 * Why `token` cannot be sent as a bearer credential, or `undefined` when it can.
 * Only visible ASCII is valid inside a bearer token, so a line break, a tab or
 * space, a control character or anything outside ASCII is named by kind and
 * position — never by quoting it. Leading and trailing whitespace is the
 * caller's to trim first.
 */
export function tokenTextProblem(token: string): string | undefined {
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (code >= 0x21 && code <= 0x7e) continue;
    const kind =
      code === 0x0a || code === 0x0d
        ? "a line break"
        : code === 0x20 || code === 0x09
          ? "whitespace"
          : code < 0x20 || code === 0x7f
            ? "a control character"
            : "a non-ASCII character";
    return `contains ${kind} at character ${i + 1} of ${token.length}`;
  }
  return undefined;
}
