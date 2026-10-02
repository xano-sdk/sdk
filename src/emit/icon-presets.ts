/**
 * Icon-library presets — the one visual axis that is genuinely framework-shaped.
 *
 * A theme is CSS: the same token values render identically under React and
 * Svelte, which is why `theme-presets.ts` never mentions a framework. An icon
 * set is not. Each library ships a different package per framework, names its
 * components differently (`ArrowRight` vs `IconArrowRight`), and exposes them
 * through a different import shape (named export, deep path, barrel). So this
 * module holds one binding PER LIBRARY PER FRAMEWORK, and a preset asks for the
 * pair it needs.
 *
 * Three things depend on the answer, and all three have to agree or the
 * scaffold does not compile: the dependency in `package.json`, the import line
 * in the landing page, and — for shadcn/ui — the `iconLibrary` field in
 * `components.json`, which is what makes `npx shadcn@latest add <component>`
 * write icons from the set the project already has rather than reinstalling
 * lucide alongside it.
 *
 * Browser-safe: pure data and string building.
 */

/** Every icon library `--icons` accepts, in prompt/help order. */
export const ICON_LIBRARIES = ["lucide", "tabler", "phosphor"] as const;

export type IconLibraryId = (typeof ICON_LIBRARIES)[number];

/** The set a scaffold gets when nothing selects one — shadcn/ui's own default. */
export const DEFAULT_ICON_LIBRARY: IconLibraryId = "lucide";

/**
 * The framework's half of an icon library: what to install, and how to reach
 * one icon.
 *
 * Only the icons the SCAFFOLD itself writes are modelled concretely: the
 * landing page's arrow, and the three the mode toggle cycles through.
 * Everything past that is the user's code, and the prose in
 * {@link IconLibrary.guidance} is what tells them (and any agent) the import
 * shape for the rest.
 *
 * The mode icons are not optional detail. `--dark toggle` emits a component
 * that imports three of them, so a binding that named only the arrow would
 * produce a scaffold importing lucide from a project that installs Tabler —
 * a build failure on the first `npm run dev`, caused by a flag that has
 * nothing to do with dark mode.
 */
export interface IconBinding {
  /** Added to the scaffold's `dependencies`. */
  readonly dependency: Readonly<Record<string, string>>;
  /** The import line for the landing page's arrow. */
  readonly arrowImport: string;
  /** The component that import binds, as written in markup. */
  readonly arrowComponent: string;
  /** Import lines for the mode toggle's three icons. */
  readonly modeImports: readonly string[];
  /** What those imports bind, keyed by the mode each represents. */
  readonly modeComponents: {
    readonly system: string;
    readonly light: string;
    readonly dark: string;
  };
}

/** One icon library, across every framework that can use it. */
export interface IconLibrary {
  readonly id: IconLibraryId;
  readonly label: string;
  /**
   * The `iconLibrary` value in shadcn/ui's `components.json`, when the CLI
   * knows this set.
   *
   * `undefined` leaves the field off entirely rather than writing a value the
   * CLI would reject — a components.json it cannot parse breaks `add` for every
   * component, which is a far worse outcome than icons defaulting to lucide.
   */
  readonly componentsJson: string | undefined;
  readonly react: IconBinding;
  readonly svelte: IconBinding;
  /** How to import any icon, for the README and the agent brief. */
  readonly guidance: { readonly react: string; readonly svelte: string };
}

const LIBRARIES: Record<IconLibraryId, IconLibrary> = {
  lucide: {
    id: "lucide",
    label: "Lucide",
    componentsJson: "lucide",
    react: {
      dependency: { "lucide-react": "^0.475.0" },
      arrowImport: `import { ArrowRight } from "lucide-react";`,
      arrowComponent: "ArrowRight",
      modeImports: [`import { Monitor, Moon, Sun } from "lucide-react";`],
      modeComponents: { system: "Monitor", light: "Sun", dark: "Moon" },
    },
    svelte: {
      // Not the same version line as `lucide-react`: the Svelte icons ship from
      // a separate package on their own 1.x.
      dependency: { "@lucide/svelte": "^1.31.0" },
      arrowImport: `import ArrowRight from "@lucide/svelte/icons/arrow-right";`,
      arrowComponent: "ArrowRight",
      modeImports: [
        `import Monitor from "@lucide/svelte/icons/monitor";`,
        `import Moon from "@lucide/svelte/icons/moon";`,
        `import Sun from "@lucide/svelte/icons/sun";`,
      ],
      modeComponents: { system: "Monitor", light: "Sun", dark: "Moon" },
    },
    guidance: {
      react: `Icons are [Lucide](https://lucide.dev/icons), installed as \`lucide-react\` and
imported by name from the package root —
\`import { ArrowRight } from "lucide-react";\`.`,
      svelte: `Icons are [Lucide](https://lucide.dev/icons), installed as \`@lucide/svelte\` —
**not** \`lucide-react\`, which is the wrong package here in the same way the
plain \`shadcn\` CLI is. Import them one per module, and kebab-case the name into
the path: the icon is that module's DEFAULT export, and \`ArrowRight\` lives at
\`arrow-right\` — \`import ArrowRight from "@lucide/svelte/icons/arrow-right";\`.
Never from the package root, which pulls the whole set into the bundle.`,
    },
  },
  tabler: {
    id: "tabler",
    label: "Tabler",
    componentsJson: "tabler",
    react: {
      dependency: { "@tabler/icons-react": "^3.31.0" },
      // Every Tabler component is prefixed `Icon`, so the name in markup is not
      // the name on the website — the single most common mistake with this set.
      arrowImport: `import { IconArrowRight } from "@tabler/icons-react";`,
      arrowComponent: "IconArrowRight",
      modeImports: [
        `import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";`,
      ],
      modeComponents: {
        system: "IconDeviceDesktop",
        light: "IconSun",
        dark: "IconMoon",
      },
    },
    svelte: {
      dependency: { "@tabler/icons-svelte": "^3.31.0" },
      arrowImport: `import { IconArrowRight } from "@tabler/icons-svelte";`,
      arrowComponent: "IconArrowRight",
      modeImports: [
        `import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-svelte";`,
      ],
      modeComponents: {
        system: "IconDeviceDesktop",
        light: "IconSun",
        dark: "IconMoon",
      },
    },
    guidance: {
      react: `Icons are [Tabler](https://tabler.io/icons), installed as \`@tabler/icons-react\`.
Every component is prefixed \`Icon\` — the site lists \`arrow-right\`, the import is
\`import { IconArrowRight } from "@tabler/icons-react";\`.`,
      svelte: `Icons are [Tabler](https://tabler.io/icons), installed as \`@tabler/icons-svelte\` —
**not** \`@tabler/icons-react\`, which is the wrong package here in the same way
the plain \`shadcn\` CLI is. Every component is prefixed \`Icon\`, so the name in
markup is not the name on the site: \`arrow-right\` is
\`import { IconArrowRight } from "@tabler/icons-svelte";\`.`,
    },
  },
  phosphor: {
    id: "phosphor",
    label: "Phosphor",
    // shadcn/ui's CLI does not know this set. Left off components.json rather
    // than guessed — see IconLibrary.componentsJson.
    componentsJson: undefined,
    react: {
      dependency: { "@phosphor-icons/react": "^2.1.7" },
      arrowImport: `import { ArrowRight } from "@phosphor-icons/react";`,
      arrowComponent: "ArrowRight",
      modeImports: [`import { Desktop, Moon, Sun } from "@phosphor-icons/react";`],
      modeComponents: { system: "Desktop", light: "Sun", dark: "Moon" },
    },
    svelte: {
      dependency: { "phosphor-svelte": "^3.0.1" },
      arrowImport: `import ArrowRight from "phosphor-svelte/lib/ArrowRight";`,
      arrowComponent: "ArrowRight",
      modeImports: [
        `import Desktop from "phosphor-svelte/lib/Desktop";`,
        `import Moon from "phosphor-svelte/lib/Moon";`,
        `import Sun from "phosphor-svelte/lib/Sun";`,
      ],
      modeComponents: { system: "Desktop", light: "Sun", dark: "Moon" },
    },
    guidance: {
      react: `Icons are [Phosphor](https://phosphoricons.com), installed as
\`@phosphor-icons/react\` and imported by name —
\`import { ArrowRight } from "@phosphor-icons/react";\`. Each takes a \`weight\` prop
(\`regular\`, \`bold\`, \`duotone\`, …) rather than only a stroke width.`,
      svelte: `Icons are [Phosphor](https://phosphoricons.com), installed as \`phosphor-svelte\` —
**not** \`@phosphor-icons/react\`, which is the wrong package here in the same way
the plain \`shadcn\` CLI is. Import them one per module, and PascalCase the name
into the path: \`import ArrowRight from "phosphor-svelte/lib/ArrowRight";\`.
Never from the package root, which pulls the whole set into the bundle.`,
    },
  },
};

/** Look up a library by id, or `undefined` when the id is not one. */
export function findIconLibrary(id: string): IconLibrary | undefined {
  const normalized = id.trim().toLowerCase();
  return (ICON_LIBRARIES as readonly string[]).includes(normalized)
    ? LIBRARIES[normalized as IconLibraryId]
    : undefined;
}

/** Every library, in {@link ICON_LIBRARIES} order. */
export function allIconLibraries(): IconLibrary[] {
  return ICON_LIBRARIES.map((id) => LIBRARIES[id]);
}

/** The library a scaffold gets when nothing selects one. */
export function defaultIconLibrary(): IconLibrary {
  return LIBRARIES[DEFAULT_ICON_LIBRARY];
}

/**
 * Validate an `--icons` value, mirroring `--framework` and `--theme`: an
 * unknown id is a hard error naming every valid one, never a silent fallback.
 */
export function resolveIconsFlag(raw: string): IconLibrary {
  const library = findIconLibrary(raw);
  if (library === undefined) {
    throw new Error(
      `Unknown --icons "${raw}". Valid icon libraries: ${ICON_LIBRARIES.join(", ")}.`,
    );
  }
  return library;
}

/** Resolve a possibly-absent choice to a library. */
export function iconLibraryOf(id: IconLibraryId | undefined): IconLibrary {
  return id === undefined ? defaultIconLibrary() : LIBRARIES[id];
}
