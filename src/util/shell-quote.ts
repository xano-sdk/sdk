/**
 * Single-quote a value for copy-paste back into a shell, but only when it needs
 * it — a bare safe value keeps the common-case hint readable. Escapes embedded
 * single quotes the POSIX way.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
