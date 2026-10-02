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
 */
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_FRAMEWORK,
  FRAMEWORKS,
  allFrontendPresets,
  findFrontendPreset,
  resolveFrameworkFlag,
  type FrontendPreset,
} from "./frontend-presets.js";
import { flagValue } from "./theme-resolve.js";
import { questionOrCancel } from "./prompt.js";

/** The preset a scaffold gets when nothing selects one. */
export function defaultFrontendPreset(): FrontendPreset {
  const preset = findFrontendPreset(DEFAULT_FRAMEWORK);
  if (preset === undefined) {
    throw new Error(`Default frontend preset "${DEFAULT_FRAMEWORK}" is missing from the table.`);
  }
  return preset;
}

/**
 * Prompt (in a TTY) for the frontend framework. An empty answer takes the
 * default. Never called in non-interactive mode.
 */
async function promptFramework(): Promise<FrontendPreset> {
  const presets = allFrontendPresets();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      `\nWhich frontend framework?\n` +
        presets
          .map((p, i) => `  ${i + 1}) ${p.label}${p.id === DEFAULT_FRAMEWORK ? " (default)" : ""}`)
          .join("\n") +
        `\n`,
    );
    // Ctrl-C is a cancel (exit 130), as at every other prompt — not a crash.
    const answer = await questionOrCancel(rl, `Enter a number or name, or leave blank for the default: `);
    const token = answer.trim().toLowerCase();
    if (token === "") return defaultFrontendPreset();
    const byIndex = Number.parseInt(token, 10);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= presets.length) {
      return presets[byIndex - 1]!;
    }
    // An unrecognised answer takes the default rather than throwing: the user
    // is mid-prompt, not mid-scripted-run, and a hard error would discard the
    // AI-preset answers they are about to give. `--framework` is where a typo
    // is worth failing on.
    return findFrontendPreset(token) ?? defaultFrontendPreset();
  } finally {
    rl.close();
  }
}

/** `--framework` wins (and a bad value throws); otherwise prompt in a TTY; otherwise the default. */
export async function resolveFrontendPreset(flag: string | undefined): Promise<FrontendPreset> {
  if (flag !== undefined && flag !== "") return flagValue(flag, FRAMEWORKS, () => resolveFrameworkFlag(flag));
  if (process.stdin.isTTY && process.stderr.isTTY) return promptFramework();
  return defaultFrontendPreset();
}
