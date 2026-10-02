/**
 * Whether the engine's email check accepts `value`: it trims ASCII whitespace,
 * and an empty value is no address (it passes). Otherwise the address must match the check
 * the engine applies (verified against it case by case) — counted in UTF-8
 * bytes, so a non-ASCII character never passes: at most 320 bytes, a local part
 * of at most 64 (dot-atoms or quoted strings), and a domain of dot-separated
 * labels of at most 63 characters with at least one dot and a final label that
 * does not start with a digit — or a bracketed IPv4/IPv6 literal.
 */
export function emailAddress(value: string): boolean {
  let start = 0;
  let end = value.length;
  while (start < end && TRIMMED.includes(value[start]!)) start++;
  while (end > start && TRIMMED.includes(value[end - 1]!)) end--;
  const text = value.slice(start, end);
  if (text === "") return true;
  const bytes = String.fromCharCode(...new TextEncoder().encode(text));
  return bytes.length <= 320 && EMAIL_ADDRESS.test(bytes);
}

/** The characters the engine trims from an address before checking it. */
const TRIMMED = " \t\n\r\0\v";

const EMAIL_ADDRESS = (() => {
  const atom = "[\\x21\\x23-\\x27\\x2A\\x2B\\x2D\\x2F-\\x39\\x3D\\x3F\\x5E-\\x7E]+";
  const quoted = "\\x22(?:[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x21\\x23-\\x5B\\x5D-\\x7F]|\\x5C[\\x00-\\x7F])*\\x22";
  const word = `(?:${atom}|${quoted})`;
  const char = "(?:\\x22?\\x5C[\\x00-\\x7E]\\x22?|\\x22?[^\\x5C\\x22]\\x22?)";
  const octet = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
  const ipv4 = `${octet}(?:\\.${octet}){3}`;
  const h = "[a-f0-9]{1,4}";
  const domain = "(?!.*[^.]{64,})(?:(?:xn--)?[a-z0-9]+(?:-+[a-z0-9]+)*\\.){1,126}(?:[a-z][a-z0-9]*|xn--[a-z0-9]+)(?:-+[a-z0-9]+)*";
  const v6 = `IPv6:(?:${h}(?::${h}){7}|(?!(?:.*[a-f0-9][:\\]]){7,})(?:${h}(?::${h}){0,5})?::(?:${h}(?::${h}){0,5})?)`;
  const v6v4 = `(?:IPv6:(?:${h}(?::${h}){5}:|(?!(?:.*[a-f0-9]:){5,})(?:${h}(?::${h}){0,3})?::(?:${h}(?::${h}){0,3}:)?))?${ipv4}`;
  return new RegExp(`^(?!${char}{255,})(?!${char}{65,}@)${word}(?:\\.${word})*@(?:${domain}|\\[(?:${v6}|${v6v4})\\])$`, "i");
})();
