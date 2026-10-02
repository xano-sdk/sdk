/**
 * Statements the engine WRITES but will not READ BACK.
 *
 * Distinct from {@link SUPERSEDED_STATEMENTS}, which are retired versions of a
 * versioned family: those still run exactly as stored, so a pulled workspace
 * carrying one can be pushed straight back. These cannot. The engine emits them
 * into an export and then refuses the same bytes on import, so a workspace
 * holding one is not deployable until the statement is replaced.
 *
 * The consequences, and why each half is handled where it is:
 *
 * - **Never authorable.** No `s.` surface, so they are absent from the
 *   agent-grounding manifest catalog (which is built from `STATEMENT_SURFACES`)
 *   and cannot be written by new code at all.
 * - **Always decodable.** They turn up in real pulled workspaces, so codegen
 *   carries them verbatim through `raw()` and reports the reason — dropping the
 *   bytes would silently rewrite someone's workspace.
 * - **Blocked at `export()`.** A bundle carrying one can only fail the import,
 *   after a destructive full-replace has begun. Xano's own CLI blocks a push on
 *   exactly this condition, so the rule is upstream's, not an inference from one
 *   reproduction.
 * - **Named in the legacy index** (`llms/legacy.md`), for the same reason
 *   everything else there is: an agent that has never heard of one will "fix"
 *   what it does not recognize.
 *
 * The value is the reason, written for whoever pulled the workspace and has to
 * decide what to do with it.
 */
export const DECODE_ONLY_STATEMENTS: ReadonlyMap<string, string> = new Map([
  [
    "mvp:placeholder",
    "an unconfigured statement slot the engine writes in place of a statement it " +
      "could not resolve, so an export stays well-formed. There is no statement " +
      "class behind it: importing a workspace that contains one fails outright " +
      'with "Missing statement: mvp:placeholder". Replace it with the statement it ' +
      "stands in for before deploying — there is no destination where it runs",
  ],
]);
