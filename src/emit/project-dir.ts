/**
 * The one place that knows what makes a directory a Xano SDK project npm can
 * install into.
 *
 * Two commands spawn npm against the user's own tree — `marketplace install`
 * adds an add-on, `upgrade` replaces the SDK — and both have to answer the same
 * question first: is there a readable, parseable `package.json` here? Getting
 * that wrong produces an npm stack trace instead of a sentence, and the two
 * failures it distinguishes are genuinely different next steps: a MISSING
 * manifest is a directory to go find, a CORRUPT one is a file to go fix.
 *
 * Shared for the same reason `npm.ts` is: this is exactly the kind of check that
 * gets improved in one caller and not the other. What stays per-caller is only
 * the part that is genuinely per-caller — what the command was trying to do, and
 * what the reader should do instead.
 *
 * Node-only (`node:fs`); reached only from the lazily-imported command modules,
 * so the browser-safe authoring bundle never pulls it in.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectDirContext {
  /** What the command does here, as the message's clause: "`xanosdk upgrade` installs into a Xano SDK project". */
  readonly what: string;
  /** The indented second line: what the reader should do about it. */
  readonly remedy: string;
}

/**
 * Throw unless `dir` holds a `package.json` that parses.
 *
 * The check is deliberately loose: a readable `package.json`, nothing more. It
 * exists to catch the wrong-directory mistake, not to police project shape.
 * Requiring `xano/` would reject a workspace layout where the backend is a
 * sibling; requiring an `@xano/sdk` dependency would reject a project that
 * has not installed yet. Both would refuse installs that are perfectly fine.
 */
export function assertProjectDir(dir: string, ctx: ProjectDirContext): void {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) {
    throw new Error(`No package.json in ${dir} — ${ctx.what}.\n  ${ctx.remedy}`);
  }
  try {
    JSON.parse(readFileSync(manifest, "utf8"));
  } catch (err) {
    throw new Error(
      `${manifest} is not valid JSON, so npm cannot install into it — ` +
        `fix it and re-run. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
