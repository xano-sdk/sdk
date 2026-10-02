/**
 * The one reading of a `XANO_*` / `XANOSDK_*` environment variable.
 *
 * Blank — empty OR only whitespace — is UNSET. `XANO_CONFIG=` is how a shell
 * clears a variable, and a CI secret that resolved to nothing arrives as `""`;
 * read raw, the first names the cwd as a credential file and the second names
 * `<cwd>/ `. Every read of a variable this CLI owns goes through here, so no
 * two commands disagree on whether the same setting is set.
 *
 * Returns the value UNTRIMMED: a value's own spacing is the caller's to judge.
 */
export function readEnvVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/** Whether a switch-style variable (`XANO_NO_BROWSER=1`) is on: set and not blank. */
export function envFlagSet(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvVar(name, env) !== undefined;
}
