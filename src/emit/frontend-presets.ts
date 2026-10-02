/**
 * Frontend framework presets — the seam that lets `xanosdk init` and
 * `xanosdk … codegen` scaffold more than one frontend without duplicating the
 * project around it.
 *
 * The scaffold is mostly framework-agnostic: `xano/`, `frontend/src/lib/api.ts`
 * (the one contract), the Tailwind token stylesheet, `.env.example`,
 * `.gitignore`, the deploy scripts, and the `frontend/dist` static-host contract
 * are the same whatever renders the UI. A {@link FrontendPreset} contributes
 * only the parts that genuinely differ — dependencies, the Vite plugin, the
 * typecheck command, the entry module, the app component, the vendored UI kit,
 * and its slice of the README / agent-instruction prose.
 *
 * Adding a framework is therefore one new module plus one row in
 * {@link PRESETS}: no edits to `init-command.ts`, `codegen-command.ts`,
 * `scaffold.ts`, or `cli.ts`.
 *
 * Browser-safe: pure string building, no node:* imports. `resolveFrontendPreset`
 * touches `process.stdin` only through the same TTY check the AI-preset prompt
 * uses, and lives in `frontend-resolve.ts`.
 */
import type { ScaffoldFile } from "./scaffold.js";
import type { TemplateVars } from "./init-templates.js";
import type { ThemeChoice } from "./theme-presets.js";
import type { IconBinding, IconLibraryId } from "./icon-presets.js";
import { reactPreset } from "./frontend-react.js";
import { sveltePreset } from "./frontend-svelte.js";

/**
 * Every framework `--framework` accepts, in prompt/help order. The single
 * source the flag's validation error, its `--help` line, and the zsh completion
 * values all read from — so they cannot disagree about what is supported.
 */
export const FRAMEWORKS = ["react", "svelte"] as const;

export type FrameworkId = (typeof FRAMEWORKS)[number];

/** The framework a scaffold gets when nothing selects one (non-interactive runs). */
export const DEFAULT_FRAMEWORK: FrameworkId = "react";

/**
 * One piece of landing-page copy.
 *
 * `{ code }` renders inside the styled `<code>` each preset defines; `{ text }`
 * renders bare. Splitting the two lets one copy value render into JSX or Svelte
 * markup without either preset owning the wording.
 */
export type InlineNode = { readonly text: string } | { readonly code: string };

/**
 * The scaffold's landing page, as content rather than markup.
 *
 * `init` and `codegen` differ in copy; React and Svelte differ in markup.
 * Writing the copy once here and rendering it per preset keeps that a 2 + N
 * problem instead of a 2 × N one — otherwise every framework added would double
 * the number of hand-written landing pages to keep in sync.
 */
export interface LandingContent {
  readonly title: string;
  /** The lead paragraph under the title. */
  readonly lead: readonly InlineNode[];
  /** The ordered "what to do next" list. Always three items. */
  readonly steps: readonly (readonly InlineNode[])[];
  readonly cta: { readonly label: string; readonly href: string };
}

/** What one framework contributes to a scaffold. */
export interface FrontendPreset {
  readonly id: FrameworkId;
  /** Human label used in prose and in the interactive prompt. */
  readonly label: string;
  /** Runtime dependencies, merged over the shared `@xano/sdk` entry. */
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  /**
   * The command that type-checks this framework's sources, prefixed onto every
   * scaffold script. `tsc --noEmit` alone cannot see inside `.svelte` files, so
   * this is a preset contribution rather than a literal — a scaffold whose
   * components are never type-checked would silently break the SDK's promise
   * that the frontend cannot drift from the backend defs.
   */
  readonly checkCmd: string;
  /**
   * The import alias this framework's UI kit writes its imports against — `@`
   * for shadcn/ui. Declared in BOTH `tsconfig.json` and `vite.config.ts`
   * (TypeScript resolves types, Vite resolves the bundle).
   *
   * `null` when the framework supplies the alias itself: SvelteKit generates
   * both halves (`$lib` in `.svelte-kit/tsconfig.json`, and the matching Vite
   * alias from its plugin), and a hand-written duplicate is a second source of
   * truth that can silently disagree with the generated one.
   */
  readonly aliasName: string | null;
  /** What the alias points at, relative to the project root. Unused when {@link aliasName} is `null`. */
  readonly aliasTarget: string;
  /**
   * The `compilerOptions.paths` entries for this alias. A separate field rather
   * than derived from {@link aliasName}: shadcn/ui only ever imports through
   * `@/…`, while shadcn-svelte also imports the bare `$lib`, and emitting a
   * mapping a kit never uses is noise in a file users read.
   *
   * Targets are written `./`-rooted: the rendered tsconfig sets no `baseUrl`
   * (TypeScript 6 errors on it), so a target resolves against the config
   * file's own directory.
   *
   * Empty when the framework generates its own paths — `paths` is then omitted
   * from the rendered tsconfig entirely rather than emitted blank.
   */
  readonly tsconfigPaths: Readonly<Record<string, readonly string[]>>;
  /** `compilerOptions` merged over the shared base in {@link renderTsconfig}. */
  readonly tsconfigOptions: Readonly<Record<string, unknown>>;
  /**
   * The config this project's `tsconfig.json` extends, if any.
   *
   * SvelteKit generates `.svelte-kit/tsconfig.json` during `svelte-kit sync`,
   * carrying the `$lib` / `$app` / `$env` path mappings and the route types.
   * Extending it is how one root tsconfig keeps covering BOTH halves of the
   * project — the generated half plus `xano/`, which the shared `include`
   * re-declares on top.
   */
  readonly tsconfigExtends?: string;
  /**
   * Extra `include` entries appended to the shared `["xano", "frontend/src"]`.
   *
   * Required alongside {@link tsconfigExtends}, because an extended config's
   * `include` is REPLACED rather than merged: re-declaring ours on top drops
   * whatever the generated config listed. For SvelteKit that is the ambient
   * declarations behind `$app/*` and `$env/*` and the generated route types —
   * so without these, the first `import { goto } from "$app/navigation"` an
   * assistant writes fails `svelte-check`, which gates build and deploy.
   */
  readonly tsconfigInclude?: readonly string[];
  /** Import lines placed at the top of `vite.config.ts`. */
  readonly viteImports: readonly string[];
  /** Plugin call expressions spread into vite's `plugins: [...]`. */
  readonly vitePlugins: readonly string[];
  /**
   * Vite's `root`. Defaults to `"frontend"` — the folder holding `index.html`
   * and the app, with the Xano SDK backend sitting in `xano/` as a peer.
   *
   * `null` leaves `root` unset (the project root). SvelteKit resolves
   * everything against the project root and redirects
   * its own file locations into `frontend/` via `kit.files`, so moving Vite's
   * root out from under it breaks the two into disagreement.
   */
  readonly viteRoot?: string | null;
  /**
   * Vite's `build` options. Defaults to `{ outDir: "dist", emptyOutDir: true }`.
   *
   * `null` omits the block. A SvelteKit build routes its output through the
   * adapter rather than Vite's `build.outDir`, so emitting one would be a
   * setting that reads as authoritative and silently does nothing.
   */
  readonly viteBuild?: Readonly<Record<string, unknown>> | null;
  /**
   * The module the shared `frontend/index.html` loads, e.g. `/src/main.tsx`.
   * Absent when {@link ownsHtmlEntry} is true and no such file is emitted —
   * a stale path here would point at a module the scaffold does not write.
   */
  readonly entryScript?: string;
  /**
   * True when the preset supplies its own HTML entry document, so the shared
   * `frontend/index.html` is not emitted.
   *
   * SvelteKit owns the page template (`frontend/src/app.html`, with the
   * `%sveltekit.head%` / `%sveltekit.body%` placeholders it substitutes into);
   * a second hand-written `index.html` beside it would never be served and
   * would read as the entry point to anyone — human or agent — opening it.
   */
  readonly ownsHtmlEntry?: boolean;
  /**
   * Extra `package.json` scripts, merged over the shared set.
   *
   * SvelteKit needs `prepare: "svelte-kit sync"` so a fresh clone's
   * `.svelte-kit/tsconfig.json` exists before anything reads `tsconfig.json` —
   * without it `npm install && npm run typecheck` fails on a missing extends
   * target rather than on anything the user did.
   */
  readonly extraScripts?: Readonly<Record<string, string>>;
  /**
   * Extra exports appended to the shared `frontend/src/lib/utils.ts`.
   *
   * The kit's CLI generates components that import from this file, and it
   * expects more than `cn()`. shadcn-svelte's components import
   * `WithElementRef` and `WithoutChildrenOrChild` from `$lib/utils.js`, so a
   * scaffold shipping `cn()` alone type-checks until the first
   * `npx shadcn-svelte@latest add <name>` — which the agent guidance tells
   * assistants to run — and then fails on components the user never wrote.
   *
   * shadcn/ui for React uses no such helpers, which is why this is per-preset
   * rather than shared.
   */
  readonly libUtilsExtra?: string;
  /**
   * The whole `frontend/src/lib/utils.ts`, replacing the shared clsx +
   * tailwind-merge `cn()` — for a kit whose registry imports `cn()` from a
   * package instead. shadcn/ui's components import it from the `cn` package,
   * so React's copy only re-exports that; code written against the
   * `components.json` utils alias still resolves to the same function.
   * When set, {@link libUtilsExtra} is ignored.
   */
  readonly libUtils?: string;
  /** Extra `.gitignore` entries appended to the shared set, e.g. `.svelte-kit/`. */
  readonly gitignoreEntries?: readonly string[];
  /**
   * Framework-owned files: entry module, app, UI kit, tool configs.
   *
   * `choice` is the resolved theme (see `theme-presets.ts`). A preset reads it
   * for the two things that are framework-shaped rather than CSS-shaped: the
   * base color its `components.json` declares, and whether it renders a
   * mode-toggle control. The token values themselves never reach here — they
   * are the shared stylesheet's business.
   *
   * Optional, defaulting to {@link defaultThemeChoice}, so a caller that does
   * not care about theming — every test of the framework half, and any future
   * consumer — is not forced to construct one.
   */
  files(vars: TemplateVars, landing: LandingContent, choice?: ThemeChoice): ScaffoldFile[];
  /**
   * This framework's half of an icon library — the dependency to install and
   * the import line for the landing page's arrow.
   *
   * A method rather than a static field because the answer depends on a choice:
   * `preset.dependencies` is what the FRAMEWORK needs whatever the user picks,
   * and the icon package is not that. See `icon-presets.ts` for why this is the
   * one visual axis a preset has to own.
   */
  iconBinding(id: IconLibraryId | undefined): IconBinding;

  /**
   * The README's "## The frontend" section.
   *
   * Takes the icon library because the import form for an icon is the one piece
   * of framework prose that varies by a user choice — and prose describing a
   * package the project does not install is worse than no prose.
   */
  readmeFrontendSection(icons?: IconLibraryId): string;
  /** The frontend bullets in the scaffolded AI-assistant instructions. */
  agentGuidanceSection(icons?: IconLibraryId): string;
}

/**
 * The preset table — a static record, deliberately NOT a registry each preset
 * module writes into at import time.
 *
 * This package sets `"sideEffects": false`, which licenses a bundler to drop
 * any import kept only for its side effects. A `import "./frontend-react.js"`
 * placed purely to trigger registration is exactly that, and esbuild removes
 * it: the built CLI then rejects every `--framework` value as unknown while
 * printing that same value as valid. Source-run tests never see it, because
 * nothing is bundled there. A table of direct value references cannot be
 * dropped, because the values are used.
 *
 * The preset modules import only *types* from this one, so the cycle this
 * creates has no runtime edge back.
 */
const PRESETS: Record<FrameworkId, FrontendPreset> = {
  react: reactPreset,
  svelte: sveltePreset,
};

/** Look up a preset by id, or `undefined` when the id is not a framework. */
export function findFrontendPreset(id: string): FrontendPreset | undefined {
  const normalized = id.trim().toLowerCase();
  return (FRAMEWORKS as readonly string[]).includes(normalized)
    ? PRESETS[normalized as FrameworkId]
    : undefined;
}

/** Every preset, in {@link FRAMEWORKS} order. */
export function allFrontendPresets(): FrontendPreset[] {
  return FRAMEWORKS.map((id) => PRESETS[id]);
}

/**
 * Validate a `--framework` value: an unknown id is a
 * hard error naming every valid one, never a silent fall back to the default.
 */
export function resolveFrameworkFlag(raw: string): FrontendPreset {
  const preset = findFrontendPreset(raw);
  if (preset === undefined) {
    throw new Error(
      `Unknown --framework "${raw}". Valid frameworks: ${FRAMEWORKS.join(", ")}.`,
    );
  }
  return preset;
}
