/**
 * Turning a toolchain module's answers into what it contributes to the project
 * — and refusing, by name, a module whose shape says it was built against a
 * contract that no longer exists.
 *
 * ── Why this is not inside `init-command.ts` ────────────────────────────────
 *
 * The guards cannot live beside the scaffold, because `init` is not the only
 * caller of `contributes()`. A module is configured whenever its project is
 * RECONCILED — `marketplace install`, `marketplace reinstall`, and the
 * reporting pass `deploy`/`export` make — and a refusal that only one of four
 * hosts performs is not a refusal, it is a coin flip. Every host resolves
 * contributions through this file, so a module that would be refused during
 * `init` is refused during an install too.
 *
 * ── Contract skew is refused, never absorbed ────────────────────────────────
 *
 * Every hook on {@link ToolchainPlugin} is optional, which means a module
 * written against an older shape LOADS, REGISTERS, and CONTRIBUTES NOTHING —
 * silently, because "a module with no contributions" is a legitimate outcome.
 * That is the exact silent failure this whole area exists to remove, so every
 * known skew is detected structurally and named:
 *
 * - `files` and no `contributes` — the hook was renamed once it stopped running
 *   only at scaffold time.
 * - a `ciSteps` entry in what `contributes` returns — the slot is deleted. A
 *   module's own check rides on `xanosdk export --frozen-lock` through
 *   `onBundle`, so it never needed a workflow step of its own. Silently
 *   dropping a contributed CI step would be a guard that stops running, which
 *   is worse than one that fails.
 * - a `contributes` that returns something other than an object — a string, an
 *   array, or the Promise an `async contributes` returns. Indistinguishable
 *   from "contributed nothing", which is RECORDED AS SWITCHED OFF, so a wrong
 *   return type would turn a working module off and keep it off.
 *
 * The same posture runs over what a well-shaped return CONTAINS, in
 * {@link assertUsableContributions}: this writer may never author a `"xanosdk"`
 * block or a `.gitattributes` file that its own reader refuses.
 *
 * ── What a throwing module costs ────────────────────────────────────────────
 *
 * A module that cannot describe its contributions loses its contributions, not
 * the command. `contributes` is ordinary third-party code running after an
 * install has already written to the target directory; letting it take the run
 * down would leave a half-populated project that every re-run then refuses.
 * A refusal (a `UsageError`) is the author's bug and does propagate — that one
 * is deterministic, so re-running cannot fix it and carrying on would ship a
 * project that does not do what the module says it does.
 *
 * Node-only.
 */

import { withArticle } from "../util/article.js";
import type {
  PluginAnswers,
  ProjectContributions,
  ToolchainPlugin,
} from "../plugin.js";
import { UsageError } from "./errors.js";
import { gitattributesSpec } from "./managed-blocks.js";
import {
  assertNoFlagCollisions,
  flagFor,
  hostHelpTarget,
  hostLabel,
  questionSets,
  resolvePluginAnswers,
  type AnswerSource,
  type QuestionnaireHost,
  type QuestionPrompter,
} from "./plugin-questions.js";
import type { LoadedPlugin } from "./toolchain-modules.js";
import { warn } from "./ui.js";

/** One module's contributions, stamped with the version that produced them. */
export interface ResolvedContribution {
  readonly pkg: string;
  /** The module's own version, for stamping the block its lines land in. */
  readonly version: string;
  readonly parts: ProjectContributions;
}

/**
 * Refuse a plugin built against the previous contract, before its hooks run.
 *
 * Checked on the OBJECT rather than trusted from the types: a published module
 * compiled against an older `@xano/sdk` satisfies no current type at runtime,
 * and the whole point is that TypeScript was never going to catch this one.
 */
export function assertContractShape(
  pkg: string,
  plugin: ToolchainPlugin,
  host: QuestionnaireHost,
): void {
  const shape = plugin as unknown as Record<string, unknown>;
  if (
    typeof shape["files"] === "function" &&
    shape["contributes"] === undefined
  ) {
    throw new UsageError(
      `${pkg} declares a \`files\` hook and no \`contributes\`, so it was built against a ` +
        `\`@xano/sdk/plugin\` contract that no longer exists — \`${hostLabel(host)}\` would ` +
        `register it and apply nothing.`,
      {
        helpFor: hostHelpTarget(host),
        suggestion:
          `That is the module's upgrade to make: rename \`files(answers)\` to ` +
          `\`contributes(answers)\`, which returns a \`ProjectContributions\`. Until it ships, ` +
          `remove ${pkg} or set \`"${pkg}": { "enabled": false }\` in this project's ` +
          `package.json "xanosdk" block.`,
      },
    );
  }
}

/**
 * Refuse a contribution that would override what it is meant to extend.
 *
 * `plugin.ts` promises the slots are additive — that two modules cannot clobber
 * each other, and that a malformed contribution fails where it was written
 * rather than in the user's first CI run. Concatenation alone delivers neither.
 *
 * `.gitattributes` is LAST-MATCH-WINS, so an appended line is not additive at
 * all against a pattern the template already set: `* -text` or `*.gen eol=crlf`
 * silently defeats the `* text=auto eol=lf` rule that exists so a byte
 * comparison cannot fail over a contributor's `core.autocrlf`.
 *
 * The `*` refusal is load-bearing beyond `init`: that rule applies to every
 * path in the repository, and a module that could set it from an add-on
 * install could renormalize line endings repo-wide on the next checkout.
 *
 * ── Per PHYSICAL LINE, because that is how the lines are spliced ────────────
 *
 * A contributed entry is an array element, but `composeBlock` splits every
 * element on newlines before writing it, so checking the ELEMENT checks
 * something the file never sees. `["docs/*.md linguist-documentation\n* binary"]`
 * has `docs/*.md` as its first token, passes every rule below, and then lands
 * `* binary` — which implies `-text` — on every path in the repository. Each
 * entry is therefore split the way the composer splits it, and each physical
 * line is checked on its own.
 *
 * The marker refusal is the other half of that. A line spelling a BEGIN or END
 * marker is spliced verbatim into a file whose blocks are located by COUNTING
 * markers, so one forged line makes a block nothing can balance — and, when it
 * names ANOTHER package, makes that package's block unreconcilable too. Nothing
 * repairs it from the CLI, because every verb that could is the thing that
 * throws. The prefixes come from the dialect, never retyped: a copy here stops
 * matching the day the grammar moves.
 *
 * ── `config` has to survive the round trip its own reader makes ─────────────
 *
 * A `config` that is not a plain object is refused for the same reason, only
 * sharper: the reconciler WRITES it into the `"xanosdk"` block, and the writable-
 * block reader refuses any entry that is not an object — so one run authors a
 * manifest that every later reconcile, and all three marketplace verbs, then
 * refuse to read. The writer must never be able to produce a block its own
 * reader rejects.
 *
 * Refused, not skipped: each of these is the module author's bug, and silently
 * dropping one leaves the user with a project that does not do what the module
 * says it does.
 */
export function assertUsableContributions(
  pkg: string,
  parts: ProjectContributions,
  host: QuestionnaireHost,
): void {
  // The deleted slot. Present only on a module built against the old contract,
  // where it would otherwise vanish without a word.
  if ((parts as unknown as Record<string, unknown>)["ciSteps"] !== undefined) {
    throw new UsageError(
      `${pkg} contributes \`ciSteps\`, a slot \`@xano/sdk\` no longer has, so ` +
        `\`${hostLabel(host)}\` would drop its CI step in silence.`,
      {
        helpFor: hostHelpTarget(host),
        suggestion:
          `That is the module's upgrade to make: drop the \`ciSteps\` entry. A module's own ` +
          `check already runs under \`xanosdk export --frozen-lock\`, which fires \`onBundle\` ` +
          `with \`frozen\` set, so it needs no workflow step of its own.`,
      },
    );
  }
  const config = (parts as { config?: unknown }).config;
  if (
    config !== undefined &&
    (typeof config !== "object" || config === null || Array.isArray(config))
  ) {
    throw new UsageError(
      `${pkg} contributes a \`config\` that is ${describeValue(config)} where that module's ` +
        `settings object is expected, so \`${hostLabel(host)}\` would write a "xanosdk" block ` +
        `every later run refuses to read.`,
      {
        helpFor: hostHelpTarget(host),
        suggestion:
          `That is the module's bug to fix: return a plain object from the \`config\` slot, ` +
          `or omit the slot entirely.`,
      },
    );
  }
  // The dialect the reconciler actually splices these lines with — one
  // definition of the grammar, so a marker refused here is exactly a marker
  // the splice would later count.
  const { dialect } = gitattributesSpec(pkg);
  const markers = [dialect.begin("").trim(), dialect.end("").trim()];
  for (const entry of parts.gitattributes ?? []) {
    for (const line of entry.split(/\r?\n/)) {
      const trimmed = line.trim();
      const pattern = trimmed.split(/\s+/)[0] ?? "";
      if (markers.some((marker) => trimmed.startsWith(marker))) {
        throw new UsageError(
          `${pkg} contributes a \`.gitattributes\` line that spells a xanosdk block marker ` +
            `(\`${trimmed}\`), which would leave the file with markers no run can balance.`,
          {
            helpFor: hostHelpTarget(host),
            suggestion:
              `The markers are the SDK's: it writes them around whatever a module ` +
              `contributes. Contribute the rules alone.`,
          },
        );
      }
      if (pattern === "*") {
        throw new UsageError(
          `${pkg} contributes a \`.gitattributes\` rule for \`*\`, which would override the ` +
            `line-ending rule every generated artifact is compared against.`,
          {
            helpFor: hostHelpTarget(host),
            suggestion: `A module may only add rules for paths it owns.`,
          },
        );
      }
      if (/\b(text|eol)\s*=/.test(line) || /\s-text\b/.test(line)) {
        throw new UsageError(
          `${pkg} contributes a \`.gitattributes\` rule that sets \`text\`/\`eol\` (\`${trimmed}\`). ` +
            `Line endings are the template's to set: a frozen check compares bytes, and a rule ` +
            `that reintroduces CRLF fails every run on a Windows checkout.`,
          {
            helpFor: hostHelpTarget(host),
            suggestion: `Contribute display rules (\`linguist-*\`, \`diff\`) instead.`,
          },
        );
      }
    }
  }
}

/** What a value IS, for a refusal that has to name the shape it got. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return withArticle(typeof value);
}

/**
 * Read each module's stored config block back into the answers that produced
 * it, so a re-ask can offer the project's CURRENT settings.
 *
 * `answersFromConfig` is optional and module-private, and this is the seam
 * where its three failure modes are absorbed rather than passed on:
 *
 * - omitted — the module gets shipped defaults on a re-ask, and the caller is
 *   handed nothing for it, which is the honest input to that outcome.
 * - a key matching no declared question — ignored. The SDK will not carry a
 *   value no question can validate into a config block it writes back.
 * - a throw — reported and degraded to the defaults. This hook can never take a
 *   command down; it is a convenience over data the module already owns.
 */
export function priorAnswers(
  loaded: readonly LoadedPlugin[],
  host: QuestionnaireHost,
): Record<string, PluginAnswers> {
  const out: Record<string, PluginAnswers> = {};
  for (const p of loaded) {
    assertContractShape(p.pkg, p.plugin, host);
    if (p.plugin.answersFromConfig === undefined) continue;
    // Nothing STORED means nothing to read back. A module the project has never
    // configured arrives here with an empty config block, and a module's
    // inverse handed `{}` answers with its own fallbacks — which are the
    // shipped defaults wearing the project's name. Carrying those forward would
    // report `source: "config"` for a setting nobody ever chose, which is the
    // one thing the machine output exists to get right.
    if (Object.keys(p.config).length === 0) continue;
    const ids = new Set((p.plugin.questions ?? []).map((q) => q.id));
    let read: PluginAnswers;
    try {
      read =
        p.plugin.answersFromConfig(
          p.config as Readonly<Record<string, unknown>>,
        ) ?? {};
    } catch (error) {
      warn(
        `${p.pkg} could not read its stored settings back; its defaults were used instead.`,
        "module.settings-unreadable",
        [error instanceof Error ? error.message : String(error)],
      );
      continue;
    }
    const kept: Record<string, string | boolean> = {};
    for (const [id, value] of Object.entries(read)) {
      if (!ids.has(id)) continue;
      if (typeof value === "string" || typeof value === "boolean")
        kept[id] = value;
    }
    if (Object.keys(kept).length > 0) out[p.pkg] = kept;
  }
  return out;
}

/** What one questionnaire run settled, for every module it asked about. */
export interface QuestionnaireRun {
  /** Each module's answers, keyed by package then question id. */
  readonly answers: Record<string, PluginAnswers>;
  /** Where each of those answers came from, for the machine output. */
  readonly sources: Record<string, Readonly<Record<string, AnswerSource>>>;
  /**
   * The FLAG that answers each question, keyed by package then question id.
   *
   * Reported because a caller cannot derive it. Answers are keyed by question
   * `id`, and a question may legitimately declare a `flag` that differs from
   * it (`id: "dir"` reading badly as `--dir` across several modules, so
   * `--rendered-dir`). Without this an agent reading `--json` can see WHAT a
   * module was asked and what it answered, but has no way to learn what to
   * pass on the next run to answer it differently — the one thing the output
   * exists to let it do.
   */
  readonly flags: Record<string, Readonly<Record<string, string>>>;
  /**
   * What the project had already answered, read back through
   * `answersFromConfig`. Returned rather than discarded because the reconciler
   * decides from it whether a module's contributions can be RECOMPUTED
   * faithfully or must be carried forward as they are.
   */
  readonly prior: Readonly<Record<string, PluginAnswers>>;
}

/**
 * The questionnaire, run the one way every host runs it.
 *
 * Four calls in one order — collect the question sets, refuse a flag collision,
 * read the project's stored answers back, resolve — plus the report of every
 * stale key that was dropped. `init` and the reconciler each writing this out
 * would be two chances for one of them to stop reading prior answers, or to
 * drop a stale key in silence. It is not a long sequence; it is a sequence
 * whose ORDER is load-bearing, which is the kind worth having once.
 */
export async function runPluginQuestionnaire(
  loaded: readonly LoadedPlugin[],
  opts: {
    readonly host: QuestionnaireHost;
    readonly unknownFlags: readonly string[];
    readonly prompter: QuestionPrompter;
  },
): Promise<QuestionnaireRun> {
  const sets = questionSets(loaded);
  assertNoFlagCollisions(sets, opts.host);
  // Before the prompter, so a stored answer seeds BOTH the prompt default and
  // the non-interactive fallback.
  const prior = priorAnswers(loaded, opts.host);
  const resolved = await resolvePluginAnswers(sets, {
    host: opts.host,
    unknownFlags: opts.unknownFlags,
    prompter: opts.prompter,
    prior,
  });

  const answers: Record<string, PluginAnswers> = {};
  const sources: Record<string, Readonly<Record<string, AnswerSource>>> = {};
  const flags: Record<string, Readonly<Record<string, string>>> = {};
  const questionsFor = new Map(sets.map((s) => [s.pkg, s.questions]));
  for (const [pkg, r] of Object.entries(resolved)) {
    answers[pkg] = r.answers;
    sources[pkg] = r.sources;
    // Only the questions this run actually settled, so the map and the answers
    // it explains always name the same keys.
    flags[pkg] = Object.fromEntries(
      (questionsFor.get(pkg) ?? [])
        .filter((q) => r.answers[q.id] !== undefined)
        .map((q) => [q.id, flagFor(q)]),
    );
    // A stored key for a question this run did not ask is DELETED, never
    // carried forward — and said out loud, because the alternative is a setting
    // that quietly stops applying.
    for (const gone of r.dropped) {
      warn(
        gone.why === "excluded"
          ? `${pkg}: \`${gone.id}\` is no longer asked, so its stored setting was dropped.`
          : `${pkg}: the stored setting for \`${gone.id}\` is no longer a value that question ` +
              `accepts, so the module's default was used.`,
        "module.setting-dropped",
      );
    }
  }
  return { answers, sources, flags, prior };
}

/**
 * Why a loaded module produced no contribution.
 *
 * The two are NOT the same fact to a reconciler, which is the whole reason
 * this distinction is surfaced instead of collapsed into an empty list:
 *
 * - `none` — the module declares no `contributes` hook at all. It is a
 *   perfectly configured module that simply has nothing to splice, so the
 *   reconciler is free to record it as configured.
 * - `failed` — the hook threw. Nothing is known about what this module wants,
 *   so the reconciler must leave every byte it owns exactly as it found it.
 *   Recording it as configured would make the next run skip the questionnaire
 *   that never completed.
 */
export type ContributionStatus = "contributed" | "none" | "failed";

/** One module's outcome from the `contributes` pass. */
export interface ContributionOutcome {
  readonly pkg: string;
  /** The module's own version, for stamping the block its lines land in. */
  readonly version: string;
  readonly status: ContributionStatus;
  /** Present only when `status` is `"contributed"`. */
  readonly parts?: ProjectContributions;
}

/**
 * What the project should RECORD in its `"xanosdk"` block for one module — the
 * single rule `init` and the reconciler both decide by.
 *
 * `undefined` means LEAVE WHATEVER IS STORED, not "record nothing": both
 * callers merge this over a block they read off disk first.
 *
 * Four arms, and each one exists to stop a different silent failure:
 *
 * - **`failed`** — `contributes` threw, so nothing is known about what this
 *   module wants. Its config above all is left alone: the presence of config is
 *   what tells the next run the questionnaire already completed, so recording
 *   anything here would skip a questionnaire that never ran.
 * - **`none`** — no `contributes` hook at all: a configured module with nothing
 *   to splice. `{}` is "configured and gave nothing", which is ENABLED, and it
 *   is what stops this module being reported unconfigured forever. Recorded
 *   only when nothing is stored, so a hand-edited setting survives.
 * - **contributed WITH config** — the module's own value, verbatim.
 * - **contributed, lines but no config** — same `{}` as `none`, same reason.
 * - **contributed NOTHING at all** — the module reporting it was switched off
 *   (the real one returns `{}` from `contributes` when its enabling question is
 *   answered "no"). This one OVERWRITES, and recording it is load-bearing:
 *   absent config reads as ENABLED (`isEnabled(null)` is true), so leaving the
 *   block empty would leave the module enabled with no settings — the exact
 *   state the unconfigured report exists to prevent — and the next `deploy`
 *   would fire `onBundle` with `config: {}` and render the tree the user just
 *   declined.
 *
 * Deleting a package's config is correct in exactly one place, and it is not
 * here: the reconciler's REMOVAL pass, where the package is no longer a
 * dependency at all. That is the one fact this function does not know, so it is
 * the one decision that stays with the reconciler.
 */
export function recordedConfig(
  outcome: ContributionOutcome,
  stored: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (outcome.status === "failed") return undefined;
  if (outcome.status === "none") return stored === undefined ? {} : undefined;
  const parts = outcome.parts ?? {};
  if (parts.config !== undefined) return parts.config;
  if ((parts.gitattributes ?? []).length > 0) return stored === undefined ? {} : undefined;
  return { enabled: false };
}

/**
 * Refuse a `contributes` return value that is not the contract's shape.
 *
 * `undefined` and `null` are the contract: a module with nothing to say. A
 * string, a number, an array or a PROMISE (an `async contributes`, which the
 * hook is not) is contract skew, and absorbing it is the silent failure this
 * file exists to remove. A wrong-type return reads as "contributed nothing at
 * all", which {@link recordedConfig} records as `{ enabled: false }` — so a
 * module that works is SWITCHED OFF, `marketplace remove` then refuses it for
 * being deliberately disabled, and the author never learns their hook returned
 * the wrong thing.
 */
function assertContributionsShape(
  pkg: string,
  returned: unknown,
  host: QuestionnaireHost,
): ProjectContributions {
  if (returned === undefined || returned === null) return {};
  // A Promise is an OBJECT, so `typeof` alone lets an `async contributes`
  // through — and a pending Promise has no `gitattributes` and no `config`,
  // which reads as the empty contribution that switches the module off. The
  // thenable test is what makes the async case a refusal rather than the
  // quietest possible wrong answer.
  const thenable =
    typeof (returned as { then?: unknown }).then === "function";
  if (typeof returned !== "object" || Array.isArray(returned) || thenable) {
    throw new UsageError(
      `${pkg}'s \`contributes\` returned ${thenable ? "a Promise" : describeValue(returned)} where a ` +
        `\`ProjectContributions\` object is expected, so \`${hostLabel(host)}\` would read it ` +
        `as a module that contributes nothing and record it as switched off.`,
      {
        helpFor: hostHelpTarget(host),
        suggestion:
          `That is the module's bug to fix: return an object (\`{ gitattributes, config }\`), ` +
          `or nothing at all. \`contributes\` is synchronous — an \`async\` one returns a ` +
          `Promise, which is this same refusal.`,
      },
    );
  }
  return returned as ProjectContributions;
}

/**
 * Run every loaded module's `contributes` hook, reporting each outcome.
 *
 * Kept PER PACKAGE rather than concatenated. Each module's lines become one
 * marked block naming it and stamped with its version, which is what makes a
 * configured project re-appliable: a later install, re-configure or remove
 * rewrites exactly that span and nothing around it. A module contributing only
 * `config` has no lines and so gets no block.
 */
export function contributionOutcomes(
  loaded: readonly LoadedPlugin[],
  answers: Readonly<Record<string, PluginAnswers>>,
  host: QuestionnaireHost,
): readonly ContributionOutcome[] {
  const out: ContributionOutcome[] = [];
  for (const p of loaded) {
    assertContractShape(p.pkg, p.plugin, host);
    if (p.plugin.contributes === undefined) {
      out.push({ pkg: p.pkg, version: p.version, status: "none" });
      continue;
    }
    try {
      const parts = assertContributionsShape(
        p.pkg,
        p.plugin.contributes(answers[p.pkg] ?? {}),
        host,
      );
      assertUsableContributions(p.pkg, parts, host);
      // `config` has to survive `JSON.stringify` — the reconciler stringifies
      // the whole next `"xanosdk"` block to decide whether it changed, and a
      // BigInt or a cycle throws a bare `TypeError` from there naming nothing
      // at all. Proved HERE, inside this module's own `try`, so the failure
      // degrades to `status: "failed"` with the package named and every byte
      // it owns left exactly as it was.
      if (parts.config !== undefined) JSON.stringify(parts.config);
      out.push({
        pkg: p.pkg,
        version: p.version,
        status: "contributed",
        parts,
      });
    } catch (error) {
      if (error instanceof UsageError) throw error;
      warn(
        `${p.pkg} could not describe what it contributes and was skipped.`,
        "module.describe-failed",
        [error instanceof Error ? error.message : String(error)],
      );
      out.push({ pkg: p.pkg, version: p.version, status: "failed" });
    }
  }
  return out;
}

/**
 * Every loaded module's contributions, in discovery order.
 *
 * The flat view of {@link contributionOutcomes}, for a caller — `init` — that
 * writes a file from scratch and so has nothing to preserve for a module that
 * could not describe itself.
 */
export function resolveContributions(
  loaded: readonly LoadedPlugin[],
  answers: Readonly<Record<string, PluginAnswers>>,
  host: QuestionnaireHost,
): readonly ResolvedContribution[] {
  return contributionOutcomes(loaded, answers, host).flatMap((o) =>
    o.status === "contributed"
      ? [{ pkg: o.pkg, version: o.version, parts: o.parts! }]
      : [],
  );
}
