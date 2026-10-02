/**
 * The React frontend preset — Vite + React 19 + Tailwind v4 + shadcn/ui.
 *
 * This is the scaffold's default and the shape every other preset mirrors. See
 * `frontend-presets.ts` for what a preset owns and what stays shared.
 */
import type { ScaffoldFile } from "./scaffold.js";
import type { TemplateVars } from "./init-templates.js";
import type { FrontendPreset, InlineNode, LandingContent } from "./frontend-presets.js";
import { defaultThemeChoice, type ThemeChoice } from "./theme-presets.js";
import { iconLibraryOf, type IconBinding, type IconLibraryId } from "./icon-presets.js";

/**
 * A `<code>` styled with the shadcn token palette. One constant so every
 * landing page this preset renders agrees on the single bit of inline styling
 * it needs.
 */
const CODE_CLASS = "bg-muted rounded px-1.5 py-0.5 font-mono text-sm";

/**
 * Escape copy for JSX *text* position. `<` and `{` would otherwise open an
 * element or an expression, and `&` could start an entity — an app name or a
 * codegen origin string carrying any of them must not be able to produce a file
 * that does not parse.
 */
function jsxText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/** Render one inline node: bare text, or text inside the styled `<code>`. */
function renderNode(node: InlineNode): string {
  return "code" in node
    ? `<code className="${CODE_CLASS}">${jsxText(node.code)}</code>`
    : jsxText(node.text);
}

function renderNodes(nodes: readonly InlineNode[]): string {
  return nodes.map(renderNode).join("");
}

/** The landing page, as a React component. */
function renderApp(landing: LandingContent, choice: ThemeChoice): string {
  const steps = landing.steps
    .map((step) => `            <li>${renderNodes(step)}</li>`)
    .join("\n");
  // The toggle is rendered only when the scaffold has one to render. Emitting
  // the markup unconditionally and leaving the import out would be a file that
  // does not compile; emitting both would ship a control that flips a class
  // nothing persists.
  const toggle = choice.dark === "toggle";
  const icons = iconLibraryOf(choice.icons).react;
  return `${icons.arrowImport}

import { Button } from "@/components/ui/button";${
    toggle ? `\nimport { ModeToggle } from "@/components/mode-toggle";` : ""
  }
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center p-8">${
      toggle
        ? `
      <div className="mb-4 flex justify-end">
        <ModeToggle />
      </div>`
        : ""
    }
      <Card>
        <CardHeader>
          <CardTitle className="text-3xl tracking-tight">${jsxText(landing.title)}</CardTitle>
          <CardDescription className="text-base">
            ${renderNodes(landing.lead)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="text-muted-foreground list-inside list-decimal space-y-2">
${steps}
          </ol>
        </CardContent>
        <CardFooter>
          {/* asChild renders the Button's styles onto the anchor. Components come
              from shadcn/ui — add more with \`npx shadcn@latest add <name>\`. */}
          <Button asChild>
            <a href="${landing.cta.href}" target="_blank" rel="noreferrer">
              ${jsxText(landing.cta.label)} <${icons.arrowComponent} />
            </a>
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
`;
}

function renderMainTsx(): string {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;
}

/**
 * `components.json` — the shadcn/ui CLI's config, read by
 * `npx shadcn@latest add <component>` to decide where files land and which
 * variant to write. Present in the scaffold so the CLI needs no `init` run:
 * paths point at this project's `frontend/` layout, and the aliases match the
 * `@/*` mapping in `tsconfig.json` + `vite.config.ts`.
 */
function renderComponentsJson(choice: ThemeChoice): string {
  const config = {
    $schema: "https://ui.shadcn.com/schema.json",
    style: "new-york",
    rsc: false,
    tsx: true,
    tailwind: {
      // v4 has no config file; the theme lives in the stylesheet.
      config: "",
      css: "frontend/src/index.css",
      // The base color the scaffold's stylesheet was rendered from. The CLI
      // reads it for the few colors a generated component hard-codes rather
      // than tokenises, so a value that disagrees with index.css produces
      // components that clash with everything already there. An imported
      // registry theme belongs to no upstream base and falls back to neutral.
      baseColor: choice.theme.baseColor ?? "neutral",
      cssVariables: true,
      prefix: "",
    },
    aliases: {
      components: "@/components",
      utils: "@/lib/utils",
      ui: "@/components/ui",
      lib: "@/lib",
      hooks: "@/hooks",
    },
    // Omitted entirely for a set the CLI does not know — writing an
    // unrecognised value would break `add` for every component, which is worse
    // than icons defaulting to lucide. See IconLibrary.componentsJson.
    ...(iconLibraryOf(choice.icons).componentsJson === undefined
      ? {}
      : { iconLibrary: iconLibraryOf(choice.icons).componentsJson }),
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * `components/ui/button.tsx` — verbatim shadcn/ui (new-york).
 *
 * shadcn is not a dependency: components are *copied in* and owned by the
 * project. This is the file the CLI would write, so `npx shadcn@latest add
 * button` overwrites it with an equivalent one rather than conflicting.
 */
function renderButtonTsx(): string {
  return `import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
`;
}

/**
 * `components/mode-toggle.tsx` — the light/dark control, for `--dark toggle`.
 *
 * Deliberately not `next-themes` (shadcn's own docs reach for it, and it is a
 * Next.js-shaped dependency this scaffold has no reason to carry): the state is
 * three functions in `@/lib/theme`, and this is the button over them.
 *
 * It cycles system → light → dark rather than flipping a boolean, so "follow my
 * OS" stays reachable after someone has picked an explicit mode once. The icon
 * shows what is currently rendered; the label says what the click will do,
 * because those differ under "system" and a screen-reader user gets only one.
 */
function renderModeToggleTsx(icons: IconBinding): string {
  return `import { useEffect, useState } from "react";
${icons.modeImports.join("\n")}

import { Button } from "@/components/ui/button";
import { getMode, setMode, watchMode, type Mode } from "@/lib/theme";

/** system → light → dark → system. */
const NEXT: Record<Mode, Mode> = { system: "light", light: "dark", dark: "system" };

const ICON = {
  system: ${icons.modeComponents.system},
  light: ${icons.modeComponents.light},
  dark: ${icons.modeComponents.dark},
};

export function ModeToggle() {
  // Read on mount, not during render: the inline script in index.html has
  // already applied the class, and touching localStorage while rendering would
  // break if this component is ever server-rendered.
  const [mode, setLocal] = useState<Mode>("system");
  useEffect(() => {
    setLocal(getMode());
    return watchMode(setLocal);
  }, []);

  const Icon = ICON[mode];
  const change = () => {
    const next = NEXT[mode];
    setMode(next);
    setLocal(next);
  };

  return (
    <Button variant="ghost" size="icon" onClick={change} aria-label={\`Switch to \${NEXT[mode]} theme\`}>
      <Icon />
    </Button>
  );
}
`;
}

/** `components/ui/card.tsx` — verbatim shadcn/ui (new-york). See {@link renderButtonTsx}. */
function renderCardTsx(): string {
  return `import * as React from "react"
import { cn } from "cn"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
`;
}

export const reactPreset: FrontendPreset = {
  id: "react",
  label: "React + Vite",
  dependencies: {
    // shadcn/ui's runtime surface. `radix-ui` is the unified primitives
    // package current components import (`Slot.Root` powers `asChild`) — not
    // the per-primitive `@radix-ui/react-*` packages, which it superseded.
    // cva types the variants, and `cn` is shadcn's own class merger, which its
    // components import directly (it replaced clsx + tailwind-merge upstream).
    // Pre-installed so `npx shadcn@latest add <component>` works without a
    // separate npm i.
    //
    // The icon package is deliberately absent: it is `--icons`, merged in by
    // renderPackageJson from `iconBinding` below. Naming lucide here too would
    // install it alongside whatever the user actually chose.
    "class-variance-authority": "^0.7.1",
    cn: "^0.4.0",
    "radix-ui": "^1.6.7",
    react: "^19.1.0",
    "react-dom": "^19.1.0",
  },
  devDependencies: {
    "@tailwindcss/vite": "^4.1.5",
    "@types/node": "^20.19.43",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    // 6.x, which peer-requires vite ^8 — the same constraint the Svelte
    // preset's plugin has, which is why both presets share one Vite major.
    // Its `@rolldown/plugin-babel` and `babel-plugin-react-compiler` peers are
    // OPTIONAL (they back the React Compiler path, which this scaffold does
    // not enable), so neither is shipped: verified by a clean install with no
    // unmet-peer warnings.
    "@vitejs/plugin-react": "^6.0.5",
    tailwindcss: "^4.1.5",
    "tw-animate-css": "^1.2.4",
    tsx: "^4.19.2",
    // Kept in step with the Svelte preset — the major `sv create` pins. 7 is
    // out, but svelte-check's peer range stops at 6 and the two presets track
    // one TypeScript major so the shared tsconfig means the same thing in both.
    typescript: "^6.0.3",
    vite: "^8.0.16",
  },
  // `tsc` checks .tsx natively, so React needs nothing beyond it.
  checkCmd: "tsc --noEmit",
  aliasName: "@",
  aliasTarget: "frontend/src",
  // `./`-rooted: with no `baseUrl` (deprecated in TypeScript 6), a `paths`
  // target resolves against tsconfig.json's own directory.
  tsconfigPaths: { "@/*": ["./frontend/src/*"] },
  tsconfigOptions: { jsx: "react-jsx" },
  viteImports: [
    `import react from "@vitejs/plugin-react";`,
    `import tailwindcss from "@tailwindcss/vite";`,
  ],
  vitePlugins: ["react()", "tailwindcss()"],
  entryScript: "/src/main.tsx",
  libUtils: `export { cn, type ClassValue } from "cn";\n`,

  files(
    _vars: TemplateVars,
    landing: LandingContent,
    choice: ThemeChoice = defaultThemeChoice(),
  ): ScaffoldFile[] {
    return [
      // The shadcn/ui CLI's config — lets `npx shadcn@latest add <component>`
      // work in a fresh scaffold without a separate `shadcn init`.
      { path: "components.json", content: renderComponentsJson(choice) },
      { path: "frontend/src/main.tsx", content: renderMainTsx() },
      { path: "frontend/src/App.tsx", content: renderApp(landing, choice) },
      // Only for `--dark toggle`. `system` needs no component: the inline
      // script in index.html is the whole implementation.
      ...(choice.dark === "toggle"
        ? [
            {
              path: "frontend/src/components/mode-toggle.tsx",
              content: renderModeToggleTsx(iconLibraryOf(choice.icons).react),
            },
          ]
        : []),
      // The two components the landing page uses. Every other shadcn component
      // is one `npx shadcn@latest add` away and lands beside these.
      { path: "frontend/src/components/ui/button.tsx", content: renderButtonTsx() },
      { path: "frontend/src/components/ui/card.tsx", content: renderCardTsx() },
    ];
  },

  iconBinding(id: IconLibraryId | undefined): IconBinding {
    return iconLibraryOf(id).react;
  },

  readmeFrontendSection(icons?: IconLibraryId): string {
    return `React + Vite, styled with [Tailwind CSS](https://tailwindcss.com) v4 and
[shadcn/ui](https://ui.shadcn.com). shadcn is not a dependency — its components
are copied into [\`frontend/src/components/ui/\`](frontend/src/components/ui/) and
owned by this project, so edit them freely. \`Button\` and \`Card\` are already
there; add more with:

\`\`\`bash
npx shadcn@latest add dialog input form
\`\`\`

[\`components.json\`](components.json) is pre-configured, so that works with no
\`shadcn init\` step. ${iconLibraryOf(icons).guidance.react}
[\`frontend/src/App.tsx\`](frontend/src/App.tsx) already uses one.

Components import through the \`@/\` alias (\`@/components/ui/button\`), which
maps to \`frontend/src/\` in both \`tsconfig.json\` and \`vite.config.ts\` — change
one and change the other. \`cn()\` comes from shadcn's \`cn\` package, which is
what the CLI writes into every component it adds.

Colors come from the theme tokens in
[\`frontend/src/index.css\`](frontend/src/index.css) — see **Theming** below.`;
  },

  agentGuidanceSection(icons?: IconLibraryId): string {
    return `- \`frontend/src/\` — the React app. Tailwind v4 + shadcn/ui.
  - \`frontend/src/components/ui/\` — shadcn components, **copied in and owned by
    this project**. Edit them directly; there is no library to configure around.
  - Need one that isn't there? \`npx shadcn@latest add <name>\` — do not hand-roll
    it, and do not add a different component library.
  - ${iconLibraryOf(icons).guidance.react.replace(/\n/g, "\n    ")}
    \`frontend/src/App.tsx\` already uses one. Do not add another icon library and
    do not paste raw inline \`<svg>\` markup — search the set before concluding an
    icon is missing.
  - Import via the \`@/\` alias (\`@/components/ui/button\`), declared in both
    \`tsconfig.json\` and \`vite.config.ts\`. \`cn()\` is \`import { cn } from "cn"\`
    (shadcn's own package, which the CLI writes into every component it adds);
    \`@/lib/utils\` re-exports it. Leave a generated component's imports as the
    CLI wrote them.
  - \`npx shadcn@latest add sonner\` writes a \`Toaster\` that reads the mode from
    \`next-themes\`, which this project does not use. Drop that import and
    uninstall \`next-themes\`, then pass \`theme\` from the project's own mode:
    \`getMode()\` + \`watchMode()\` from \`@/lib/theme\` when that module exists,
    otherwise \`"system"\` (or \`"light"\` if nothing applies the \`dark\` class).`;
  },
};
