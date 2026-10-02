/**
 * The Svelte frontend preset — SvelteKit + Tailwind v4 + shadcn-svelte.
 *
 * This preset was plain Svelte on Vite first, on the reasoning that SvelteKit
 * "moves the build output, adds an adapter, and diverges from the
 * single-root-`package.json` / `root: "frontend"` shape". Each of those is
 * real and each is answerable, so the trade came out the other way:
 *
 * - The build output is directed back by the SDK's adapter (`out`), which takes
 *   a project-root-relative path — so `frontend/dist` needs no move.
 * - The single-root shape survives via `files`, which redirects `routes`,
 *   `lib`, `appTemplate`, and `assets` into `frontend/`. One `package.json`,
 *   one `tsconfig.json`, one `npm run build`, unchanged.
 * - The adapter is the point, not the cost: it is what makes the no-server
 *   constraint a build error instead of a runtime surprise.
 *
 * What that buys is the shape an AI assistant already knows. `npx sv create`
 * is the canonical Svelte entry point, so `src/routes/+page.svelte` is what
 * training data and documentation are full of; plain Svelte on Vite ships no
 * router at all, which made the second page an agent added a fork in the road.
 * This preset already borrowed `$lib` — a SvelteKit convention — without
 * SvelteKit behind it.
 *
 * The constraint that comes with it, and that the scaffolded agent brief
 * states loudly: THERE IS NO SERVER AT RUNTIME. Xano is the backend, `--static`
 * deploys to a host with no runtime, and `+page.server.ts` / form actions /
 * server `load` cannot work there.
 *
 * Nothing catches that for you: a project containing `+page.server.ts`
 * builds green — it then fails in the browser, on the deployed site. The brief and README therefore have to
 * carry the whole weight, which is why the constraint is stated first and in
 * full rather than as a footnote about page options.
 *
 * ROUTES ARE PRERENDERED, which this preset did not always do. It shipped as a
 * pure SPA — `ssr = false`, `prerender = false`, one shell for every URL —
 * because the host resolved a request to one exact key and answered every miss
 * with that shell. Prerendered output was simply unreachable: `/about` never
 * found `about.html`, and `/about/` never found `about/index.html`.
 *
 * The host resolves both shapes now, so the preset renders each route to its own
 * document. Two consequences the scaffold has to state rather than let an agent
 * discover:
 *
 * - Prerendering is server-rendering at build time, so module-scope browser
 *   globals now break the BUILD. That is a strictly better failure than the
 *   runtime one it replaces.
 * - The scaffolded `/404` ROUTE prerenders to `404.html`, which opts this build
 *   into real 404s — a missing asset returns 404 instead of HTML-with-200. It
 *   has to be a route: `+error.svelte` is never prerendered to a file, so a
 *   build relying on it ships no `404.html` at all.
 *
 * The config lives in `vite.config.ts`, not a `svelte.config.js` — see
 * renderSvelteKitPlugin() for why that choice is load-bearing rather than
 * cosmetic.
 *
 * shadcn-svelte is not a Svelte skin of shadcn/ui — it is built on `bits-ui`
 * (not `radix-ui`) and `tailwind-variants` (not `class-variance-authority`),
 * and it imports through `$lib` rather than `@/`. Its `components.json` schema
 * differs accordingly, which is why that file is preset-owned.
 */
import type { ScaffoldFile } from "./scaffold.js";
import type { TemplateVars } from "./init-templates.js";
import { renderThemeScript } from "./init-templates.js";
import type { FrontendPreset, InlineNode, LandingContent } from "./frontend-presets.js";
import { defaultThemeChoice, type ThemeChoice } from "./theme-presets.js";
import { iconLibraryOf, type IconBinding, type IconLibraryId } from "./icon-presets.js";

/** See the React preset's constant of the same name — the one bit of inline styling. */
const CODE_CLASS = "bg-muted rounded px-1.5 py-0.5 font-mono text-sm";

/**
 * Escape copy for HTML *text* position — app.html's `<title>`.
 *
 * Separate from {@link svelteText}: `{` and `}` are ordinary characters in a
 * plain HTML document, and escaping them there would render entities.
 */
function htmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape copy for Svelte *text* position. `{` opens an expression and `<` opens
 * an element, so an app name or codegen origin carrying either must not be able
 * to produce a component that does not compile.
 */
function svelteText(s: string): string {
  return htmlText(s).replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}

function renderNode(node: InlineNode): string {
  return "code" in node
    ? `<code class="${CODE_CLASS}">${svelteText(node.code)}</code>`
    : svelteText(node.text);
}

function renderNodes(nodes: readonly InlineNode[]): string {
  return nodes.map(renderNode).join("");
}

/** The landing page, as a Svelte component. */
function renderApp(landing: LandingContent, choice: ThemeChoice): string {
  const steps = landing.steps
    .map((step) => `        <li>${renderNodes(step)}</li>`)
    .join("\n");
  // See the React preset: the toggle's import and markup are emitted together
  // or not at all, so neither half can reference a file that was not written.
  const toggle = choice.dark === "toggle";
  const icons = iconLibraryOf(choice.icons).svelte;
  return `<script lang="ts">
  ${icons.arrowImport}

  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";${
    toggle ? `\n  import ModeToggle from "$lib/components/mode-toggle.svelte";` : ""
  }
</script>

<main class="mx-auto flex min-h-screen max-w-2xl flex-col justify-center p-8">${
    toggle
      ? `
  <div class="mb-4 flex justify-end">
    <ModeToggle />
  </div>`
      : ""
  }
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-3xl tracking-tight">${svelteText(landing.title)}</Card.Title>
      <Card.Description class="text-base">
        ${renderNodes(landing.lead)}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <ol class="text-muted-foreground list-inside list-decimal space-y-2">
${steps}
      </ol>
    </Card.Content>
    <Card.Footer>
      <!-- Components come from shadcn-svelte — add more with
           \`npx shadcn-svelte@latest add <name>\`. -->
      <Button href="${landing.cta.href}" target="_blank" rel="noreferrer">
        ${svelteText(landing.cta.label)}
        <${icons.arrowComponent} />
      </Button>
    </Card.Footer>
  </Card.Root>
</main>
`;
}

/**
 * The SvelteKit config, passed to the `sveltekit()` Vite plugin.
 *
 * NOT a `svelte.config.js`. SvelteKit accepts config in either place, but the
 * two are mutually exclusive in a way that is a trap here: passing ANY object
 * to `sveltekit()` makes `svelte.config.js` be ignored ENTIRELY. Since 2.62.0
 * `sv create` puts config in the Vite plugin and emits no `svelte.config.js`
 * at all, so an assistant following current docs reaches for exactly the edit
 * that voids it — and the plugin takes `KitConfig` FLATTENED, so the natural
 * migration (copying the `kit: {...}` wrapper across) is not even a valid key.
 * It would disable everything and apply nothing, silently: measured, the build
 * stopped writing `frontend/dist` and `$lib` stopped resolving.
 *
 * Keeping the config here removes the trap rather than warning about it. The
 * mirror case is harmless: a `svelte.config.js` an assistant adds from older
 * training data is simply ignored, so the project keeps building correctly and
 * the stray edit is a no-op instead of an outage.
 *
 * The two blocks below are what let SvelteKit live inside this project's shape
 * rather than replacing it: `files` points SvelteKit at `frontend/`, and the
 * adapter points its output back at `frontend/dist`.
 */
function renderSvelteKitPlugin(): string {
  return `sveltekit({
    // RUNES MODE, FORCED — not left to Svelte 5's per-component detection.
    //
    // By default a component that uses \`export let\` and \`<slot>\` simply
    // compiles in legacy mode and works, so the Svelte 4 API an assistant
    // reaches for from older training data produces no error at all. Pinning
    // runes here turns that into a compile failure naming the file, which is
    // the same guidance the agent brief gives, enforced instead of stated.
    //
    // \`node_modules\` is exempted (returning undefined restores detection):
    // an installed library compiles under whatever mode ITS author wrote for,
    // and forcing ours onto it would break dependencies this project does not
    // own. Removable in Svelte 6, where runes stop being opt-in.
    compilerOptions: {
      runes: ({ filename }) =>
        filename.split(/[/\\\\]/).includes("node_modules") ? undefined : true,
    },
    // No \`preprocess\`. vite-plugin-svelte 7 compiles \`<script lang="ts">\`
    // itself, so \`vitePreprocess()\` is the no-op it looks like — \`sv create\`
    // emits none either. Verified against a real build: components typecheck
    // and compile without it.
    //
    // The deploy target is a static host with NO server runtime — Xano is the
    // backend. Routes are PRERENDERED (see frontend/src/routes/+layout.ts):
    // each becomes its own HTML file at build time, and the host resolves a URL
    // to it by trying the exact key, then \`{path}.html\`, then
    // \`{path}/index.html\`. That is why no \`trailingSlash\` is configured — both
    // output shapes resolve, so this stays on SvelteKit's default.
    //
    // The SDK's adapter, writing to frontend/dist. Every prerendered route is
    // its own file; a route that sets \`prerender = false\` (a detail page for
    // rows created at runtime) has no file, so the host answers it with
    // 404.html, which the adapter writes as the app shell whenever such a
    // route exists: the shell boots the app and renders the route in the
    // browser, so a reload or a deep link works. While every route is
    // prerendered, 404.html stays the prerendered /404 page.
    //
    // Do not swap it for \`@sveltejs/adapter-static\` with a \`fallback\`: that
    // writes the shell at index.html, over the prerendered home page.
    //
    // \`xanosdk deploy --static-env\` still finds its anchor: every document
    // renders from app.html, so each has a <head> that gets the injected globals.
    adapter: adapter({ out: "frontend/dist" }),
    // Absolute asset URLs, pinned rather than left to the default. Prerendered
    // pages live at varying URL depths, and a relative \`../_app/…\` computed for
    // one depth 404s at another.
    paths: { relative: false },
    prerender: {
      // A hash link in the shared layout — \`<a href="#services">\`, the default
      // shape of a one-page site's nav — renders into EVERY prerendered route,
      // including the scaffold's own /404. There it resolves to /404#services,
      // an anchor that by definition is not on that page, and SvelteKit's
      // default handler THROWS: the vite build succeeds and the prerender pass
      // after it kills the build, with a stack trace naming only files inside
      // node_modules and a route the author never wrote.
      //
      // So ignore a missing id on /404 specifically, rather than reaching for a
      // blanket \`handleMissingId: "warn"\`. A hash link that is genuinely broken
      // on a real route still fails the build, which is the check worth keeping.
      handleMissingId: ({ path, message }) => {
        if (path === "/404") return;
        throw new Error(message);
      },
    },
    // SvelteKit's project layout, redirected under frontend/ so this stays a
    // single-root project: one package.json, one tsconfig.json, and xano/
    // sitting alongside as the backend half. NOTE these are what make
    // frontend/src/routes the routes directory — a file added under a
    // top-level src/routes/ is not a route and will not be served.
    files: {
      routes: "frontend/src/routes",
      lib: "frontend/src/lib",
      appTemplate: "frontend/src/app.html",
      assets: "frontend/static",
    },
  })`;
}

/**
 * `frontend/src/app.html` — SvelteKit's page template, and the document every
 * route is rendered into.
 *
 * The \`<head>\` is load-bearing beyond styling: \`xanosdk deploy --static-env\`
 * anchors its \`window.<KEY>\` injection to the first \`<head>\` of each built
 * document, and every prerendered route renders from this template. Remove it
 * and the deploy still succeeds while the app boots with no backend URL.
 */
function renderAppHtml({ appName }: TemplateVars, choice: ThemeChoice): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${htmlText(appName)}</title>
${renderThemeScript(choice.dark)}
    <!-- Drop a favicon.png into frontend/static/ and link it here:
         <link rel="icon" href="%sveltekit.assets%/favicon.png" />
         Everything in that directory is copied to the site root verbatim. -->
    <!-- Keep this inside <head>: \`xanosdk deploy --static-env\` injects the
         backend URL here as a window global that frontend/src/lib/api.ts reads. -->
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`;
}

/**
 * `frontend/src/lib/components/mode-toggle.svelte` — the light/dark control,
 * for `--dark toggle`.
 *
 * Same three-way cycle and the same `$lib/theme` module as the React preset's
 * toggle: the state is shared, only the markup differs.
 *
 * Everything touching `localStorage` runs in `$effect`, never at component
 * init. SvelteKit prerenders this page (`+layout.ts` sets `prerender`), so the
 * component body executes in Node during the build, where neither
 * `localStorage` nor `matchMedia` exists.
 */
function renderModeToggleSvelte(icons: IconBinding): string {
  return `<script lang="ts">
  ${icons.modeImports.join("\n  ")}

  import { Button } from "$lib/components/ui/button/index.js";
  import { getMode, setMode, watchMode, type Mode } from "$lib/theme.js";

  /** system → light → dark → system. */
  const next: Record<Mode, Mode> = { system: "light", light: "dark", dark: "system" };

  const icons = {
    system: ${icons.modeComponents.system},
    light: ${icons.modeComponents.light},
    dark: ${icons.modeComponents.dark},
  };

  // Starts at "system" so the prerendered HTML is deterministic; the effect
  // corrects it in the browser, after the inline script has already applied
  // the right class.
  let mode = $state<Mode>("system");

  $effect(() => {
    mode = getMode();
    return watchMode((m) => (mode = m));
  });

  function change() {
    const target = next[mode];
    setMode(target);
    mode = target;
  }

  const Icon = $derived(icons[mode]);
</script>

<Button variant="ghost" size="icon" onclick={change} aria-label="Switch to {next[mode]} theme">
  <Icon />
</Button>
`;
}

/**
 * `frontend/src/app.d.ts` — the ambient declarations SvelteKit's generated
 * types build on. Empty interfaces on purpose: this is the file a project fills
 * in when it needs typed \`locals\`, \`PageData\`, or \`Platform\`.
 */
function renderAppDts(): string {
  return `// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
`;
}

/**
 * `frontend/src/routes/+layout.ts` — the page option that encodes how this app
 * is built for a static host.
 *
 * Inherited by every route beneath, so this is the one place it is declared
 * rather than something each new page has to remember.
 */
function renderLayoutTs(): string {
  return `// There is no server. The backend is Xano, reached through $lib/api.ts,
// and \`npm run xano:deploy\` ships this app to a static host with no runtime.
//
// prerender: true — every route is rendered to its own HTML file AT BUILD TIME
// and served as a real document. That is what makes each page load as itself
// rather than as an empty shell that fills in afterwards.
//
// Prerendering IS server-rendering, just at build time rather than per request.
// So module-scope \`window\`/\`document\` access now fails the BUILD instead of the
// browser — which is the better place to find out. Reach for browser globals
// inside onMount, or guard with \`import { browser } from "$app/environment"\`.
//
// A route with dynamic segments (e.g. /posts/[id]) cannot be prerendered unless
// the build knows which ones exist, so THE BUILD FAILS and names the route.
// In that route's +page.ts, either list the ids (only those get a page):
//
//   export const entries = () => [{ id: "1" }, { id: "2" }];
//
// or, for rows created at runtime, render it in the browser instead:
//
//   export const prerender = false;
//
// Inherited by every route below this one.
export const prerender = true;
`;
}

/**
 * `frontend/src/lib/components/error-state.svelte` — the presentation shared by
 * the prerendered `/404` route and the runtime `+error.svelte`.
 *
 * Two files need it because they cover different moments: `404.html` is what the
 * HOST serves for a path that matched no document, while `+error.svelte` renders
 * when a client-side navigation or `load` fails inside an already-booted app.
 */
function renderErrorState(): string {
  return `<script lang="ts">
  // Shared by the prerendered /404 route and +error.svelte.
  let { status = 404, message = "" }: { status?: number; message?: string } = $props();
</script>

<main class="grid min-h-screen place-items-center p-8">
  <div class="max-w-md space-y-4 text-center">
    <p class="text-6xl font-semibold tracking-tight">{status}</p>
    <h1 class="text-xl font-medium">
      {status === 404 ? "We can't find that page." : "Something went wrong."}
    </h1>
    <p class="text-muted-foreground text-sm">
      {message !== "" ? message : "The link may be broken, or the page may have moved."}
    </p>
    <a
      href="/"
      class="bg-primary text-primary-foreground ring-offset-background focus-visible:ring-ring inline-flex h-10 items-center rounded-md px-5 text-sm font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      Back to safety
    </a>
  </div>
</main>
`;
}

/**
 * `frontend/src/routes/404/+page.svelte` — prerenders to `frontend/dist/404.html`,
 * which is how this build opts into real 404s.
 *
 * The route has to be `/404` rather than `+error.svelte`: SvelteKit renders
 * `+error.svelte` for runtime error states but never prerenders it to a file, so
 * a bundle relying on it ships no `404.html` at all. A plain route named `404`
 * prerenders to `404.html` under the default `trailingSlash`, and SvelteKit's
 * default `prerender.entries` of `["*"]` picks it up without it being linked
 * from anywhere.
 *
 * The static host treats a bundle shipping a root `404.html` as opting out of
 * serving the app shell for unmatched paths. That is the difference between a
 * missing asset returning a clear 404 and returning HTML with a 200 — the latter
 * surfaces as "Unexpected token '<'" when the browser tries to execute the shell
 * as JavaScript, which says nothing about the real problem.
 *
 * Deleting this route restores shell-for-everything, and that is the documented
 * escape hatch for an app whose routes are only known at runtime.
 */
function renderNotFoundRoute(): string {
  return `<script lang="ts">
  // Prerendered to 404.html, which is what tells the static host to answer an
  // unmatched path with a real 404 instead of quietly serving the app shell
  // with a 200 (a missing asset would then reach the browser as HTML, which it
  // reports as "Unexpected token '<'").
  //
  // It must be a route, not +error.svelte: SvelteKit never prerenders the error
  // component to a file, so relying on it would ship no 404.html at all.
  //
  // Delete this directory and an unmatched path serves the home page with a 200
  // instead — which is worse, not better, so keep it unless you have a reason.
  import ErrorState from "$lib/components/error-state.svelte";
</script>

<svelte:head>
  <title>Page not found</title>
</svelte:head>

<ErrorState status={404} />
`;
}

/**
 * `frontend/src/routes/+error.svelte` — the in-app error state.
 *
 * Complements the prerendered `/404`: this one renders when a navigation or a
 * `load` fails inside an app that has already booted, where the host is not
 * involved at all.
 */
function renderErrorSvelte(): string {
  return `<script lang="ts">
  // Rendered when a client-side navigation or load fails inside the running
  // app. The static host never sees these — for a path that matched no
  // document at all, it serves the prerendered routes/404 page instead.
  import { page } from "$app/state";
  import ErrorState from "$lib/components/error-state.svelte";
</script>

<svelte:head>
  <title>{page.status === 404 ? "Page not found" : "Something went wrong"}</title>
</svelte:head>

<ErrorState status={page.status} message={page.error?.message ?? ""} />
`;
}

/**
 * `frontend/src/routes/+layout.svelte` — the app shell every route renders
 * into, and the only place the Tailwind stylesheet is imported.
 */
function renderLayoutSvelte(): string {
  return `<script lang="ts">
  // The shared token stylesheet — semantic colors (bg-primary,
  // text-muted-foreground) plus the Tailwind v4 theme. Imported once here so
  // every route gets it.
  import "../index.css";

  let { children } = $props();
</script>

{@render children()}
`;
}

/**
 * `components.json` — the shadcn-svelte CLI's config, read by
 * `npx shadcn-svelte@latest add <component>`. Present in the scaffold so the
 * CLI needs no `init` run.
 *
 * Deliberately NOT React's schema: shadcn-svelte has no `style`, `rsc`, `tsx`,
 * or `iconLibrary` key, aliases are `$lib`-rooted, and it carries a `registry`
 * URL that shadcn/ui's config does not.
 */
function renderComponentsJson(choice: ThemeChoice): string {
  const config = {
    $schema: "https://shadcn-svelte.com/schema.json",
    tailwind: {
      // v4 has no config file; the theme lives in the stylesheet — the same
      // shared one the React preset points at.
      css: "frontend/src/index.css",
      // Tracks the theme the stylesheet was rendered from — see the React
      // preset's note; the shadcn-svelte CLI reads it the same way.
      baseColor: choice.theme.baseColor ?? "neutral",
    },
    aliases: {
      components: "$lib/components",
      utils: "$lib/utils",
      ui: "$lib/components/ui",
      hooks: "$lib/hooks",
      lib: "$lib",
    },
    typescript: true,
    registry: "https://shadcn-svelte.com/registry",
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * `components/ui/button/` — shadcn-svelte's Button, Svelte 5 runes.
 *
 * As with the React kit, components are *copied in* and owned by the project,
 * not depended on. This is what the CLI would write, so a later
 * `npx shadcn-svelte@latest add button` overwrites it rather than conflicting.
 * shadcn-svelte splits each component into `<name>.svelte` plus an `index.ts`
 * barrel, and that layout is what its imports assume.
 */
function renderButtonSvelte(): string {
  return `<script lang="ts" module>
  import { type VariantProps, tv } from "tailwind-variants";

  export const buttonVariants = tv({
    base: "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  });

  export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
  export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

  export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
    WithElementRef<HTMLAnchorAttributes> & {
      variant?: ButtonVariant;
      size?: ButtonSize;
    };
</script>

<script lang="ts">
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
  import type { WithElementRef } from "bits-ui";
  import { cn } from "$lib/utils.js";

  let {
    class: className,
    variant = "default",
    size = "default",
    ref = $bindable(null),
    href = undefined,
    type = "button",
    children,
    ...restProps
  }: ButtonProps = $props();
</script>

{#if href}
  <a
    bind:this={ref}
    data-slot="button"
    class={cn(buttonVariants({ variant, size }), className)}
    {href}
    {...restProps}
  >
    {@render children?.()}
  </a>
{:else}
  <button
    bind:this={ref}
    data-slot="button"
    class={cn(buttonVariants({ variant, size }), className)}
    {type}
    {...restProps}
  >
    {@render children?.()}
  </button>
{/if}
`;
}

/**
 * The `button/` barrel shadcn-svelte's imports resolve through.
 *
 * TypeScript, not JavaScript: it re-exports the component's prop types, and a
 * `.js` barrel would leave every import of it implicitly `any` under `strict`
 * (svelte-check fails on exactly that). Callers still write the `.js`
 * specifier — the TS ESM convention shadcn-svelte follows.
 */
function renderButtonIndex(): string {
  return `export {
  default as Button,
  buttonVariants,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from "./button.svelte";
`;
}

/** One `card-*.svelte` part. shadcn-svelte ships Card as a namespace of small parts. */
function cardPart(slot: string, tag: string, classes: string): string {
  return `<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { WithElementRef } from "bits-ui";
  import { cn } from "$lib/utils.js";

  let {
    class: className,
    ref = $bindable(null),
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<${tag}
  bind:this={ref}
  data-slot="${slot}"
  class={cn("${classes}", className)}
  {...restProps}
>
  {@render children?.()}
</${tag}>
`;
}

/** The `card/` barrel — the `* as Card` namespace the landing page imports. */
function renderCardIndex(): string {
  return `import Root from "./card.svelte";
import Content from "./card-content.svelte";
import Description from "./card-description.svelte";
import Footer from "./card-footer.svelte";
import Header from "./card-header.svelte";
import Title from "./card-title.svelte";

export {
  Root,
  Content,
  Description,
  Footer,
  Header,
  Title,
  //
  Root as Card,
  Content as CardContent,
  Description as CardDescription,
  Footer as CardFooter,
  Header as CardHeader,
  Title as CardTitle,
};
`;
}

export const sveltePreset: FrontendPreset = {
  id: "svelte",
  label: "SvelteKit",
  dependencies: {
    // shadcn-svelte's runtime surface. `bits-ui` is the headless primitive
    // library its components are built on (the Radix equivalent), and
    // `tailwind-variants` types the variants (the cva equivalent). clsx +
    // tailwind-merge back the `cn()` its components import from `$lib/utils`.
    // Pre-installed so `npx shadcn-svelte@latest add <component>` works
    // without a separate npm i.
    //
    // The icon package is `--icons`, merged in by renderPackageJson from
    // `iconBinding` below — see the React preset's note.
    "bits-ui": "^2.18.1",
    clsx: "^2.1.1",
    "tailwind-merge": "^3.0.1",
    "tailwind-variants": "^3.3.1",
  },
  devDependencies: {
    // The SDK's adapter (`@xano/sdk/sveltekit`) bundles its server half with
    // esbuild; Vite 8 does not install it.
    esbuild: "^0.28.1",
    // 2.70 peer-accepts vite ^8 and vite-plugin-svelte ^7 — the versions
    // pinned below. Bump this line and those two together.
    "@sveltejs/kit": "^2.70.2",
    // 7.x, matching what `sv create` installs. It peer-requires vite ^8, so
    // this line and the `vite` pin move together or not at all — and the React
    // preset's plugin has the same constraint, which is why the two presets
    // share one Vite major rather than each choosing.
    "@sveltejs/vite-plugin-svelte": "^7.1.2",
    "@tailwindcss/vite": "^4.1.5",
    "@types/node": "^20.19.43",
    svelte: "^5.56.9",
    "svelte-check": "^4.7.6",
    tailwindcss: "^4.1.5",
    "tw-animate-css": "^1.2.4",
    tsx: "^4.19.2",
    // 6.x, the major `sv create` pins. svelte-check peer-accepts `^5 || ^6`;
    // 7 is out but not yet in that range, so this tracks the canonical
    // scaffold rather than latest.
    typescript: "^6.0.3",
    vite: "^8.0.16",
  },
  // svelte-check REPLACES `tsc --noEmit` here rather than joining it.
  //
  // It is a superset: reading the same tsconfig, it checks `xano/`'s TypeScript
  // exactly as `tsc` would AND the components `tsc` cannot parse at all. Running
  // both is not merely redundant — `tsc` fails outright on the UI kit's barrels,
  // which re-export types from `.svelte` modules it only knows as default
  // exports. Verified against a real scaffold: a type error planted in
  // `xano/index.ts` and one planted in `App.svelte` are each caught by this
  // command alone.
  //
  // `svelte-kit sync` runs first, and is not optional: it generates
  // `.svelte-kit/tsconfig.json` (which the project's tsconfig extends) and the
  // route types. Without it svelte-check fails on a missing extends target
  // rather than on anything the user wrote.
  checkCmd: "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
  // SvelteKit supplies `$lib` on both sides — the Vite alias from its plugin
  // and the tsconfig path from the config it generates. Declaring either by
  // hand would be a second source of truth that can silently disagree.
  aliasName: null,
  aliasTarget: "frontend/src/lib",
  tsconfigPaths: {},
  tsconfigExtends: "./.svelte-kit/tsconfig.json",
  // What `svelte-kit sync` generates and the extended config lists — re-added
  // because our `include` replaces that config's rather than merging with it.
  // These are the declarations behind `$app/*`, `$env/*`, and `./$types`.
  tsconfigInclude: [
    ".svelte-kit/ambient.d.ts",
    ".svelte-kit/env.d.ts",
    ".svelte-kit/non-ambient.d.ts",
    ".svelte-kit/types/**/$types.d.ts",
  ],
  // `prepare` runs on `npm install`, so a fresh clone has `.svelte-kit/`
  // before anything reads tsconfig.json.
  extraScripts: { prepare: "svelte-kit sync" },
  // shadcn-svelte's generated components import these from `$lib/utils.js`
  // alongside `cn()`. Without them the scaffold type-checks until the first
  // `npx shadcn-svelte@latest add <name>` — which the agent guidance tells
  // assistants to run — and then fails inside components the user never wrote,
  // with an error naming a file they have no reason to suspect.
  //
  // Verbatim from shadcn-svelte's own utils.ts, so a component the CLI writes
  // resolves against exactly what upstream expects.
  libUtilsExtra: `
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
`,
  gitignoreEntries: [".svelte-kit/"],
  // No `jsx`. `verbatimModuleSyntax` is what svelte-check expects so that
  // type-only imports in components are erased rather than emitted.
  tsconfigOptions: { verbatimModuleSyntax: true },
  viteImports: [
    `import { sveltekit } from "@sveltejs/kit/vite";`,
    `import adapter from "@xano/sdk/sveltekit";`,
    `import tailwindcss from "@tailwindcss/vite";`,
  ],
  // tailwindcss() before sveltekit() — the order Tailwind v4 documents for
  // SvelteKit, so the stylesheet is processed before Kit consumes the graph.
  //
  // The whole SvelteKit config rides in the sveltekit() call. There is no
  // svelte.config.js by design — see renderSvelteKitPlugin().
  vitePlugins: ["tailwindcss()", renderSvelteKitPlugin()],
  // SvelteKit resolves its own paths from this file's directory and redirects
  // them into frontend/ via `files`; moving Vite's root under it puts the two
  // into disagreement. Output is the adapter's job, not `build.outDir`.
  viteRoot: null,
  viteBuild: null,
  // SvelteKit owns the page template — frontend/src/app.html. No `entryScript`
  // follows: there is no shared index.html for it to point at.
  ownsHtmlEntry: true,

  files(
    vars: TemplateVars,
    landing: LandingContent,
    choice: ThemeChoice = defaultThemeChoice(),
  ): ScaffoldFile[] {
    const ui = "frontend/src/lib/components/ui";
    return [
      { path: "components.json", content: renderComponentsJson(choice) },
      { path: "frontend/src/app.html", content: renderAppHtml(vars, choice) },
      // Only for `--dark toggle` — see the React preset's note.
      ...(choice.dark === "toggle"
        ? [
            {
              path: "frontend/src/lib/components/mode-toggle.svelte",
              content: renderModeToggleSvelte(iconLibraryOf(choice.icons).svelte),
            },
          ]
        : []),
      { path: "frontend/src/app.d.ts", content: renderAppDts() },
      { path: "frontend/src/routes/+layout.ts", content: renderLayoutTs() },
      { path: "frontend/src/routes/+layout.svelte", content: renderLayoutSvelte() },
      { path: "frontend/src/routes/+page.svelte", content: renderApp(landing, choice) },
      { path: "frontend/src/routes/+error.svelte", content: renderErrorSvelte() },
      { path: "frontend/src/routes/404/+page.svelte", content: renderNotFoundRoute() },
      { path: "frontend/src/lib/components/error-state.svelte", content: renderErrorState() },
      // `kit.files.assets` points here: static files copied to the site root
      // verbatim. A README rather than a .gitkeep because this one gets
      // PUBLISHED — everything here lands in frontend/dist, so the placeholder
      // that keeps the directory in git is a file real users will see deployed.
      {
        path: "frontend/static/README.md",
        content: `Files here are copied to the site root as-is — \`favicon.png\` is served
at \`/favicon.png\`. Reference them from a component with a root-relative
path, or from \`app.html\` via \`%sveltekit.assets%\`.

Delete this file once you add something real.
`,
      },
      { path: `${ui}/button/button.svelte`, content: renderButtonSvelte() },
      { path: `${ui}/button/index.ts`, content: renderButtonIndex() },
      {
        path: `${ui}/card/card.svelte`,
        content: cardPart(
          "card",
          "div",
          "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        ),
      },
      {
        path: `${ui}/card/card-header.svelte`,
        content: cardPart(
          "card-header",
          "div",
          "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        ),
      },
      {
        path: `${ui}/card/card-title.svelte`,
        content: cardPart("card-title", "div", "leading-none font-semibold"),
      },
      {
        path: `${ui}/card/card-description.svelte`,
        content: cardPart("card-description", "div", "text-sm text-muted-foreground"),
      },
      {
        path: `${ui}/card/card-content.svelte`,
        content: cardPart("card-content", "div", "px-6"),
      },
      {
        path: `${ui}/card/card-footer.svelte`,
        content: cardPart("card-footer", "div", "flex items-center px-6 [.border-t]:pt-6"),
      },
      { path: `${ui}/card/index.ts`, content: renderCardIndex() },
    ];
  },

  iconBinding(id: IconLibraryId | undefined): IconBinding {
    return iconLibraryOf(id).svelte;
  },

  readmeFrontendSection(icons?: IconLibraryId): string {
    return `[SvelteKit](https://svelte.dev/docs/kit) with Svelte 5, styled with
[Tailwind CSS](https://tailwindcss.com) v4 and
[shadcn-svelte](https://shadcn-svelte.com).

Pages live in [\`frontend/src/routes/\`](frontend/src/routes/) — \`+page.svelte\`
is a page, a subdirectory is a nested route. Routes are **prerendered**: each
becomes its own HTML document at build time, so a page loads as itself rather
than as a shell that fills in afterwards, and an unmatched path returns a real
404 from [\`+error.svelte\`](frontend/src/routes/+error.svelte).

> **There is no server.** \`npm run xano:deploy\` ships this app to a static host
> with no runtime of its own; Xano is the backend, reached through
> [\`frontend/src/lib/api.ts\`](frontend/src/lib/api.ts). So \`+page.server.ts\`,
> form actions, and server \`load\` have nothing to run on — and **nothing warns
> you**: a project using them builds and deploys green, then fails in the
> browser. Treat them as unavailable. That is the trade — the backend is
> authored in [\`xano/\`](xano/) as TypeScript and deployed alongside the
> frontend, so it is a real backend, just not this one.
>
> \`frontend/src/routes/+layout.ts\` sets \`prerender = true\` for the whole app.
> Because prerendering renders at build time, module-scope \`window\`/\`document\`
> access now fails the **build** rather than the browser — use \`onMount\`, or
> guard with \`import { browser } from "$app/environment"\`.

**A dynamic route fails the build until it says how it renders.** A route like
\`/posts/[id]\` cannot be prerendered unless the build knows which ids exist, so
the build stops and names it. For rows created at runtime (the usual detail
page), render it in the browser:

\`\`\`ts
// frontend/src/routes/posts/[id]/+page.ts
export const prerender = false;
\`\`\`

The host has no file for \`/posts/42\`, so it answers with \`404.html\`, which the
SDK's adapter (\`@xano/sdk/sveltekit\`, in \`vite.config.ts\`) writes as the app
shell: it boots the app and renders the route, so a reload or a deep link works
(the response status is still 404). Only for ids known at build time, list them
instead — each gets its own page, and no other id has one:
\`export const entries = () => [{ id: "1" }, { id: "2" }];\`

[\`frontend/src/routes/404/+page.svelte\`](frontend/src/routes/404/+page.svelte)
prerenders to \`404.html\` while every route is prerendered, which is what makes
an unmatched path return a real 404. It has to be a route: SvelteKit never
prerenders \`+error.svelte\` to a file. Once a route sets \`prerender = false\`,
the adapter writes the app shell there instead, and an unmatched path renders
\`+error.svelte\` in the browser, still with a 404.

shadcn-svelte is not a dependency —
its components are copied into
[\`frontend/src/lib/components/ui/\`](frontend/src/lib/components/ui/) and owned by
this project, so edit them freely. \`Button\` and \`Card\` are already there; add
more with:

\`\`\`bash
npx shadcn-svelte@latest add dialog input form
\`\`\`

[\`components.json\`](components.json) is pre-configured, so that works with no
\`shadcn-svelte init\` step. ${iconLibraryOf(icons).guidance.svelte}

\`\`\`ts
${iconLibraryOf(icons).svelte.arrowImport}
\`\`\`

[\`frontend/src/routes/+page.svelte\`](frontend/src/routes/+page.svelte) already
does, and that is the form \`npx shadcn-svelte@latest add\` writes too.

Components import through the \`$lib\` alias
(\`$lib/components/ui/button\`, \`$lib/utils\`), which SvelteKit points at
\`frontend/src/lib/\` via \`kit.files\` in
[\`vite.config.ts\`](vite.config.ts) — there is no \`paths\` entry to keep in
sync, and adding one would just be a second answer that can disagree.

Colors come from the theme tokens in
[\`frontend/src/index.css\`](frontend/src/index.css) — see **Theming** below.

> \`npm run typecheck\` runs \`svelte-kit sync && svelte-check\`, not \`tsc\`. It
> checks both halves — the backend's TypeScript and the components — where
> \`tsc\` cannot read \`.svelte\` files at all. Keep it in the script: it is what
> makes the frontend unable to drift from the backend defs. \`sync\` regenerates
> \`.svelte-kit/\`, which \`tsconfig.json\` extends; \`npm install\` runs it too.`;
  },

  agentGuidanceSection(icons?: IconLibraryId): string {
    return `- \`frontend/src/\` — the SvelteKit app. Svelte 5 + Tailwind v4 + shadcn-svelte.
  - **There is no server.** This deploys to a static host with no runtime, and
    Xano is the backend. Never write \`+page.server.ts\`, \`+layout.server.ts\`,
    form actions, or server \`load\` — reach the backend through
    \`frontend/src/lib/api.ts\` instead, and never stand up a second backend here.
  - **The build will not stop you.** A project containing \`+page.server.ts\`
    compiles and deploys green, then fails in the browser on the live site. A
    passing build is not evidence that a server feature works — there is
    nothing to run it.
  - \`frontend/src/routes/\` — file-based routing. A page is \`+page.svelte\`, a
    nested route is a subdirectory. **Routes live under \`frontend/src/\`, not a
    top-level \`src/\`** — \`files\` in the \`sveltekit()\` plugin config in
    \`vite.config.ts\` points SvelteKit here. A file added under a top-level
    \`src/routes/\` is not a route and is never served.
  - **Routes are prerendered.** \`frontend/src/routes/+layout.ts\` sets
    \`prerender = true\` for the whole app, so every route is rendered to its own
    HTML document at build time and served as a real page. A static route needs
    nothing registered — add \`+page.svelte\` and it works.
  - **Prerendering renders at BUILD time**, so module-scope \`window\`/\`document\`
    access now breaks the build, not the browser. Use \`onMount\`, or guard with
    \`import { browser } from "$app/environment"\`. This is a page option, not a
    server — do not "fix" it by reaching for \`ssr\` or a server file.
  - **A dynamic route fails the build until it says how it renders.**
    \`/posts/[id]\` cannot be prerendered unless the build knows which ids exist.
    For rows created at runtime (a detail page), export
    \`const prerender = false\` from that route's \`+page.ts\`: the host answers
    it with the \`404.html\` app shell the SDK's adapter writes, which renders it
    in the browser, so reloads and deep links work. \`entries\` only fits ids
    known at build time — any other id has no page.
  - \`frontend/src/routes/404/+page.svelte\` prerenders to \`404.html\`, which is
    what makes an unmatched path return a real 404 instead of silently serving a
    page with a 200. Keep it: without it a missing asset comes back as HTML and
    the browser reports \`Unexpected token '<'\`. It has to be a route — SvelteKit
    never prerenders \`+error.svelte\` to a file, so that alone would ship no
    \`404.html\`.
  - Keep the adapter in \`vite.config.ts\` (\`@xano/sdk/sveltekit\`). Do NOT
    swap in \`@sveltejs/adapter-static\` with a \`fallback\`: it writes an empty
    shell over the prerendered home page.
  - Data loading: call \`api.ts\` from the component, or from a universal
    \`+page.ts\` \`load\` if you need it before render. Both run in the browser.
  - \`frontend/src/lib/components/ui/\` — shadcn-svelte components, **copied in and
    owned by this project**. Edit them directly; there is no library to configure
    around.
  - Need one that isn't there? \`npx shadcn-svelte@latest add <name>\` — do not
    hand-roll it, and do not add a different component library. Note the
    \`-svelte\` suffix: the plain \`shadcn\` CLI writes React and will not work here.
  - ${iconLibraryOf(icons).guidance.svelte.replace(/\n/g, "\n    ")}
  - That import form is what \`frontend/src/routes/+page.svelte\` already uses and
    what \`npx shadcn-svelte@latest add\` writes, so matching it keeps what you
    write consistent with what the CLI generates beside it. Do not add another
    icon library and do not paste raw inline \`<svg>\` markup.
  - Import via the \`$lib\` alias (\`$lib/components/ui/button\`, \`$lib/utils\`),
    which SvelteKit generates for both TypeScript and the bundler. Do not add a
    \`paths\` entry for it — a hand-written one is a second source of truth that
    can disagree with the generated one.
  - Components are Svelte 5 **runes** (\`$props()\`, \`$bindable()\`,
    \`{@render children?.()}\`) — not the Svelte 4 \`export let\` / slot API. Runes
    mode is FORCED in \`vite.config.ts\`, so \`export let\` is a compile error
    naming the file rather than a component that quietly builds in legacy mode.
    Do not "fix" that error by relaxing \`compilerOptions.runes\` — write the
    rune.
  - \`npm run typecheck\` runs \`svelte-kit sync && svelte-check\`, which checks both
    \`xano/\` and the components. Do not swap it for \`tsc --noEmit\`: \`tsc\` cannot
    read \`.svelte\` files and fails on the UI kit's barrels. \`sync\` regenerates
    \`.svelte-kit/\`, which \`tsconfig.json\` extends — run it after adding a route.`;
  },
};
