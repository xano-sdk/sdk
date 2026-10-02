/**
 * `@xano/sdk/scaffold` — the scaffold's visual vocabulary, as data.
 *
 * Everything a tool needs to OFFER the choices `xanosdk init` accepts, without
 * running it: the base colors and accents and how they compose, the typefaces,
 * the icon libraries, the frontend frameworks, and the validators that turn a
 * raw string into one of them.
 *
 * It exists for `@xano-sdk/onboard`, which renders those choices in a browser and
 * then hands the answer back to `init`. The alternative — a second copy of the
 * palette living in the onboarding app — is a copy that drifts, and the failure
 * mode is a preview that shows one thing and a scaffold that writes another.
 * One table, two readers.
 *
 * Browser-safe by construction: every module behind this entry is pure data and
 * string building, so a bundler can pull it into a client app. The resolvers
 * that read a TTY or a URL deliberately stay out — those live in
 * `theme-resolve.ts`, which is Node-only and reached through the CLI.
 */

export {
  // Colors
  ACCENTS,
  BASE_COLORS,
  CURATED_THEMES,
  DEFAULT_BASE_COLOR,
  DEFAULT_RADIUS,
  buildTheme,
  colorTokens,
  curatedThemes,
  defaultTheme,
  defaultThemeChoice,
  isAccent,
  isBaseColor,
  normalizeRadius,
  orderedTokens,
  parseColor,
  resolveThemeFlag,
  themeFromRegistryItem,
  themeSwatch,
  withRadius,
  // Dark mode
  DARK_MODES,
  DEFAULT_DARK_MODE,
  resolveDarkModeFlag,
  // Fonts
  FONT_IDS,
  describeFonts,
  findFont,
  fontDependencies,
  fontImports,
  fontThemeVars,
  resolveFontFlag,
  // Agent-facing prose, so a tool can preview what the scaffold will write
  themeGuidanceSection,
} from "./emit/theme-presets.js";

export type {
  AccentId,
  BaseColorId,
  DarkMode,
  FontChoice,
  FontId,
  Rgb,
  Theme,
  ThemeChoice,
} from "./emit/theme-presets.js";

export { FONTS } from "./emit/generated/shadcn-fonts.generated.js";
export type { FontDefinition } from "./emit/generated/shadcn-fonts.generated.js";

export { BASE_TOKENS, ACCENT_TOKENS, TOKEN_ORDER } from "./emit/generated/shadcn-themes.generated.js";
export type { ThemeTokens } from "./emit/generated/shadcn-themes.generated.js";

export {
  DEFAULT_ICON_LIBRARY,
  ICON_LIBRARIES,
  allIconLibraries,
  defaultIconLibrary,
  findIconLibrary,
  iconLibraryOf,
  resolveIconsFlag,
} from "./emit/icon-presets.js";

export type { IconBinding, IconLibrary, IconLibraryId } from "./emit/icon-presets.js";

export {
  DEFAULT_FRAMEWORK,
  FRAMEWORKS,
  allFrontendPresets,
  findFrontendPreset,
  resolveFrameworkFlag,
} from "./emit/frontend-presets.js";

export type { FrameworkId, FrontendPreset } from "./emit/frontend-presets.js";

/**
 * The stylesheet a choice renders to.
 *
 * Exported so a configurator can show the exact CSS the scaffold will write,
 * and — more usefully — inject it into a live preview. A preview built from
 * separately-assembled tokens is a preview of something the scaffold does not
 * produce.
 */
export { renderIndexCss } from "./emit/init-templates.js";
