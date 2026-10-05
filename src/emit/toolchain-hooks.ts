/**
 * Firing toolchain plugins' hooks, and turning what they report into output
 * and exit codes.
 *
 * Discovery lives in `toolchain-modules.ts`; this file is only the dispatch.
 * They are separate because they happen at different points in a command —
 * discovery runs before the user's entry loads, dispatch runs after the bundle
 * compiles.
 *
 * ── The two failure modes, kept apart ───────────────────────────────────────
 *
 * A hook that THROWS is a broken plugin. On a normal run that is a warning and
 * the command continues, matching `refreshAgentGuidance`: a module's bug is not
 * a reason to fail a deploy the user asked for. Under `--frozen-lock` it is
 * fatal, for the same reason a load failure is — a check that did not run must
 * not read as a check that passed.
 *
 * A hook that RETURNS `failed: true` is a working plugin reporting that what it
 * checked does not pass. That is never swallowed. It is the finding the hook
 * exists to produce, and it reaches the command's exit code on every run.
 *
 * Node-only; reached from the commands, which the CLI imports lazily.
 */

import type {
  BundleContext,
  BundlePayload,
  HookResult,
  PreflightContext,
  RoutesManifestContext,
  ToolchainPlugin,
} from "../plugin.js";
import type { LoadedPlugin } from "./toolchain-modules.js";
import { checkModuleSection, type ModuleSection } from "./routes-manifest-modules.js";
import { byCodeUnit } from "../util/code-unit.js";
import { UsageError } from "./errors.js";
import { detail, info, warn } from "./ui.js";

/**
 * The payload with workspace env VALUES blanked, names intact.
 *
 * `buildBundle` lifts merged deploy-time env vars to `payload.env` as
 * `{ name, value }`, and the values are the real ones read from `xano/.env` —
 * the file the scaffold gitignores precisely because it holds secrets. The SDK
 * is careful with them everywhere else; `reportWorkspaceEnv` will not even
 * print them.
 *
 * A hook is a different matter from every other consumer of that payload,
 * because a hook is THIRD-PARTY code whose documented job is writing a tree the
 * user COMMITS. A plugin that renders the payload faithfully — the obvious
 * implementation of "render the workspace" — would put production credentials
 * into git, and nothing in the contract would have warned its author. Blanking
 * here rather than trusting each plugin is the only version of this that is
 * safe by default.
 *
 * Names survive because they are structure: a workspace DECLARES which env vars
 * it needs, and a rendering that omitted the declarations would be wrong. Only
 * the values go.
 */
export function redactEnvValues(payload: BundlePayload): BundlePayload {
  const env = payload["env"];
  if (!Array.isArray(env)) return payload;
  return {
    ...payload,
    env: env.map((entry) =>
      typeof entry === "object" && entry !== null && "value" in entry
        ? { ...(entry as Record<string, unknown>), value: "" }
        : entry,
    ),
  };
}

/** What a batch of hooks reported, collapsed to what the command needs. */
export interface HookOutcome {
  /** At least one plugin reported that its check does not pass. */
  readonly failed: boolean;
}

/** Print one hook's message and warnings under the plugin's name. */
function report(pkg: string, result: HookResult): void {
  if (result.message !== undefined && result.message !== "") {
    if (result.failed === true) warn(`${pkg} — ${result.message}`, "toolchain.failed");
    else info(result.message);
  }
  for (const line of result.warnings ?? []) detail(line);
}

/**
 * Handle a hook that threw: a warning normally, fatal when frozen.
 *
 * The frozen message names the plugin AND says what went unchecked, because
 * "the plugin failed" alone leaves the reader to work out why that should stop
 * a build.
 */
function handleThrow(pkg: string, error: unknown, frozen: boolean): void {
  const why = error instanceof Error ? error.message : String(error);
  if (frozen) {
    throw new UsageError(
      `${pkg} failed while checking this bundle, so whatever it verifies was not verified — ` +
        `and this run was asked to verify, not to write:\n  ${why}`,
    );
  }
  warn(`${pkg} failed and was skipped.`, "toolchain.failed", [why]);
}

/**
 * Fire `onBundle` across every loaded plugin.
 *
 * Called on `export` and `deploy` AFTER the bundle compiles and BEFORE the
 * network call. Not from inside `compileBundle`: that function also backs
 * `preflight`, which is a read-only check, and firing there would write a tree
 * during it.
 *
 * Plugins run in sequence rather than concurrently. They write to the user's
 * tree and to the terminal, and interleaved output from two modules writing
 * adjacent directories is harder to read than it is slow.
 */
export async function fireOnBundle(
  plugins: readonly LoadedPlugin[],
  ctx: Omit<BundleContext, "config">,
): Promise<HookOutcome> {
  let failed = false;
  const bundle = { ...ctx.bundle, payload: redactEnvValues(ctx.bundle.payload) };
  for (const { pkg, plugin, config } of plugins) {
    if (plugin.onBundle === undefined) continue;
    try {
      const result = await plugin.onBundle({ ...ctx, bundle, config });
      report(pkg, result);
      if (result.failed === true) failed = true;
    } catch (error) {
      handleThrow(pkg, error, ctx.frozen);
    }
  }
  return { failed };
}

/**
 * Fire `onPreflight` across every loaded plugin.
 *
 * A thrown hook is always non-fatal here — `preflight` is itself a check, and
 * its own report is worth printing even when a plugin could not contribute to
 * it. A returned `failed` maps onto the same non-zero exit the command's own
 * findings use, which is what lets CI keep gating on it.
 */
export async function fireOnPreflight(
  plugins: readonly LoadedPlugin[],
  ctx: Omit<PreflightContext, "config">,
): Promise<HookOutcome> {
  let failed = false;
  const payloads = {
    exportedPayload: redactEnvValues(ctx.exportedPayload),
    remappedPayload: redactEnvValues(ctx.remappedPayload),
  };
  for (const { pkg, plugin, config } of plugins) {
    if (plugin.onPreflight === undefined) continue;
    try {
      const result = await plugin.onPreflight({ ...ctx, ...payloads, config });
      report(pkg, result);
      if (result.failed === true) failed = true;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      warn(`${pkg} could not complete its check.`, "toolchain.failed", [why]);
      // A check that could not run is not a check that passed. `preflight`
      // exists to gate, so an unavailable contribution fails the gate rather
      // than quietly shrinking what was verified.
      failed = true;
    }
  }
  return { failed };
}

/**
 * The whole `onBundle` fire site: skip when there is nothing to fire, hand over
 * the payload, and turn a reported failure into the command's refusal.
 *
 * `export` and `deploy` had this block verbatim apart from one clause of the
 * error message, which is exactly the shape that drifts — they had already
 * disagreed once about whether to guard on an empty plugin list. The message
 * stays per-command because the consequence differs: an export has written
 * nothing yet, a deploy has not shipped.
 */
export async function runBundleHooks(
  plugins: readonly LoadedPlugin[],
  ctx: Omit<BundleContext, "config">,
  consequence: string,
): Promise<void> {
  if (plugins.length === 0) return;
  const outcome = await fireOnBundle(plugins, ctx);
  if (outcome.failed) {
    throw new UsageError(
      `A toolchain module reported that its check did not pass${consequence}. See the report above.`,
    );
  }
}

/**
 * One module's answer to `routesManifest`: its section, or why there is none.
 *
 * A failure is a VALUE, not a throw, and never a partial file: the writer
 * decides what it means (KTD7). On a normal write the core sections are still
 * refreshed and the module's previous block is carried forward
 * (`parseModuleSections`); on a verifying one it is fatal.
 */
export type RoutesManifestResult =
  | ({ readonly kind: "section" } & ModuleSection)
  | { readonly kind: "failed"; readonly pkg: string; readonly version: string; readonly why: string };

/**
 * Call every loaded plugin's `routesManifest`, in package-name order (the
 * order the blocks land in the file), skipping plugins without one.
 *
 * Synchronous, and prints nothing: the decode paths place the manifest
 * synchronously, and what a failure prints depends on the writer. A hook that
 * throws, returns a promise, or returns a section the composer would refuse
 * (an `@xano/sdk` or relative import, say) is that module's `failed` result,
 * so one broken module never costs the others their sections. A returned
 * section comes back normalized: imports merged per package and sorted.
 */
export function fireRoutesManifest(
  plugins: readonly LoadedPlugin[],
  ctx: Omit<RoutesManifestContext, "config">,
): RoutesManifestResult[] {
  const results: RoutesManifestResult[] = [];
  for (const { pkg, version, plugin, config } of [...plugins].sort((a, b) => byCodeUnit(a.pkg, b.pkg))) {
    if (plugin.routesManifest === undefined) continue;
    try {
      const section = plugin.routesManifest({ ...ctx, config });
      // A promise is refused just below, and nothing ever awaits it. Observed
      // here so its later rejection is not an unhandled one — which would crash
      // the process under Node's default, long after this module's failure was
      // reported as a value.
      if (typeof (section as { then?: unknown } | null)?.then === "function") {
        Promise.resolve(section).catch(() => {});
      }
      const imports = checkModuleSection(pkg, section);
      results.push({
        kind: "section",
        pkg,
        version,
        section: { ...(imports.length > 0 ? { imports } : {}), source: section.source },
      });
    } catch (error) {
      results.push({ kind: "failed", pkg, version, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** Whether any loaded plugin declares the hook, so the SDK can skip its setup. */
export function anyDeclares(
  plugins: readonly LoadedPlugin[],
  hook: keyof Pick<ToolchainPlugin, "onBundle" | "onPreflight" | "routesManifest">,
): boolean {
  return plugins.some((p) => p.plugin[hook] !== undefined);
}
