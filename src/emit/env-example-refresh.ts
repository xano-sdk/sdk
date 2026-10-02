/**
 * Keeping an AUTHORED project's `xano/.env.example` in step with the names its
 * source declares.
 *
 * The template is generated — one commented `# NAME=` line per name
 * `workspaceConfig({ env })` declares — but only a pull rewrote it. A project
 * scaffolded with plain `init` and then authored kept "This backend declares no
 * env vars" after declaring five, so the one file that tells a teammate which
 * values to supply said there were none.
 *
 * Names only, never a value: the template is committed. And only a file this
 * SDK wrote — recognised by its first line — is touched; a hand-written
 * `.env.example` is the author's.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { renderWorkspaceEnvExample, WORKSPACE_ENV_EXAMPLE_BASENAME } from "./workspace-env.js";
import { envExampleNames } from "./codegen-command.js";

/** The first line every rendered template carries: `# <dir>/.env.example — the template for <dir>/.env.` */
const MANAGED_HEAD = /^# (.+)\/\.env\.example — the template for \1\/\.env\.$/;

/**
 * `current` — a template this SDK rendered — re-rendered to list `names`, under
 * the label it already carries, so the result is byte for byte what
 * {@link refreshEnvExample} would write for those names. `undefined` for a file
 * that is not the SDK's.
 */
export function rerenderEnvExample(current: string, names: readonly string[]): string | undefined {
  const label = MANAGED_HEAD.exec(current.split("\n", 1)[0] ?? "")?.[1];
  if (label === undefined) return undefined;
  return renderWorkspaceEnvExample(envExampleNames(Object.fromEntries(names.map((n) => [n, ""]))), label);
}

/**
 * Re-render `<backendDir>/.env.example` from `env` (the bundle's declared
 * names) when it is the SDK's own and says something different. Returns the
 * path it rewrote (or, with `write: false`, would rewrite), or undefined when
 * it is up to date or not the SDK's.
 */
export function refreshEnvExample(
  backendDir: string,
  env: Readonly<Record<string, string>>,
  opts: { write?: boolean } = {},
): string | undefined {
  const path = join(backendDir, WORKSPACE_ENV_EXAMPLE_BASENAME);
  if (!existsSync(path)) {
    // None at all, with names declared: written (names only), since it is the
    // file every guide says to fill `xano/.env` from and nothing else made one
    // (E2E pass 23). Not by `export --check`, which writes nothing and does not
    // demand a file an older project never had; and never a directory of its own.
    if (opts.write === false || Object.keys(env).length === 0 || !existsSync(backendDir)) return undefined;
    atomicWrite(path, renderWorkspaceEnvExample(envExampleNames(env), envExampleLabel(backendDir)));
    return path;
  }
  const current = readFileSync(path, "utf8");
  // The label the file already uses (`xano`, `backend`, …), so an unchanged
  // name list re-renders byte-identical.
  const label = MANAGED_HEAD.exec(current.split("\n", 1)[0] ?? "")?.[1];
  if (label === undefined) return undefined;
  const next = renderWorkspaceEnvExample(envExampleNames(env), label);
  if (next === current) return undefined;
  // `write: false` is `export --check`'s question — would it change? — asked
  // without the answer landing on disk.
  if (opts.write !== false) atomicWrite(path, next);
  return path;
}

/** How a new template names its directory: relative to the working directory (`xano`), as `init` and `pull` label it. */
function envExampleLabel(backendDir: string): string {
  const rel = relative(process.cwd(), resolve(backendDir));
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? basename(resolve(backendDir)) : rel.split(sep).join("/");
}

/** The declared names a bundle carries: the lifted top-level `env`, else the workspace's own. */
export function bundleEnvNames(bundle: { payload?: Record<string, unknown> }): Record<string, string> {
  const payload = bundle.payload ?? {};
  const lifted = payload.env;
  const own = (payload.workspace as { env?: unknown } | undefined)?.env;
  const list = Array.isArray(lifted) && lifted.length > 0 ? lifted : Array.isArray(own) ? own : [];
  const out: Record<string, string> = {};
  for (const entry of list as Array<{ name?: unknown; value?: unknown }>) {
    if (typeof entry?.name === "string") out[entry.name] = typeof entry.value === "string" ? entry.value : "";
  }
  return out;
}
