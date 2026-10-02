/**
 * Whether a failed read failed because the path does not exist — the case a
 * `seedFile(...)`, `knowledgeFile(...)` or `lam.file(...)` reports as a missing
 * local file (a usage failure, exit 1) rather than as an unreadable one.
 */
export function isMissingFile(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
