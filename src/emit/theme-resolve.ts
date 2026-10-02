/**
 * Resolving which theme a scaffold gets: `--theme` wins, otherwise plain
 * shadcn/ui.
 *
 * Split from `theme-presets.ts` (pure string building and arithmetic) because
 * everything here touches the outside world — `node:fs` and `fetch` for an
 * imported registry theme. The same split as `frontend-resolve.ts`.
 *
 * Nothing here prompts. The questionnaire asks about the framework and the AI
 * instruction files, both of which change what the project IS; a palette is a
 * look, and every one of the 126 base×accent combinations and every published
 * registry theme stays reachable through `--theme` — before or after scaffolding.
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ParsedArgs } from "./cli.js";
import {
  ACCENTS,
  BASE_COLORS,
  DARK_MODES,
  defaultThemeChoice,
  findFont,
  fontIdsFor,
  normalizeRadius,
  resolveDarkModeFlag,
  resolveFontFlag,
  resolveThemeFlag,
  themeFromRegistryItem,
  withRadius,
  DEFAULT_DARK_MODE,
  type DarkMode,
  type FontChoice,
  type FontId,
  type FontSlot,
  type Theme,
  type ThemeChoice,
} from "./theme-presets.js";
import { ICON_LIBRARIES, resolveIconsFlag, type IconLibraryId } from "./icon-presets.js";
import { statusLabel } from "../util/http.js";
import { UsageError } from "./errors.js";
import { suggest } from "../util/suggest.js";

/**
 * A scaffold flag's value through its validator, a refusal a usage failure.
 *
 * The validators live in browser-safe modules (`@xano/sdk/scaffold`), so they
 * throw a plain `Error`; at the CLI a mistyped value is the caller's to retype —
 * `SDK_USAGE` with the near miss, like every other mistyped name.
 */
export function flagValue<T>(raw: string, candidates: readonly string[], resolve: () => T): T {
  try {
    return resolve();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const near = suggest(raw.trim().toLowerCase(), candidates);
    throw new UsageError(err.message, near === undefined ? {} : { suggestion: near });
  }
}

/**
 * One font flag. A known face in the wrong slot carries no "did you mean" —
 * the nearest candidate to an exact face name is a different face, and the
 * message already names the flag that takes it. A typo is suggested from the
 * slot's own faces, never one the slot refuses.
 */
function fontFlag(raw: string, slot: FontSlot): FontId {
  if (findFont(raw) !== undefined) {
    try {
      return resolveFontFlag(raw, slot);
    } catch (err) {
      throw err instanceof Error ? new UsageError(err.message) : err;
    }
  }
  return flagValue(raw, fontIdsFor(slot), () => resolveFontFlag(raw, slot));
}

/** Every `--theme` id: each base alone and with each accent. */
function themeIds(): string[] {
  return BASE_COLORS.flatMap((b) => [b, ...ACCENTS.map((a) => `${b}-${a}`)]);
}

/** A `--theme` value that names a registry item rather than a base/accent pair. */
function isRegistryRef(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.toLowerCase().endsWith(".json");
}

/**
 * Load a `registry:theme` item from a URL or a local path.
 *
 * Both go through the same parse and the same {@link themeFromRegistryItem}
 * validation, so a theme behaves identically whether it was fetched from
 * ui.shadcn.com, from a team's private registry, or from a file someone
 * exported from tweakcn.
 *
 * Failures name the source and what was expected. A scaffold is a one-shot
 * command someone runs once per project, so "could not read your theme" has to
 * be actionable on the first read — there is no iterate-and-retry loop here the
 * way there is with a dev server.
 */
export async function loadRegistryTheme(ref: string): Promise<Theme> {
  if (/^https?:\/\//i.test(ref)) {
    let res: Response;
    try {
      res = await fetch(ref, { headers: { accept: "application/json" } });
    } catch (err) {
      throw new Error(
        `Could not fetch the theme at ${ref}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) throw new Error(`Could not fetch the theme at ${ref}: ${statusLabel(res)}`);
    const text = await res.text();
    return themeFromRegistryItem(parseJson(text, ref), ref);
  }
  const path = resolvePath(ref);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read the theme file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return themeFromRegistryItem(parseJson(text, path), path);
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON — a registry theme is a JSON registry item.`);
  }
}

/** A `--theme` value, whichever of the two forms it takes. */
async function themeFromFlag(raw: string): Promise<Theme> {
  return isRegistryRef(raw.trim())
    ? loadRegistryTheme(raw.trim())
    : flagValue(raw, themeIds(), () => resolveThemeFlag(raw));
}

/**
 * The theme half of the scaffold questionnaire, as one call.
 *
 * `--radius` and `--dark` are independent of how the palette was chosen — they
 * apply to a flag and an imported registry theme alike — so they are resolved
 * here rather than folded into either path.
 *
 * Nothing in here prompts: every part of the look is a flag with a default that
 * is already right, and the scaffolded project is where it gets tuned.
 */
export async function resolveThemeChoice(args: {
  theme?: ParsedArgs["theme"];
  radius?: ParsedArgs["radius"];
  dark?: ParsedArgs["dark"];
  font?: ParsedArgs["font"];
  fontMono?: ParsedArgs["fontMono"];
  fontHeading?: ParsedArgs["fontHeading"];
  icons?: ParsedArgs["icons"];
}): Promise<ThemeChoice> {
  const dark: DarkMode = args.dark === undefined || args.dark === ""
    ? DEFAULT_DARK_MODE
    : flagValue(args.dark, DARK_MODES, () => resolveDarkModeFlag(args.dark!));

  // Fonts and icons resolve alongside dark mode: independent of how the palette
  // was chosen, so they apply to a flag and an imported registry theme alike.
  const fonts: FontChoice = {
    ...(args.font !== undefined && args.font !== "" ? { sans: fontFlag(args.font, "sans") } : {}),
    ...(args.fontMono !== undefined && args.fontMono !== "" ? { mono: fontFlag(args.fontMono, "mono") } : {}),
    ...(args.fontHeading !== undefined && args.fontHeading !== ""
      ? { heading: fontFlag(args.fontHeading, "heading") }
      : {}),
  };
  const icons: IconLibraryId | undefined =
    args.icons === undefined || args.icons === ""
      ? undefined
      : flagValue(args.icons, ICON_LIBRARIES, () => resolveIconsFlag(args.icons!)).id;

  let theme: Theme =
    args.theme !== undefined && args.theme !== ""
      ? await themeFromFlag(args.theme)
      : defaultThemeChoice().theme;

  if (args.radius !== undefined && args.radius !== "") {
    theme = withRadius(theme, flagValue(args.radius, [], () => normalizeRadius(args.radius!)));
  }
  // An empty font choice is omitted rather than passed as `{}` — `fonts` being
  // absent is what "the system stack" means, and an empty object would read as
  // a deliberate but incomplete selection to anything inspecting the choice.
  return {
    theme,
    dark,
    ...(Object.keys(fonts).length === 0 ? {} : { fonts }),
    ...(icons === undefined ? {} : { icons }),
  };
}
