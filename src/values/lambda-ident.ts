/**
 * JavaScript identifiers as the lambda guards read them.
 *
 * An identifier is any `ID_Start` character (or `$`, `_`) followed by
 * `ID_Continue` characters (or `$`, ZWNJ, ZWJ) — `café`, `größe` and `π` as much
 * as `total`. Each of those characters may also be written as a `\uXXXX` or
 * `\u{…}` escape, and a `.ts` loader writes them that way: `Function#toString`
 * on a transpiled `(café) => café` returns `(caf\u00E9) => caf\u00E9`. Both
 * spellings name ONE binding, so the guards analyse the decoded text
 * ({@link decodeIdentifierEscapes}) while the body is emitted as written.
 */
import { maskNonCode } from "./lambda-source.js";

/** Regex source (for the `u` flag) of one decoded identifier. */
export const IDENT = String.raw`[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*`;

/** Regex source (for the `u` flag) of one character that continues an identifier. */
export const ID_CHAR = String.raw`[\p{ID_Continue}$\u200C\u200D]`;

const ESCAPE = /\\u(?:([0-9A-Fa-f]{4})|\{([0-9A-Fa-f]{1,6})\})/g;
const IDENT_NAME = new RegExp(`^${IDENT}$`, "u");

/** `name` with its identifier escapes decoded: `caf\u00E9` → `café`. */
export function decodeIdentifier(name: string): string {
  return name.replace(ESCAPE, (whole, four: string | undefined, braced: string | undefined) => {
    const code = parseInt(four ?? braced ?? "", 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Whether `prop` is a shorthand property a loader re-spelled as a quoted key
 * bound to the same name — `"\u{1D465}": 𝑥` for `{ 𝑥 }`. Only `\u` escapes
 * are decoded in the key; any other escape is not a spelling of a name.
 */
export function isQuotedShorthand(prop: string): boolean {
  const m = /^\s*(["'])([^"'\\]*(?:\\u[^"'\\]*)*)\1\s*:\s*([^\s:=]+)\s*$/su.exec(prop);
  if (m === null || !isIdentifierName(m[3]!)) return false;
  return decodeIdentifier(m[2]!) === decodeIdentifier(m[3]!);
}

/** Whether `name` (escapes allowed) is a valid identifier name. */
export function isIdentifierName(name: string): boolean {
  return IDENT_NAME.test(decodeIdentifier(name));
}

/**
 * `src` with every identifier escape in CODE decoded — strings, comments,
 * regex and template text keep theirs, where `"` is a quote rather than a
 * name. Outside those, a `\u` can only be part of an identifier.
 */
export function decodeIdentifierEscapes(src: string): string {
  if (!src.includes("\\u")) return src;
  const mask = maskNonCode(src);
  let out = "";
  let last = 0;
  for (const m of mask.matchAll(ESCAPE)) {
    out += src.slice(last, m.index) + decodeIdentifier(m[0]);
    last = m.index + m[0].length;
  }
  return out + src.slice(last);
}
