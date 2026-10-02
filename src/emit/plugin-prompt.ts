/**
 * The interactive half of a toolchain module's questionnaire — one TTY prompt
 * per {@link PluginQuestion}, or a clean decline so the caller falls back to
 * the project's stored answer and then to the module's declared default.
 *
 * Split out of `init-command.ts` because `init` is no longer the only host:
 * `marketplace install` and `marketplace reinstall` ask the same questions, and
 * a prompter that lived inside the scaffold command could not be reached from
 * the reconciler without dragging the scaffold in with it.
 *
 * ── When a run is non-interactive ───────────────────────────────────────────
 *
 * `--json`, OR a stdin that is not a TTY, forces a non-interactive run. The
 * `--json` half is the one that had to be added: machine output is decided on
 * **stdout** (`output.ts`), while a prompt reads stdin and writes stderr, so
 * `install --json` at a terminal would sit there prompting a human and only
 * then emit the JSON that was asked for. A caller that wants a machine-readable
 * answer has said, by asking, that nobody is watching.
 *
 * Declining is NOT the same as answering. `undefined` means "not asked", never
 * "answered nothing" — an empty line on a string question is an author
 * accepting the offered value, and that has to reach the same place as the
 * value itself rather than looking like a refusal to answer.
 *
 * Node-only.
 */

import { questionOrCancel } from "./prompt.js";
import { createInterface } from "node:readline/promises";
import type { PluginQuestion } from "../plugin.js";
import type { QuestionPrompter } from "./plugin-questions.js";
import { style, terminalText } from "./ui.js";

/** The streams a prompt reads and writes, and whether output is machine-bound. */
export interface PrompterOptions {
  /**
   * The run was asked for machine output (`--json`). Forces non-interactive —
   * see the module header.
   */
  readonly json?: boolean;
  /** Where answers are read from. Defaults to `process.stdin`. */
  readonly stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  /**
   * Where the question is written. Defaults to `process.stderr` — never stdout,
   * which belongs to the command's own output.
   */
  readonly stderr?: NodeJS.WritableStream & { isTTY?: boolean };
}

/**
 * Whether this run may ask a human anything at all.
 *
 * Exported so a host can say "configured from defaults" once, up front, rather
 * than discovering it question by question.
 */
export function canPrompt(opts: PrompterOptions = {}): boolean {
  if (opts.json === true) return false;
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  return stdin.isTTY === true && stderr.isTTY === true;
}

/**
 * Ask one plugin question on a TTY, or decline so the caller falls back.
 *
 * `fallback` is what pressing enter accepts: the project's stored answer when
 * it has one, the module's declared default otherwise. Taking it as an argument
 * rather than reading `question.default` is what makes a re-ask offer the
 * project's CURRENT settings — the same value the non-interactive path would
 * have kept, so the two branches cannot disagree about what "unchanged" means.
 */
export async function promptPluginQuestion(
  pkg: string,
  question: PluginQuestion,
  fallback: string | boolean,
  opts: PrompterOptions = {},
): Promise<string | boolean | undefined> {
  if (!canPrompt(opts)) return undefined;
  const input = opts.stdin ?? process.stdin;
  const output = opts.stderr ?? process.stderr;
  const rl = createInterface({ input, output });
  try {
    output.write(terminalText(`\n${question.label} ${style.dim(`(${pkg})`)}\n`));
    if (question.type === "boolean") {
      const answer = (await questionOrCancel(rl, `  [Y/n] (default: ${fallback ? "yes" : "no"}): `, output))
        .trim()
        .toLowerCase();
      if (answer === "") return fallback;
      return answer === "y" || answer === "yes";
    }
    if (question.type === "choice") {
      const choices = question.choices ?? [];
      output.write(choices.map((c, i) => `  ${i + 1}) ${c}`).join("\n") + "\n");
      const answer = (await questionOrCancel(rl, `  Choose (default: ${String(fallback)}): `, output)).trim();
      if (answer === "") return fallback;
      const index = Number.parseInt(answer, 10);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1];
      return choices.includes(answer) ? answer : fallback;
    }
    const answer = (await questionOrCancel(rl, `  (default: ${String(fallback)}): `, output)).trim();
    return answer === "" ? fallback : answer;
  } finally {
    rl.close();
  }
}

/**
 * The prompter every host hands to `resolvePluginAnswers`.
 *
 * One factory rather than each host building its own closure, so the
 * non-interactive gate is decided in exactly one place for `init`, `install`
 * and `reinstall` alike.
 */
export function pluginPrompter(opts: PrompterOptions = {}): QuestionPrompter {
  return {
    ask: (pkg, question, fallback) => promptPluginQuestion(pkg, question, fallback, opts),
  };
}
