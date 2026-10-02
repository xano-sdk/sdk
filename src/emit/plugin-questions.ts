/**
 * Asking a toolchain module's own questions, and answering them from flags,
 * from what the project already stored, or from the module's own defaults when
 * nobody is there to type.
 *
 * ── Why a module's questions are data ───────────────────────────────────────
 *
 * See `src/plugin.ts`: a module declares {@link PluginQuestion} records rather
 * than supplying a prompt callback, which is what lets the SDK own every way of
 * answering one. This file is those ways: a derived flag, an interactive
 * prompt, the project's stored answer, and the declared default.
 *
 * ── Host-agnostic on purpose ────────────────────────────────────────────────
 *
 * A module is configured whenever its project is RECONCILED, and `init` is only
 * the first of those moments — `marketplace install` and `marketplace reinstall`
 * run the same questionnaire. So every error this file writes names the
 * {@link QuestionnaireHost} it was called under rather than assuming `init`; a
 * refusal that says "an `xanosdk init` flag" during an install sends the reader
 * to the wrong command.
 *
 * ── Precedence ──────────────────────────────────────────────────────────────
 *
 *     flag  >  the project's stored answer  >  the module's declared default
 *
 * The middle rank is what makes a re-ask safe. A stored answer is both the
 * prompt's default and the non-interactive fallback, so re-running the
 * questionnaire never quietly resets a directory the user chose back to what
 * the module shipped. {@link ResolvedAnswers.sources} records which rank each
 * answer came from, because a CI run that configured a module from defaults
 * must leave an artifact saying so.
 *
 * ── The derived flag ────────────────────────────────────────────────────────
 *
 * Each question gets a long flag, from `flag` when the module names one and
 * from `id` otherwise. Booleans get a `--no-` counterpart, because a question
 * whose default is `true` is otherwise unanswerable without a TTY.
 *
 * Those flags cannot be in the command registry — the modules are not known
 * until the host has a project directory and has installed them — so `parseArgs`
 * carries the host's unrecognized flags through instead of refusing them, and
 * {@link resolvePluginAnswers} refuses whatever is left over. The error still
 * happens; it just happens once there is enough information to write a useful
 * one.
 *
 * Node-only; reached from `init-command.ts` and the reconciler.
 */

import type { PluginAnswers, PluginQuestion } from "../plugin.js";
import type { LoadedPlugin } from "./toolchain-modules.js";
import { UsageError, unknownFlag, type HelpTarget } from "./errors.js";
import { flagNames } from "./commands.js";

/**
 * Which command is running the questionnaire.
 *
 * Not cosmetic: it picks the help block a refusal prints and the command name
 * the reader is told to re-run, and those differ between the four hosts.
 *
 * `remove` asks nothing — its ask-set is empty, because the package it names is
 * already uninstalled — and it is here anyway. The reconcile it runs still
 * refuses a contract-skewed module among the OTHERS the project has installed,
 * and that refusal names a command to re-run. Without this member it named
 * `reinstall`, a verb the reader did not type and would not have typed.
 */
export type QuestionnaireHost = "init" | "install" | "reinstall" | "remove";

/**
 * How a host is spelled when a message tells the reader to re-run it.
 *
 * Every host but `init` is a `marketplace` subcommand and spells itself, which
 * is why adding one needs no case here.
 */
export function hostLabel(host: QuestionnaireHost): string {
  return host === "init" ? "xanosdk init" : `xanosdk marketplace ${host}`;
}

/** The help block a refusal under this host should print. */
export function hostHelpTarget(host: QuestionnaireHost): HelpTarget {
  return host === "init" ? { command: "init" } : { command: "marketplace", subcommand: host };
}

/** Whether the CLI already owns this long-flag name. */
function isRegistryFlag(flag: string): boolean {
  return flagNames().includes(flag);
}

/** The flag that answers a question, without its leading dashes. */
export function flagFor(question: PluginQuestion): string {
  return question.flag ?? question.id;
}

/** One module's questions, with its package name for error messages. */
export interface PluginQuestionSet {
  readonly pkg: string;
  readonly questions: readonly PluginQuestion[];
}

/** Every loaded plugin that declares questions, in discovery order. */
export function questionSets(plugins: readonly LoadedPlugin[]): readonly PluginQuestionSet[] {
  return plugins
    .filter((p) => p.plugin.questions !== undefined && p.plugin.questions.length > 0)
    .map((p) => ({ pkg: p.pkg, questions: p.plugin.questions! }));
}

/**
 * Refuse a derived flag that something else already answers.
 *
 * Both collisions are SILENT without this, and in both directions. A question
 * whose flag matches one of `init`'s own (`--name`, `--force`, `--framework`, …)
 * never reaches the plugin at all: `parseArgs` binds the real flag first, so the
 * SDK acts on a value meant for the module and the module quietly records its
 * default — two wrong values, no message. Two modules deriving the same flag is
 * the same failure between them, since the first to be asked consumes it.
 *
 * Checked here rather than left to the module author because the author cannot
 * see this list from their own repo. `plugin.ts` advises declaring an explicit
 * `flag` to avoid the clash; this is what makes the advice enforceable.
 */
export function assertNoFlagCollisions(
  sets: readonly PluginQuestionSet[],
  host: QuestionnaireHost,
): void {
  const claimed = new Map<string, string>();
  for (const set of sets) {
    for (const question of set.questions) {
      const flag = flagFor(question);
      if (isRegistryFlag(flag)) {
        throw new UsageError(
          `${set.pkg} asks a question whose flag \`--${flag}\` is already a \`${hostLabel(host)}\` ` +
            `flag, so it could never be answered — the CLI would consume it first.`,
          {
            helpFor: hostHelpTarget(host),
            suggestion:
              `That is the module's bug to fix: its question \`${question.id}\` should declare a ` +
              `distinct \`flag\` (for example \`--${set.pkg.replace(/^@[^/]+\//, "")}-${flag}\`). ` +
              `Report it, or disable the module in this project's package.json "xanosdk" block.`,
          },
        );
      }
      const owner = claimed.get(flag);
      if (owner !== undefined) {
        throw new UsageError(
          `${set.pkg} and ${owner} both derive the flag \`--${flag}\`, so only one of them could ` +
            `ever be answered by it during \`${hostLabel(host)}\`.`,
          {
            helpFor: hostHelpTarget(host),
            suggestion: `One of the two must declare a distinct \`flag\` on that question.`,
          },
        );
      }
      claimed.set(flag, set.pkg);
    }
  }
}

/** What a flag said about one question, or that it said nothing. */
type FlagAnswer = { readonly given: true; readonly value: string | boolean } | { readonly given: false };

/**
 * Read one question's answer out of the raw flags, consuming what it used.
 *
 * Accepts `--flag value`, `--flag=value` and, for booleans, bare `--flag` and
 * `--no-flag`. Consumed entries are removed from `remaining` so the caller can
 * refuse whatever nobody claimed.
 */
function answerFromFlags(question: PluginQuestion, remaining: string[]): FlagAnswer {
  const name = flagFor(question);
  const long = `--${name}`;
  const negated = `--no-${name}`;

  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i]!;
    if (question.type === "boolean" && arg === negated) {
      remaining.splice(i, 1);
      return { given: true, value: false };
    }
    if (arg === long) {
      if (question.type === "boolean") {
        remaining.splice(i, 1);
        return { given: true, value: true };
      }
      // `--flag value` is not available to a plugin flag, and this is the one
      // place that can say so. `parseArgs` cannot tell whether a deferred flag
      // takes a value, so it never consumes the following token — which means
      // the bare form here has already left that token in `positionals`, where
      // it would otherwise be read as `init`'s target directory.
      throw new UsageError(
        `${long} takes its value with an equals sign: \`${long}=<value>\`.`,
        {
          suggestion:
            `Flags contributed by an installed module are not known to the ` +
            `parser until the module loads, so it cannot tell \`${long} value\` ` +
            `from a flag followed by a positional argument.`,
        },
      );
    }
    if (arg.startsWith(`${long}=`)) {
      const value = arg.slice(long.length + 1);
      remaining.splice(i, 1);
      if (question.type === "boolean") return { given: true, value: value !== "false" };
      return { given: true, value };
    }
  }
  return { given: false };
}

/** Refuse a choice answer that is not one of the declared choices. */
function assertChoice(
  pkg: string,
  question: PluginQuestion,
  value: string | boolean,
  host: QuestionnaireHost,
): void {
  if (question.type !== "choice") return;
  const choices = question.choices ?? [];
  if (!choices.includes(String(value))) {
    throw new UsageError(
      `${pkg}: --${flagFor(question)} expects one of ${choices.map((c) => `\`${c}\``).join(", ")}, ` +
        `not \`${String(value)}\`.`,
      { helpFor: hostHelpTarget(host) },
    );
  }
}

/**
 * How a question gets answered when no flag did.
 *
 * `fallback` is what the prompt should offer: the project's stored answer when
 * it has one, the module's declared default otherwise. The prompter is handed
 * it rather than reading `question.default` itself, so an interactive re-ask
 * and a non-interactive one agree on what "just press enter" means.
 */
export interface QuestionPrompter {
  /** Ask interactively. Returns undefined when there is no TTY to ask on. */
  ask(
    pkg: string,
    question: PluginQuestion,
    fallback: string | boolean,
  ): Promise<string | boolean | undefined>;
}

/**
 * Where one answer came from.
 *
 * Four ranks, not three, because `"default"` alone would be a lie about the
 * middle one. An answer the project already stored and this run accepted
 * without asking is NOT the module's shipped default — it is a choice somebody
 * made, being honoured. `plugin.ts` states that rank explicitly ("A project's
 * own stored answer OUTRANKS this"), so the vocabulary has to carry it, or a
 * machine-readable record of a re-install could not tell a preserved setting
 * from a reset one.
 *
 * - `flag`    — a derived `--flag` on this invocation.
 * - `prompt`  — a human answered it, this run.
 * - `config`  — the project's stored answer, accepted without asking.
 * - `default` — the module's declared default; nothing else was available.
 */
export type AnswerSource = "flag" | "prompt" | "config" | "default";

/** A stored key that did not survive into this run's answers, and why. */
export interface DroppedAnswer {
  /** The question id whose stored key is gone. */
  readonly id: string;
  /**
   * - `excluded` — a `when` excluded the question, so it HAS no answer and the
   *   stale key is deleted rather than carried forward.
   * - `unusable` — the stored value is not one this question accepts any more,
   *   so it was replaced by the declared default.
   */
  readonly why: "excluded" | "unusable";
}

/** One module's resolved answers, with the provenance of each. */
export interface ResolvedAnswers {
  /** The answers, keyed by {@link PluginQuestion.id}. */
  readonly answers: PluginAnswers;
  /** Where each answer came from, keyed by the same ids. */
  readonly sources: Readonly<Record<string, AnswerSource>>;
  /** Stored keys this run dropped — reported by the caller, never in silence. */
  readonly dropped: readonly DroppedAnswer[];
}

/** What {@link resolvePluginAnswers} needs to run a questionnaire. */
export interface ResolveAnswersOptions {
  /** Which command is asking. Names every refusal and picks its help block. */
  readonly host: QuestionnaireHost;
  /** The host's unrecognized flags. Whatever no question claims is refused. */
  readonly unknownFlags: readonly string[];
  /** How a question is asked when no flag answered it. */
  readonly prompter: QuestionPrompter;
  /**
   * What the project already answered, by package then question id — from
   * `ToolchainPlugin.answersFromConfig` reading its stored config block.
   *
   * Seeds BOTH the prompt default and the non-interactive fallback, which is
   * the whole rule: a re-ask offers the project's current settings, and a
   * `--json` or CI run keeps them rather than resetting to shipped defaults.
   */
  readonly prior?: Readonly<Record<string, PluginAnswers>>;
}

/** Whether a stored value is still something this question accepts. */
function priorIsUsable(question: PluginQuestion, value: string | boolean): boolean {
  if (question.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  if (question.type === "choice") return (question.choices ?? []).includes(value);
  return true;
}

/**
 * Resolve every loaded plugin's questions into its own answers.
 *
 * Returns a map from package name to that module's {@link ResolvedAnswers}, and
 * refuses any of the host's flags no question claimed.
 *
 * A question whose `when` is false is not asked AND no answer is recorded for
 * it — an unasked question has no answer, and writing one would leave a later
 * `deploy` acting on a choice nobody made. On a re-ask that also DELETES a
 * stale key a previous run stored for it, reported through
 * {@link ResolvedAnswers.dropped} rather than dropped in silence.
 */
export async function resolvePluginAnswers(
  sets: readonly PluginQuestionSet[],
  opts: ResolveAnswersOptions,
): Promise<Record<string, ResolvedAnswers>> {
  const remaining = [...opts.unknownFlags];
  const byPackage: Record<string, ResolvedAnswers> = {};

  for (const set of sets) {
    const stored = opts.prior?.[set.pkg] ?? {};
    const answers: Record<string, string | boolean> = {};
    const sources: Record<string, AnswerSource> = {};
    const dropped: DroppedAnswer[] = [];

    for (const question of set.questions) {
      // Evaluated against the answers SO FAR, so a question can depend on one
      // asked before it in the same module's list.
      if (question.when !== undefined && !question.when(answers)) {
        // Records nothing — and takes the stale key with it, because a stored
        // answer to a question that is no longer asked is exactly the "choice
        // nobody made" a later `deploy` must not act on.
        if (stored[question.id] !== undefined) dropped.push({ id: question.id, why: "excluded" });
        continue;
      }

      const fromFlag = answerFromFlags(question, remaining);
      if (fromFlag.given) {
        assertChoice(set.pkg, question, fromFlag.value, opts.host);
        answers[question.id] = fromFlag.value;
        sources[question.id] = "flag";
        continue;
      }

      // A stored value the question no longer accepts — a choice retired by a
      // module upgrade, say — is not silently offered back as the prompt
      // default and not written through. It is replaced and reported.
      const raw = stored[question.id];
      let prior: string | boolean | undefined;
      if (raw !== undefined) {
        if (priorIsUsable(question, raw)) prior = raw;
        else dropped.push({ id: question.id, why: "unusable" });
      }

      const asked = await opts.prompter.ask(set.pkg, question, prior ?? question.default);
      if (asked !== undefined) {
        assertChoice(set.pkg, question, asked, opts.host);
        answers[question.id] = asked;
        sources[question.id] = "prompt";
        continue;
      }
      if (prior !== undefined) {
        answers[question.id] = prior;
        sources[question.id] = "config";
        continue;
      }
      answers[question.id] = question.default;
      sources[question.id] = "default";
    }

    byPackage[set.pkg] = { answers, sources, dropped };
  }

  if (remaining.length > 0) {
    // Every flag THIS run would have accepted, module flags included. The
    // suggester's registry knows the CLI's own; a module's are derived from its
    // questions and exist only for the modules this project installed.
    throw unknownFlag(
      remaining,
      hostHelpTarget(opts.host),
      sets.flatMap((s) => s.questions.map(flagFor)),
    );
  }
  return byPackage;
}
