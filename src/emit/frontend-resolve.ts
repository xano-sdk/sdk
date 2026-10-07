/**
 * Resolving which frontend a scaffold gets: `--framework` wins, otherwise
 * prompt in a TTY, otherwise the default.
 *
 * Split from `frontend-presets.ts` (which is pure string building) because the
 * prompt needs `node:readline` — the same split, and the same resolution order,
 * as the AI-preset prompt in `scaffold.ts`.
 *
 * The preset table itself lives in `frontend-presets.ts` as a static record —
 * see the note there on why it is not a register-by-side-effect registry.
 *
 * "No frontend" is the value {@link NO_FRONTEND} on the same choice, not a
 * preset: it resolves to `null`, and a scaffold that receives `null` writes the
 * backend alone. It is not in `FRAMEWORKS`, because everything that reads that
 * list (preset lookup, project detection, the e2e build) is about a framework
 * that renders something.
 */
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_FRAMEWORK,
  FRAMEWORKS,
  allFrontendPresets,
  findFrontendPreset,
  type FrontendPreset,
} from "./frontend-presets.js";
import { flagValue } from "./theme-resolve.js";
import { questionOrCancel } from "./prompt.js";

/** The `--framework` value, and the prompt answer, that scaffolds no frontend. */
export const NO_FRONTEND = "none";

/** Every value `--framework` accepts, in prompt/help order. */
export const FRAMEWORK_CHOICES: readonly string[] = [...FRAMEWORKS, NO_FRONTEND];

/** The preset a scaffold gets when nothing selects one. */
export function defaultFrontendPreset(): FrontendPreset {
  const preset = findFrontendPreset(DEFAULT_FRAMEWORK);
  if (preset === undefined) {
    throw new Error(`Default frontend preset "${DEFAULT_FRAMEWORK}" is missing from the table.`);
  }
  return preset;
}

/** Whether a prompt answer or flag value spells "no frontend". */
function isNoFrontend(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t === NO_FRONTEND || t === "no frontend";
}

/**
 * Prompt (in a TTY) for the frontend framework. An empty answer takes the
 * default. Never called in non-interactive mode.
 */
async function promptFramework(): Promise<FrontendPreset | null> {
  const presets = allFrontendPresets();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      `\nWhich frontend framework?\n` +
        presets
          .map((p, i) => `  ${i + 1}) ${p.label}${p.id === DEFAULT_FRAMEWORK ? " (default)" : ""}`)
          .join("\n") +
        `\n  ${presets.length + 1}) No frontend (the backend only)\n`,
    );
    // Ctrl-C is a cancel (exit 130), as at every other prompt — not a crash.
    const answer = await questionOrCancel(rl, `Enter a number or name, or leave blank for the default: `);
    const token = answer.trim().toLowerCase();
    if (token === "") return defaultFrontendPreset();
    const byIndex = Number.parseInt(token, 10);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= presets.length) {
      return presets[byIndex - 1]!;
    }
    if (byIndex === presets.length + 1 || isNoFrontend(token)) return null;
    // An unrecognised answer takes the default rather than throwing: the user
    // is mid-prompt, not mid-scripted-run, and a hard error would discard the
    // AI-preset answers they are about to give. `--framework` is where a typo
    // is worth failing on.
    return findFrontendPreset(token) ?? defaultFrontendPreset();
  } finally {
    rl.close();
  }
}

/**
 * The `--framework` value alone, validated: a preset, `null` for
 * {@link NO_FRONTEND}, and a bad value throws naming every valid one.
 */
export function resolveFrameworkValue(flag: string): FrontendPreset | null {
  if (isNoFrontend(flag)) return null;
  return flagValue(flag, FRAMEWORK_CHOICES, () => {
    const preset = findFrontendPreset(flag);
    if (preset === undefined) {
      throw new Error(`Unknown --framework "${flag}". Valid values: ${FRAMEWORK_CHOICES.join(", ")}.`);
    }
    return preset;
  });
}

/**
 * `--framework` wins (and a bad value throws); otherwise prompt in a TTY;
 * otherwise the default. `null` is "no frontend".
 */
export async function resolveFrontendPreset(flag: string | undefined): Promise<FrontendPreset | null> {
  if (flag !== undefined && flag !== "") return resolveFrameworkValue(flag);
  if (process.stdin.isTTY && process.stderr.isTTY) return promptFramework();
  return defaultFrontendPreset();
}
