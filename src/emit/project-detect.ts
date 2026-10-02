/**
 * Reading a scaffolded project's own choices back off disk.
 *
 * `refreshAgentFiles` re-renders a managed block in a project it did not
 * scaffold, in a process that never saw the flags `xanosdk init` was run with.
 * Nothing records those choices, so a refresh that renders defaults states the
 * DEFAULTS as fact: a Mist Red SvelteKit project gets a brief claiming Neutral
 * and React. That is worse than a stale block — a stale block is old truth, and
 * this is current-looking falsehood inside the file an agent is told to trust,
 * which no hand-fix survives because the next refresh overwrites it again.
 *
 * So the choices are recovered from the artifacts that carry them:
 *
 * | Choice    | Read from                                                    |
 * | --------- | ------------------------------------------------------------ |
 * | framework | `package.json` dependencies, matched against each preset's    |
 * | icons     | `package.json` dependencies, matched against each library's   |
 * | theme     | the `Theme:` header comment `renderIndexCss` writes           |
 * | dark mode | `frontend/src/lib/theme.ts`, else the entry document's script |
 *
 * Every reader returns `undefined` rather than a guess when the artifact is
 * missing or unrecognizable, and the caller keeps its existing default in that
 * case. This is deliberate: detection exists to stop the brief asserting things
 * about a project it cannot see, so it must never invent one more.
 *
 * Node-only (node:fs), imported by the refresh path only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allFrontendPresets, type FrontendPreset } from "./frontend-presets.js";
import { allIconLibraries, type IconLibraryId } from "./icon-presets.js";
import { DEFAULT_DARK_MODE, type DarkMode } from "./theme-presets.js";
import type { FrontendGuidance } from "./init-ai-presets.js";

/** Parse a JSON file, or `undefined` when it is missing or not JSON. */
function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read a file, or `undefined` when it is missing or unreadable. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Every package name in a project's `package.json`, both dependency blocks. */
function installedPackages(projectDir: string): Set<string> {
  const pkg = readJson(join(projectDir, "package.json"));
  const names = new Set<string>();
  for (const block of ["dependencies", "devDependencies"] as const) {
    const deps = pkg?.[block];
    if (typeof deps === "object" && deps !== null) {
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return names;
}

/**
 * Which preset scaffolded this project, by what FRACTION of each preset's
 * declared dependencies are installed.
 *
 * Scoring off the whole dependency list rather than one marker package keeps
 * this correct as presets gain and lose dependencies. Scoring the fraction
 * rather than the raw count is what makes the comparison fair: presets declare
 * different numbers of dependencies, so a count would hand the win to whichever
 * list is longest in a project that carries both — the exact case the tie-break
 * is for. A tie declines, because two presets fitting equally well is precisely
 * where a pick would be a guess, and a guessed framework renders bullets naming
 * imports and paths that do not exist in the project reading them.
 */
export function detectFrontendPreset(projectDir: string): FrontendPreset | undefined {
  const installed = installedPackages(projectDir);
  if (installed.size === 0) return undefined;

  let best: FrontendPreset | undefined;
  let bestScore = 0;
  let tied = false;
  for (const preset of allFrontendPresets()) {
    const declared = Object.keys(preset.dependencies);
    if (declared.length === 0) continue;
    const score = declared.filter((name) => installed.has(name)).length / declared.length;
    if (score > bestScore) {
      best = preset;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }
  return bestScore > 0 && !tied ? best : undefined;
}

/**
 * Which icon library is installed, across every framework's package for it.
 *
 * Framework-agnostic on purpose: the caller may not have resolved a preset, and
 * a project's icon package identifies the library on its own.
 */
export function detectIconLibrary(projectDir: string): IconLibraryId | undefined {
  const installed = installedPackages(projectDir);
  for (const library of allIconLibraries()) {
    for (const binding of [library.react, library.svelte]) {
      if (Object.keys(binding.dependency).some((name) => installed.has(name))) return library.id;
    }
  }
  return undefined;
}

/**
 * The theme label from the header `renderIndexCss` writes above the tokens.
 *
 * The label is read back verbatim rather than resolved to a {@link Theme},
 * because a theme can come from the shadcn registry (any title) and a user is
 * invited to rebrand in place. What the stylesheet says it is IS what the
 * project's theme is, and the brief's job is to repeat that, not to adjudicate.
 */
export function detectThemeLabel(projectDir: string): string | undefined {
  const css = readText(join(projectDir, "frontend", "src", "index.css"));
  const match = css?.match(/\/\*\s*Theme:\s*(.+?)\.\s*Rebrand here/);
  const label = match?.[1]?.trim();
  return label !== undefined && label.length > 0 ? label : undefined;
}

/**
 * Which dark-mode variant the scaffold wrote.
 *
 * `frontend/src/lib/theme.ts` is written for `toggle` and nothing else, so its
 * presence settles the question. Otherwise the entry document decides: the
 * inline pre-paint script is `system`, and `off` renders no script at all.
 * Both entry paths are checked because which one exists is the preset's
 * business (`ownsHtmlEntry`), and this must not need the preset to answer.
 */
export function detectDarkMode(projectDir: string): DarkMode | undefined {
  if (existsSync(join(projectDir, "frontend", "src", "lib", "theme.ts"))) return "toggle";
  const entries = [
    join(projectDir, "frontend", "index.html"),
    join(projectDir, "frontend", "src", "app.html"),
  ];
  for (const entry of entries) {
    const html = readText(entry);
    if (html === undefined) continue;
    return html.includes("prefers-color-scheme") ? "system" : "off";
  }
  return undefined;
}

/**
 * The frontend half of the agent brief, describing THIS project.
 *
 * Returns `undefined` when the framework cannot be identified — the framework
 * is what the whole section is written against, so a project without one has
 * nothing here to be right about and the caller's default stands. The theme and
 * dark mode fall back individually, since a recognized framework with an
 * unreadable stylesheet still deserves its framework bullets.
 */
export function detectFrontendGuidance(projectDir: string): FrontendGuidance | undefined {
  const preset = detectFrontendPreset(projectDir);
  if (preset === undefined) return undefined;
  const label = detectThemeLabel(projectDir);
  return {
    label: preset.label,
    section: preset.agentGuidanceSection(detectIconLibrary(projectDir)),
    ...(label === undefined
      ? {}
      : { theme: { theme: { label }, dark: detectDarkMode(projectDir) ?? DEFAULT_DARK_MODE } }),
  };
}
