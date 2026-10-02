/**
 * Theme presets — the seam that lets `xanosdk init` scaffold a project that does
 * not look like every other shadcn/ui scaffold.
 *
 * shadcn/ui components carry no colors of their own: every one of them is
 * Tailwind utilities over a fixed set of semantic custom properties
 * (`bg-primary`, `text-muted-foreground`, `border-input`, …). Choosing a theme
 * is therefore choosing the VALUES of ~32 custom properties, and nothing else —
 * no component is edited, no dependency is added, and `npx shadcn@latest add
 * <name>` keeps working afterwards because the component it writes reads the
 * same names.
 *
 * Upstream composes those values from two registry items rather than one
 * (`apps/v4/app/(app)/(create)/lib/merge-theme.ts`):
 *
 *   base color  — all 32 tokens, a grayscale ramp plus a shared destructive red
 *   accent      — 11 of them, the ones that read as "the brand"
 *
 * and merges them with a shallow per-mode spread. {@link buildTheme} is that
 * same spread, so a `zinc-blue` scaffold is byte-identical to what
 * ui.shadcn.com hands out for the same pair. 7 bases × (17 accents + none) is
 * 126 themes from two small tables, which is why they are composed here rather
 * than pre-multiplied in the generated file.
 *
 * {@link themeFromRegistryItem} is the escape hatch: any `registry:theme` JSON —
 * shadcn's own, tweakcn's, a design team's private registry — is the same
 * light/dark token map under a schema, so it lands as a {@link Theme} too.
 *
 * Browser-safe: pure string building and arithmetic, no node:* imports. The
 * flag parsing that reads a URL lives in `theme-resolve.ts`, mirroring the `frontend-presets` / `frontend-resolve`
 * split.
 */
import { withArticle } from "../util/article.js";
import {
  ACCENT_TOKENS,
  BASE_TOKENS,
  TOKEN_ORDER,
} from "./generated/shadcn-themes.generated.js";
import { FONTS } from "./generated/shadcn-fonts.generated.js";
import type { IconLibraryId } from "./icon-presets.js";

/** Every base color, in upstream order — the complete-token half of a theme. */
export const BASE_COLORS = Object.keys(BASE_TOKENS) as readonly BaseColorId[];

export type BaseColorId = keyof typeof BASE_TOKENS;

/** Every accent, in upstream order — the partial, brand-carrying half. */
export const ACCENTS = Object.keys(ACCENT_TOKENS) as readonly AccentId[];

export type AccentId = keyof typeof ACCENT_TOKENS;

/** The base color a scaffold gets when nothing selects one: plain shadcn/ui. */
export const DEFAULT_BASE_COLOR: BaseColorId = "neutral";

/**
 * How the scaffold treats dark mode.
 *
 * Every base color ships a full dark palette and every shadcn component is
 * written for both, so the tokens are there whatever this says — the only
 * question is what puts `class="dark"` on `<html>`.
 *
 * `system` follows the OS setting with no UI. `toggle` adds that plus a control
 * and a remembered preference. `off` writes light-only, which is what the
 * scaffold did before this existed.
 */
export const DARK_MODES = ["system", "toggle", "off"] as const;

export type DarkMode = (typeof DARK_MODES)[number];

/**
 * The radius every upstream base color declares, and the fallback for an
 * imported theme that declares none. Read from the table rather than written as
 * a literal, so it cannot drift from what a default scaffold gets.
 */
export const DEFAULT_RADIUS: string = BASE_TOKENS[DEFAULT_BASE_COLOR].light.radius ?? "0.625rem";

/** Dark handling when nothing selects it. Following the OS is the modern default. */
export const DEFAULT_DARK_MODE: DarkMode = "system";

/** A resolved theme: a label, the two token maps, and where it came from. */
export interface Theme {
  /** Stable id — `neutral`, `zinc-blue`, or an imported item's registry name. */
  readonly id: string;
  /** Human label for prose and any theme picker, e.g. `Zinc Blue`. */
  readonly label: string;
  /**
   * The base color this theme was built from, for `components.json`'s
   * `tailwind.baseColor`. The shadcn CLI reads it to decide which palette a
   * newly added component's *hard-coded* colors come from (the handful that are
   * not tokens), so a scaffold whose stylesheet says one thing and whose
   * `components.json` says another produces components that clash with it.
   *
   * `null` for an imported registry theme, whose tokens belong to no upstream
   * base — the caller then falls back to the CLI's own default rather than
   * claiming a base color the palette does not match.
   */
  readonly baseColor: BaseColorId | null;
  /** `:root` tokens, without the leading `--`. */
  readonly light: Readonly<Record<string, string>>;
  /** `.dark` tokens, without the leading `--`. */
  readonly dark: Readonly<Record<string, string>>;
}

/** Every typeface `--font`/`--font-mono`/`--font-heading` accept. */
export const FONT_IDS = Object.keys(FONTS) as readonly FontId[];

export type FontId = keyof typeof FONTS;

/**
 * The typefaces a scaffold sets, by the Tailwind slot each fills.
 *
 * All three are optional and all three default to ABSENT rather than to a
 * named face. Tailwind v4 already ships a system stack for every slot, and a
 * scaffold that names no font is both faster (no font files) and neutral (it
 * looks native on every platform) — which is what shadcn's own starter does.
 * So `undefined` here is a real choice, not a missing value.
 */
export interface FontChoice {
  /** Body text — Tailwind's `--font-sans`, which v4 also uses as the page default. */
  readonly sans?: FontId;
  /** Code — Tailwind's `--font-mono`. */
  readonly mono?: FontId;
  /**
   * Headings. Not a Tailwind slot: it emits `--font-heading` plus a base-layer
   * rule binding `h1`–`h6` to it, because a display face applied to body text
   * is unreadable and applied by hand to every heading is forgotten.
   *
   * Absent means headings inherit the body face, which is the common case.
   */
  readonly heading?: FontId;
}

/** A theme plus how the scaffold switches into its dark half. */
export interface ThemeChoice {
  readonly theme: Theme;
  readonly dark: DarkMode;
  /**
   * Typefaces. Optional so every caller that predates fonts — and every test of
   * the color half — keeps compiling; absent means the system stack.
   */
  readonly fonts?: FontChoice;
  /**
   * The icon set, resolved against `icon-presets.ts`. Optional for the same
   * reason; absent means Lucide, which is what shadcn/ui defaults to.
   */
  readonly icons?: IconLibraryId;
}

/** Look up a typeface, or `undefined` when the id is not one. */
export function findFont(id: string): FontId | undefined {
  const normalized = id.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(FONTS, normalized)
    ? (normalized as FontId)
    : undefined;
}

/**
 * Validate a font flag. `slot` names which of `--font` / `--font-mono` /
 * `--font-heading` is being resolved, so the error says which one to fix.
 *
 * A face is refused for a slot it cannot fill: `--font-mono lora` would emit a
 * serif as the code font, which is a mistake nothing downstream can catch.
 * `--font-heading` accepts anything, because a display serif over a sans body
 * is a legitimate and common pairing.
 */
export function resolveFontFlag(raw: string, slot: FontSlot): FontId {
  const id = findFont(raw);
  if (id === undefined) {
    throw new Error(
      `Unknown font "${raw}" for \`${FONT_SLOT_FLAGS[slot]}\`. Valid: ${fontIdsFor(slot).join(", ")}.`,
    );
  }
  if (!fontIdsFor(slot).includes(id)) {
    const type = FONTS[id].type;
    // A mono face goes to --font-mono, a sans one to the body's --font; a serif
    // one only fills --font-heading.
    const right: FontSlot = type === "mono" ? "mono" : type === "sans" ? "sans" : "heading";
    throw new Error(
      `"${raw}" is ${withArticle(type)} face, so \`${FONT_SLOT_FLAGS[slot]}\` (the ${slot} slot) cannot take it — ` +
        `pass it as \`${FONT_SLOT_FLAGS[right]} ${id}\`. Valid for \`${FONT_SLOT_FLAGS[slot]}\`: ${fontIdsFor(slot).join(", ")}.`,
    );
  }
  return id;
}

/** The three font slots `init` fills. */
export type FontSlot = "sans" | "mono" | "heading";

/** The flag that fills each slot. */
export const FONT_SLOT_FLAGS: Readonly<Record<FontSlot, string>> = {
  sans: "--font",
  mono: "--font-mono",
  heading: "--font-heading",
};

/**
 * The faces a slot accepts: `--font` sans faces only, `--font-mono` mono faces
 * only, `--font-heading` any face — a display serif over a sans body is a
 * legitimate pairing.
 */
export function fontIdsFor(slot: FontSlot): readonly FontId[] {
  return slot === "heading" ? FONT_IDS : FONT_IDS.filter((f) => FONTS[f].type === slot);
}

/** The npm packages a font choice adds — one `@fontsource-*` per named face. */
export function fontDependencies(fonts: FontChoice | undefined): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const id of [fonts?.sans, fonts?.mono, fonts?.heading]) {
    // Deduplicated by construction: the same face in two slots is one package,
    // and `@import`ing it twice would ship the files twice.
    if (id !== undefined) deps[FONTS[id].dependency] = "*";
  }
  return deps;
}

/**
 * The `@import` lines that load the chosen faces, before Tailwind's own.
 *
 * Self-hosted through the fontsource packages rather than fetched from
 * fonts.googleapis.com: a CDN link is a third-party request on every page load
 * of the user's app, it fails behind a firewall, and it is a privacy question
 * someone inherits later. Vite resolves a bare specifier in a CSS `@import`
 * through the same resolver it uses for JS, so this needs no plugin.
 */
export function fontImports(fonts: FontChoice | undefined): string[] {
  return Object.keys(fontDependencies(fonts)).map((pkg) => `@import "${pkg}";`);
}

/** The `@theme` entries a font choice contributes, in Tailwind slot order. */
export function fontThemeVars(fonts: FontChoice | undefined): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (fonts?.sans !== undefined) rows.push(["--font-sans", FONTS[fonts.sans].family]);
  if (fonts?.mono !== undefined) rows.push(["--font-mono", FONTS[fonts.mono].family]);
  if (fonts?.heading !== undefined) rows.push(["--font-heading", FONTS[fonts.heading].family]);
  return rows;
}

/** A human label for a font choice, e.g. `Geist / Instrument Serif headings`. */
export function describeFonts(fonts: FontChoice | undefined): string {
  const parts: string[] = [];
  if (fonts?.sans !== undefined) parts.push(FONTS[fonts.sans].label);
  if (fonts?.heading !== undefined) parts.push(`${FONTS[fonts.heading].label} headings`);
  if (fonts?.mono !== undefined) parts.push(`${FONTS[fonts.mono].label} mono`);
  return parts.length === 0 ? "system" : parts.join(" / ");
}

/**
 * Compose a base color with an optional accent, exactly as upstream's
 * `buildTheme` does: a shallow spread of the accent's partial map over the
 * base's complete one, per mode.
 *
 * Shallow is the whole point. An accent names `primary` and leaves `background`
 * alone precisely so that the neutral chrome keeps coming from the base, and
 * anything cleverer here (blending, deriving a foreground) would produce
 * colors that upstream's own preview never shows.
 */
export function buildTheme(base: BaseColorId, accent: AccentId | null): Theme {
  const b = BASE_TOKENS[base];
  if (accent === null) {
    return { id: base, label: b.label, baseColor: base, light: b.light, dark: b.dark };
  }
  const a = ACCENT_TOKENS[accent];
  return {
    id: `${base}-${accent}`,
    label: `${b.label} ${a.label}`,
    baseColor: base,
    light: { ...b.light, ...a.light },
    dark: { ...b.dark, ...a.dark },
  };
}

/** The theme a scaffold gets when nothing selects one. */
export function defaultTheme(): Theme {
  return buildTheme(DEFAULT_BASE_COLOR, null);
}

/** The full default: plain shadcn/ui, following the OS for dark mode. */
export function defaultThemeChoice(): ThemeChoice {
  return { theme: defaultTheme(), dark: DEFAULT_DARK_MODE };
}

/**
 * Override a theme's corner radius — the one token that is a length rather than
 * a color, and the one most likely to be wanted independently of the palette.
 *
 * Accepts a bare number as rem (`--radius 0` and `--radius 1` are what people
 * type) or any CSS length verbatim.
 */
export function withRadius(theme: Theme, radius: string): Theme {
  return { ...theme, light: { ...theme.light, radius } };
}

/**
 * Normalise a `--radius` value: a bare number becomes rem, anything with a unit
 * passes through, and anything else is a hard error rather than a stylesheet
 * that silently drops the declaration.
 */
export function normalizeRadius(raw: string): string {
  const value = raw.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return `${value}rem`;
  if (/^\d+(\.\d+)?(rem|px|em)$/.test(value)) return value;
  throw new Error(
    `Invalid --radius "${raw}". Pass a number of rem (e.g. 0, 0.5, 1) or a CSS length (e.g. 8px).`,
  );
}

/**
 * Parse a `--theme` id: `<base>` or `<base>-<accent>`.
 *
 * Split on the LAST hyphen, and only when the tail is a known accent — no base
 * or accent name contains one today, but reading it as "everything before the
 * accent" keeps a future `warm-gray` base from being parsed as a base `warm`
 * with an unknown accent.
 *
 * An unknown value is a hard error naming both halves' valid values, mirroring
 * `--framework`. Someone typing `--theme blue` (an accent, not a
 * base) is the common near-miss, so the message says which side each name is
 * on rather than printing one undifferentiated list.
 */
export function resolveThemeFlag(raw: string): Theme {
  const value = raw.trim().toLowerCase();
  const cut = value.lastIndexOf("-");
  if (cut > 0) {
    const base = value.slice(0, cut);
    const accent = value.slice(cut + 1);
    if (isBaseColor(base) && isAccent(accent)) return buildTheme(base, accent);
  }
  if (isBaseColor(value)) return buildTheme(value, null);
  throw new Error(
    `Unknown --theme "${raw}". Pass <base> or <base>-<accent>, ` +
      `a registry theme URL, or a path to a registry item JSON file.\n` +
      `  Base colors: ${BASE_COLORS.join(", ")}\n` +
      `  Accents:     ${ACCENTS.join(", ")}`,
  );
}

export function isBaseColor(id: string): id is BaseColorId {
  return Object.prototype.hasOwnProperty.call(BASE_TOKENS, id);
}

export function isAccent(id: string): id is AccentId {
  return Object.prototype.hasOwnProperty.call(ACCENT_TOKENS, id);
}

/** Validate a `--dark` value, mirroring the other scaffold flags' hard errors. */
export function resolveDarkModeFlag(raw: string): DarkMode {
  const value = raw.trim().toLowerCase();
  if ((DARK_MODES as readonly string[]).includes(value)) return value as DarkMode;
  throw new Error(`Unknown --dark "${raw}". Valid modes: ${DARK_MODES.join(", ")}.`);
}

/**
 * The shortlist: a short, opinionated set for anyone offering a theme picker
 * over this module, rather than all 126 combinations.
 *
 * The full space stays reachable — `--theme` takes any `<base>-<accent>` or
 * registry URL — so this list is a shortcut, not the supported set. One entry
 * per base color, each paired with an accent that suits its temperature, shows
 * what every base looks like in one screen.
 */
export const CURATED_THEMES: readonly string[] = [
  "neutral",
  "zinc-blue",
  "neutral-violet",
  "stone-orange",
  "mist-teal",
  "olive-green",
  "taupe-rose",
  "mauve-purple",
];

/** {@link CURATED_THEMES}, resolved. Throws at import time if an id ever rots. */
export function curatedThemes(): Theme[] {
  return CURATED_THEMES.map(resolveThemeFlag);
}

/**
 * The `cssVars` block of a shadcn registry item, as the parts we read.
 *
 * Deliberately loose: registries in the wild carry extra fields (`$schema`,
 * `dependencies`, `files`), and rejecting an item for having them would fail on
 * themes that work perfectly.
 */
interface RegistryItemLike {
  name?: unknown;
  title?: unknown;
  type?: unknown;
  cssVars?: {
    theme?: Record<string, unknown>;
    light?: Record<string, unknown>;
    dark?: Record<string, unknown>;
  };
}

/**
 * Turn a shadcn `registry:theme` item into a {@link Theme}.
 *
 * Two normalisations, both of which decide whether an imported theme actually
 * renders:
 *
 * 1. `cssVars.theme` (mode-independent tokens, where `radius` usually lives) is
 *    folded into BOTH modes. It is a separate bucket upstream because the CLI
 *    writes it into `@theme` rather than `:root`; we render one token block per
 *    mode, so a value left in that bucket would be dropped entirely.
 * 2. Bare HSL triples (`"240 5% 6%"`) are wrapped in `hsl()`. Themes authored
 *    against shadcn's Tailwind v3 era emit them, because v3's config wrapped
 *    them for you. Written raw into a v4 stylesheet, `--primary: 240 5% 6%` is
 *    a valid custom property holding a value that is not a color, so every
 *    control using it renders with no color at all and nothing reports an
 *    error.
 *
 * A missing `radius` is filled in with the default. The stylesheet's
 * `@theme inline` block derives `--radius-sm/md/lg/xl` from `--radius`, and
 * `Button` and `Card` are already using them — so importing one of shadcn's own
 * legacy theme JSONs (none of which carry a radius) would otherwise produce a
 * scaffold whose two starter components have square corners for no stated
 * reason.
 *
 * `source` names where the JSON came from, for the error message and the
 * generated stylesheet's provenance comment.
 */
export function themeFromRegistryItem(raw: unknown, source: string): Theme {
  const item = raw as RegistryItemLike;
  const vars = item?.cssVars;
  if (vars === undefined || vars === null || typeof vars !== "object") {
    throw new Error(
      `${source} is not a shadcn registry theme: no "cssVars" object. ` +
        `Expected a registry item with cssVars.light / cssVars.dark ` +
        `(see https://ui.shadcn.com/schema/registry-item.json).`,
    );
  }
  const shared = normalizeVars(vars.theme);
  const light = { ...shared, ...normalizeVars(vars.light) };
  const dark = { ...shared, ...normalizeVars(vars.dark) };
  if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) {
    throw new Error(`${source} defines no CSS variables under cssVars.`);
  }
  // After the emptiness check, not before: an item with no tokens at all is a
  // mistake worth reporting, and filling in a radius first would turn it into a
  // theme that renders every surface transparent instead.
  light["radius"] ??= DEFAULT_RADIUS;
  const name = typeof item.name === "string" && item.name !== "" ? item.name : "custom";
  const title = typeof item.title === "string" && item.title !== "" ? item.title : name;
  // An imported palette is not one of the upstream base colors, so it cannot
  // honestly claim one — see Theme.baseColor.
  return { id: name, label: title, baseColor: null, light, dark };
}

/** Bare HSL triple, as shadcn's Tailwind-v3-era themes emit it. */
const HSL_TRIPLE = /^-?\d*\.?\d+\s+-?\d*\.?\d+%\s+-?\d*\.?\d+%$/;

/** Coerce one registry `cssVars` bucket to string values, wrapping bare HSL. */
function normalizeVars(vars: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars ?? {})) {
    if (typeof value !== "string") continue;
    const name = key.replace(/^--/, "");
    out[name] = HSL_TRIPLE.test(value.trim()) ? `hsl(${value.trim()})` : value;
  }
  return out;
}

/**
 * Order a theme's tokens for rendering: the upstream order first, then anything
 * an imported theme adds, alphabetically.
 *
 * Upstream order is not alphabetical — it groups surfaces, then intent, then
 * the chart ramp, then the sidebar — and matching it means a scaffold's
 * stylesheet can be read side by side with shadcn's docs. `radius` is the one
 * token hoisted out of that order: it sits between the chart ramp and the
 * sidebar in the registry, where it reads as an afterthought, and first in
 * every stylesheet shadcn's own docs show. An imported theme may carry tokens
 * outside the set entirely (a custom `--brand`), and those are kept: they are
 * what someone chose that theme for.
 */
export function orderedTokens(vars: Readonly<Record<string, string>>): Array<[string, string]> {
  const order = ["radius", ...TOKEN_ORDER.filter((k) => k !== "radius")];
  const known = order.filter((k) => k in vars).map((k) => [k, vars[k]!] as [string, string]);
  const extra = Object.keys(vars)
    .filter((k) => !(TOKEN_ORDER as readonly string[]).includes(k))
    .sort()
    .map((k) => [k, vars[k]!] as [string, string]);
  return [...known, ...extra];
}

/**
 * The token names the `@theme inline` block maps into Tailwind's color scale.
 *
 * Tailwind v4 resolves `bg-primary` from `--color-primary`, so every color
 * token needs a `--color-*` alias pointing at it — but `radius` must NOT get
 * one (it is a length, and `--color-radius` would put a bogus entry in the
 * color scale that shows up in editor autocomplete).
 */
export function colorTokens(vars: Readonly<Record<string, string>>): string[] {
  return orderedTokens(vars)
    .map(([k]) => k)
    .filter((k) => k !== "radius");
}

/**
 * What this section actually needs of a theme: its name, and how dark mode is
 * wired. Narrower than {@link ThemeChoice} (which every scaffold caller passes,
 * and which satisfies this) so a caller that RECOVERED a theme from a project on
 * disk can describe it without fabricating token values it never read — see
 * `project-detect.ts`. A label lifted from a stylesheet is a fact; a palette
 * reconstructed around it would not be.
 */
export interface ThemeGuidance {
  readonly theme: { readonly label: string };
  readonly dark: DarkMode;
}

/**
 * The theme bullets in the scaffolded AI-assistant brief, appended to whatever
 * the frontend preset contributes.
 *
 * Shared across frameworks because the rule is: both kits read the same token
 * names out of the same stylesheet. Two failures it exists to prevent, both of
 * which produce code that compiles and looks fine in the one screenshot the
 * author checks:
 *
 * - Reaching for raw palette classes (`bg-gray-100`, `text-slate-500`). They
 *   are stable in light mode and unreadable in dark, and they silently opt that
 *   component out of the theme forever.
 * - Installing a theme library. `next-themes` is what the training data
 *   suggests, and in a scaffold that already persists and applies the mode it
 *   is a second source of truth for one boolean.
 */
export function themeGuidanceSection(choice: ThemeGuidance): string {
  const { theme, dark } = choice;
  const darkBullet = {
    system: `  - Dark mode follows the OS: an inline script in the HTML entry sets the
    \`dark\` class before first paint. There is no in-app switcher — if you are
    asked for one, add a control that toggles that class on
    \`document.documentElement\` and persists the choice; do not install a theming
    library for it.`,
    toggle: `  - Dark mode is already wired: \`frontend/src/lib/theme.ts\` holds the mode
    (\`getMode\`/\`setMode\`/\`watchMode\`), an inline script in the HTML entry applies
    it before first paint, and the mode toggle on the landing page cycles
    system → light → dark. Use that module — do not add \`next-themes\` or a second
    class-toggling implementation.`,
    off: `  - This project has no dark-mode switch (scaffolded with \`--dark off\`), but
    the \`.dark\` palette in the stylesheet is complete. To turn it on, apply the
    \`dark\` class to \`document.documentElement\` — do not install a theming library.`,
  }[dark];

  return `  - Theme: **${theme.label}**, defined as CSS custom properties at the top of
    \`frontend/src/index.css\`. That file is the entire theme — Tailwind v4 has no
    \`tailwind.config.js\`.
  - Use the semantic token classes only: \`bg-background\`, \`text-foreground\`,
    \`bg-primary\`, \`text-muted-foreground\`, \`border-input\`, \`bg-card\`,
    \`bg-destructive\`, and the \`chart-1..5\` / \`sidebar-*\` sets.
    NEVER raw palette classes (\`bg-gray-100\`, \`text-slate-500\`) — they ignore the
    theme and are unreadable in dark mode, and nothing will report it.
  - Rebranding means editing token VALUES in that stylesheet, never editing
    components to hard-code a color.
${darkBullet}`;
}

// ── Terminal swatches ────────────────────────────────────────────────────────

/** An sRGB triple, 0–255, for painting a theme swatch. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * The colors that identify a theme at a glance in a picker: the primary, the
 * page background, and a muted midtone.
 *
 * Three is the smallest set that distinguishes the menu's entries — the accent
 * alone would make every base look identical, and the background alone would
 * make every accent look identical.
 */
export function themeSwatch(theme: Theme): Rgb[] {
  return ["primary", "accent", "muted-foreground"]
    .map((token) => theme.light[token])
    .map((value) => (value === undefined ? null : parseColor(value)))
    .filter((rgb): rgb is Rgb => rgb !== null);
}

/**
 * Parse the color notations a theme's tokens actually use into sRGB.
 *
 * Only what we emit or import needs to work: oklch (every upstream token), hsl
 * (imported v3-era themes, after {@link normalizeVars} wraps them), and hex.
 * Anything else returns `null` and the caller simply draws no swatch — a
 * terminal decoration is never worth failing a scaffold over.
 */
export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  const oklch = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/.exec(v);
  if (oklch) {
    const l = oklch[1]!.endsWith("%")
      ? Number.parseFloat(oklch[1]!) / 100
      : Number.parseFloat(oklch[1]!);
    return oklchToRgb(l, Number.parseFloat(oklch[2]!), Number.parseFloat(oklch[3]!));
  }
  const hsl = /^hsl\(\s*([-\d.]+)\s*,?\s*([\d.]+)%\s*,?\s*([\d.]+)%/.exec(v);
  if (hsl) {
    return hslToRgb(
      Number.parseFloat(hsl[1]!),
      Number.parseFloat(hsl[2]!) / 100,
      Number.parseFloat(hsl[3]!) / 100,
    );
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
    };
  }
  return null;
}

/** Clamp to a byte. */
function byte(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}

/** sRGB transfer function — linear light to the encoded value a terminal wants. */
function gamma(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Oklch → sRGB, via Oklab and linear sRGB (Björn Ottosson's matrices).
 *
 * Out-of-gamut colors are clamped per channel rather than gamut-mapped: this
 * feeds a 24-bit terminal swatch, where being a few percent off in a saturated
 * hue is invisible and the correct algorithm is fifty lines.
 */
function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const bb = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return {
    r: byte(gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: byte(gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: byte(gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  };
}

/** HSL → sRGB, for imported themes that predate oklch. */
function hslToRgb(hDeg: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((hDeg % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return { r: byte(r + m), g: byte(g + m), b: byte(b + m) };
}
