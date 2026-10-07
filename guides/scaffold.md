# The scaffolded project

What `xanosdk init` writes, the two frontend presets, a project with no frontend, adding the backend to an existing app, theming, add-ons, and the SvelteKit prerendering rules.

## init flags and add-ons

`init` flags: `--framework <react|svelte|none>` (default: `react`; `none` writes the
backend alone — see [No frontend, and existing apps](#no-frontend-and-existing-apps)), `--name <name>`
(default: the folder name), `--theme <id>` / `--radius <len>` / `--dark <mode>` /
`--font <id>` / `--font-mono <id>` / `--font-heading <id>` / `--icons <id>`
(the look — see [Theming](#theming)), `--no-agents-md` (skip the `AGENTS.md`
agent brief, which every coding agent reads and `init` writes by default),
`--marketplace <pkg>` (repeatable, comma-separated; installs add-ons and
registers them — below), `--force` (write over what clashes when adding the backend to
a non-empty folder; it lists the files and scripts it would overwrite and asks, `--yes`
answering without a terminal — files it does not write are kept),
`--no-install` (skip `npm install`), `--web` (choose all of the above in a
browser instead — see [Choosing in a browser](#choosing-in-a-browser)),
`--from <source>` (fill `xano/` from an existing backend — any
[backend spelling](cli.md#naming-a-backend) or a bundle path — rather than the
starter — see [Pulling an existing workspace](codegen.md); over an existing `xano/` it lists
what it replaces and asks, and `--yes` answers without a terminal).
In a terminal, `init` prompts for the framework in an empty or missing folder
(React, Svelte, or "No frontend"); the prompt has a default, so pressing enter is a
valid answer. A folder that already has files gets no prompt and no frontend. The look
is never prompted for — it comes from the flags above, or from `--web`.
The starter backend is empty but already compiles and deploys — grow it from the
walkthrough in `xano/EXAMPLE.md`.

A scaffold ships `@xano/sdk` and nothing else from the `@xano-sdk` scope. Add-ons
install on demand:

```bash
xanosdk marketplace list                      # every published add-on
xanosdk marketplace search auth               # …or narrow by keyword
xanosdk marketplace details @xano-sdk/auth      # what it installs + how to register it
xanosdk marketplace install @xano-sdk/auth      # add it to the project you're in
```

The three read verbs hit a public catalogue, so they work before you log in.
Every add-on is optional and none is assumed by anything in the scaffold —
install one when you need it. [The marketplace](marketplace.md) covers all six
verbs, what each one does to a project, and how an add-on is configured.

`init` takes the same package names, so a project can be scaffolded with its
add-ons already wired:

```bash
xanosdk init my-app --framework react --marketplace @xano-sdk/auth,@xano-sdk/vector
```

That installs each package **and** writes its registration into `xano/index.ts`.
Installing alone would leave dependencies nothing imports — a different project
wearing the same name. A module declares how it registers in its own
`package.json` (`"xanosdk": { "register": "registerAuth" }`); one that has not
adopted the field is read for a single `register*` export, and two of those
without the field is a refusal rather than a guess.

The field is also where a module declares what its register call needs
(`"options"`). An add-on whose call takes an option nothing has declared — a URL
into your own frontend, your own role model — is installed but left
**unregistered**, named in `xano/index.ts` with the call to uncomment once you
have the value. A scaffold that compiles with an add-on switched off beats one
that does not compile at all.

Each `--marketplace` name is resolved through the marketplace first, exactly as
`xanosdk marketplace install` resolves it: a module's package or its slug
(`--marketplace auth` installs `@xano-sdk/auth`, never npm's unrelated `auth`). A
name the marketplace does not list stops `init` with **exit 8** before it writes
anything. So does a package name the npm registry does not have — the same rule
`--framework` and `--theme` follow, so a typo costs nothing and leaves nothing to
clean up. The check asks about the NAME, from the
directory the install will run in, so it reads the same `.npmrc` the install
does. (A package published minutes ago can 404 until the registry replicates
it; if the name is right, retry.) A version or tag that does not resolve is not
its business — that falls through to the install, whose error says which.
A local path (`./my-module`, `file:../my-module`) is read from where you typed it.
Under `--no-install` only a directory holding a `package.json` can be recorded (as
`file:`); a tarball, URL or git spec is refused, since its name is unknown until installed.

An install that fails for any other reason — an unreachable registry, a proxy —
is not fatal: the scaffold is written without that add-on, npm's own diagnosis
is printed, and the run ends on `Project ready, without 1 add-on.` with **exit
code 2**. The project is usable; add the missing package with `xanosdk
marketplace install <package>`. `--from` and `--marketplace` do not compose, and
saying both is a usage error rather than a silently add-on-less project.

When the project's OWN `npm install` fails (with or without add-ons), `init` also
exits **2**: every file is written and correct, but nothing in the project can be
loaded until its dependencies are, so the run does not end on `Project ready.`.
Fix what npm reported and run `npm install` in the project — nothing needs to be
scaffolded again.

Declaring `"options"` is all or nothing: it states what the whole argument is,
and is taken at its word without the function being read. A module that needs an
option only you can answer omits the key rather than declaring the rest, which is
what lets the CLI find the argument and leave the module out.

`@xano-sdk/auth` is **authentication, not authorization** — user/login/signup
tables and the endpoints over them. It ships no roles, permissions, or route
guards, so it is not the RBAC answer. Its `user` table has a `role` column, but
the tokens it mints carry no role claim, so a check on the token finds nothing.
Check the caller's row instead: spread `...guard.role(userTable, "admin")` into
the stack of each query whose `auth` is `userTable`. It loads the caller's row,
rejects a missing one (401), then checks the role (403).

`details` is the one to reach for when wiring an add-on: it prints the objects
the add-on puts on your workspace, what you have to supply, and the
`xano/index.ts` registration to copy. Piped, it emits JSON; `--prompt` emits
instructions written to be handed straight to a coding agent.

That is `npm install` with two additions: add-ons are discoverable from `xanosdk
--help`, and the command refuses before npm runs when you are not standing in a
project — the mistake npm answers by silently writing to the wrong `package.json`.
The package name is passed through exactly as typed, so version specifiers, tags,
and third-party packages all work.

## No frontend, and existing apps

`init` reads its target directory before it writes anything. An empty or missing directory
is a **new** project, and `--framework` decides its frontend. Any other directory is an
**existing** project, which has its own app and gets the backend only.

**A new project with `--framework none`** (or "No frontend" at the prompt) gets everything
above except the frontend: `xano/`, a `package.json` with only the backend's scripts and
dependencies, `.gitignore`, `.gitattributes`, the CI check, a README and `AGENTS.md`. There is
no `frontend/` and no root `tsconfig.json`; `xano/` type-checks under its own
`xano/tsconfig.json`, and `npm run xano:typecheck` checks it and its lambdas.
`xano:deploy:ephemeral` deploys the backend alone, and there is no `dev`, `build` or
`xano:deploy:frontend`.

**An existing project** (any non-empty directory) gets:

- `xano/`, the same starter a new project gets. When the project's `package.json` is not
  `"type": "module"` (Next.js and `npm init -y` write one that is not), `init` also writes
  `xano/package.json` holding only `{"type": "module"}`, so `xano/` loads as ES modules
  without changing the project's own type.
- The `xano:*` scripts and the backend's dependencies merged into `package.json`. The
  project's entries win: a dependency it already has keeps its range, a script it already
  has keeps its command, and no other key changes (an add-on's settings under `"xanosdk"`
  aside). The file keeps its indentation and line endings. A project with no
  `package.json` gets one holding only what the backend needs.
- A marked block in `.gitignore` (created when missing) and in `AGENTS.md`, added or
  refreshed in place; the rest of each file is left as it was. A symlinked `AGENTS.md` is left
  alone, and `--no-agents-md` skips it.
- No frontend, README, CI workflow or root `tsconfig.json`. The line-ending rule goes in
  `xano/.gitattributes`, scoped to `xano/`, so the project's own files are not renormalized.

What would be written over is a **clash**: an existing `xano/`, any other file `init` writes
that is already there, and a `xano:*` script the project defines with a different command (the
same command is no clash). `init` lists every clash and writes nothing; `--force` lists what it
overwrites and asks first. A `package.json` that is not valid JSON is refused, since there is
nothing to merge into.

`--framework react` or `--framework svelte` in a non-empty directory is refused, as are the
frontend-only flags (`--theme`, `--radius`, `--dark`, `--font`, `--font-mono`,
`--font-heading`, `--icons`) wherever no frontend is written. After the merge, `npm run
xano:deploy` runs the backend on the Xano Engine as it does in a new project.

If the project's own root `tsconfig.json` includes every `.ts` file (Next.js's does), add
`"xano/lambdas"` to its `exclude` before adding the first lambda: the lambda globals
type-check only under `xano/lambdas/tsconfig.json`. `init` leaves that file alone, and the
`AGENTS.md` it writes says the same.

## Git and CI

A new project gets a `.gitattributes` and a `.github/workflows/check.yml` (`xanosdk-<dir>.yml`
below the repository root, so moving it up never replaces another workflow). An existing
project gets no workflow, and its line-ending rule is scoped to `xano/`; run
`npm run xano:check` from its own CI.

The attributes file normalizes line endings, so any generated artifact the project
commits is byte-identical on every checkout and a `--frozen-lock` check cannot fail
over a contributor's `core.autocrlf` rather than over a real change.

The workflow installs with the project's package manager (npm, pnpm, yarn or bun, as
`init` detected it), frozen to the committed lockfile, then runs `xano:check` on every push
and pull request. In a monorepo workspace member it installs at the workspace root and checks
in the member's directory; move the file to the repository root's `.github/workflows/`, the
only place GitHub reads it. That script
runs `xanosdk export ./xano/index.ts --check --strict`: every check an export runs (a build warning fails it), under
`--frozen-lock`, writing nothing — no bundle, no lock. Because nothing is written, it
reads no `xano/.env` or `xano/.secrets.json`, so the workflow needs no repository
secrets, even for an API group whose docs are token-gated. It fails instead of
rewriting when `xano.lock` disagrees with the source, naming what would change. A
project with nothing to record yet (a fresh scaffold) passes without a lock. It also fails while the lock
carries an entry no exported object matches — the state a rename leaves until
`lock rename` moves the identity across, or `lock prune` drops it. It first runs
`xanosdk routes ./xano/index.ts --emit xano/routes.gen.ts --strict`, which fails when
the committed route manifest the frontend takes its paths from is stale or missing.
`dev`, `build` and `typecheck` regenerate that file, so after adding or renaming an
endpoint run `npm run xano:routes` (or any of them) and commit it. `init --from` and
`pull` write it with the decoded backend, and `init --marketplace` writes it (and
`xano/xano.lock`) for an add-on that brings endpoints, so each of those passes the check
as it stands. It installs with
`npm ci` whenever a lockfile is committed, since `package.json` allows a
`@xano/sdk` range that the lock pins and an open install would rebuild derived
state with a newer patch, failing the check on a change that touched nothing.

**Regenerate after any merge.** A clean merge is not evidence that derived state is
correct: two branches that change different objects merge with no conflict while one
side's derived files were written before the other's source change existed. Nothing
in git can see it, because at the text level the two sides never touched the same
file — the check is what catches it. Pair the workflow with "Require branches to be
up to date before merging" so a pull request approved against an older base is
re-checked before it lands.

## Toolchain modules

A **toolchain module** extends the CLI rather than the workspace. It adds no tables
or endpoints and is never registered in `xano/index.ts`; instead it contributes
questions, lines for the files above, and hooks that run on `export` and `deploy` —
after the compile, before anything is uploaded. Its per-project settings live in this
project's `package.json` under `"xanosdk"`, keyed by package name, so a choice made
once survives to every later run.

Those questions are asked wherever the project is reconciled — at `init`, and in a
project that already exists. **`xanosdk marketplace install <package>` is not just
`npm install`:** it runs the module's questionnaire and writes both its settings and
the `.gitattributes` lines it contributes. A module that arrived any other way — a
plain `npm install`, a merged pull request, a `git pull` that changed
`package.json` — is configured by running `xanosdk marketplace install` on it; until
then `export` and `deploy` report it as installed but never configured, and it runs
on its own defaults.

**`xanosdk marketplace reinstall <package>`** re-asks the questions, offering this
project's current settings as the defaults, and switches a module back on if it was
turned off. **`xanosdk marketplace remove <package>`** uninstalls it and drops its
settings and its contributed lines together. A plain `npm uninstall` leaves the
`"xanosdk"` block behind, and a package that block names but that is no longer
installed fails every `--frozen-lock` run until you run `reinstall` or `remove`.

A module that owns a generated directory also contributes the `.gitattributes`
lines that make it render and diff like source, and its own check rides on the
same `--frozen-lock` run, so a stale tree fails CI beside a stale lock.

Never hand-edit a file a module generates, and never hand-resolve a conflict in one.
The correct content is whatever the source renders to, so the only valid resolution
is to re-run the export.

Writing one is [The module contract](module-contract.md): the manifest fields, the
`@xano/sdk/plugin` types, every hook, and the shapes the SDK refuses.

## Choosing in a browser

`--web` collects the same choices against a live preview instead of on the
command line:

```bash
xanosdk init my-app --web
```

It is a launcher, not a second scaffolder: a configurator is downloaded on
demand, serves a local page, and finishes by running `init` with the flags your
choices imply — printing the equivalent command so the project stays
reproducible from a script. Everything after `--web` is passed to it untouched,
including `--help`, which is why that one form reaches the network. `xanosdk help
init` stays offline, like `init` itself.

Because the configurator is fetched at run time, `--web` needs the npm registry
before it can start. `init` on its own reaches out only to install the new
project's dependencies, which `--no-install` skips — `--marketplace` add-ons
included: they are added to `package.json` without being installed, and wired
into `xano/index.ts` by hand after `npm install`.

## The frontend preset

To point `npm run dev` at a real backend, copy `.env.example` to `.env.local` — both
live at the **project root**, next to `vite.config.ts` — and set `VITE_XANO_HOST` to a
deployed URL. Deployed builds don't need it: `xanosdk deploy <entry> --static <dir>` injects the
backend URL as `window.XANO_HOST`, which takes precedence.

The frontend ships `Button` and `Card` already vendored, plus a pre-configured
`components.json`, so `npx shadcn@latest add dialog form input` (or
`npx shadcn-svelte@latest add …` on a Svelte scaffold) works immediately — no
`init` step for either CLI. Components are copied into your repo rather than
installed, so you own and edit them directly. [Lucide](https://lucide.dev/icons)
is installed on both scaffolds — `lucide-react` on React, `@lucide/svelte` on
Svelte — and the landing page already uses it.

## Theming

shadcn components carry no colors of their own: they are Tailwind utilities over
a fixed set of semantic tokens (`--primary`, `--muted-foreground`, `--border`,
the `--chart-*` ramp, the `--sidebar-*` set). Those tokens live at the top of
`frontend/src/index.css`, which is the whole theme — Tailwind v4 keeps it in CSS,
and there is no `tailwind.config.js`. That one stylesheet backs both frameworks.

`init` renders it from a theme you choose, using shadcn's own two-part model:

```bash
xanosdk init my-app --theme zinc-blue     # a base color, plus an accent over it
xanosdk init my-app --theme stone         # a base color alone
xanosdk init my-app --theme zinc --radius 0
```

Base colors — the full token set: `neutral` (default), `stone`, `zinc`, `mauve`,
`olive`, `mist`, `taupe`. Accents — a partial override of `primary`, `secondary`,
the chart ramp, and the sidebar primary: `amber`, `blue`, `cyan`, `emerald`,
`fuchsia`, `green`, `indigo`, `lime`, `orange`, `pink`, `purple`, `red`, `rose`,
`sky`, `teal`, `violet`, `yellow`. The values are shadcn's, verbatim, so
`--theme zinc-blue` is what ui.shadcn.com hands out for the same pair.

`--theme` also takes any shadcn **registry theme** — its own, a third-party
generator's, or your team's:

```bash
xanosdk init my-app --theme https://ui.shadcn.com/r/themes/slate.json
xanosdk init my-app --theme ./brand-theme.json
```

`--radius <len>` overrides the corner radius (a bare number is rem). Everything
else about the project is identical whichever theme you pick, and you can change
your mind later by editing the token values — or by applying another theme over
them with `npx shadcn@latest add <registry-theme-url>`.

### Dark mode

Every theme ships a complete dark palette. `--dark` decides what turns it on:

- `system` (default) — an inline script in the HTML entry applies the OS setting
  before first paint, so the page never flashes light first. No UI.
- `toggle` — that, plus `frontend/src/lib/theme.ts` (the persisted mode) and a
  mode toggle on the landing page cycling system → light → dark.
- `off` — light only. The `.dark` block is still there and still complete.

Whichever you pick, style with the token classes (`bg-primary`,
`text-muted-foreground`) rather than raw palette classes like `bg-gray-100`:
raw ones ignore the theme and are unreadable in dark mode. The scaffolded AI
instruction files say so too.

### Typefaces and icons

Fonts are opt-in and **self-hosted**: each choice installs an `@fontsource`
package rather than linking Google's CDN, which would be a third-party request
on every page load of your app, a failure behind a firewall, and a privacy
question someone inherits later.

```bash
xanosdk init my-app --font geist --font-heading instrument-serif --icons tabler
```

- `--font <id>` — body text (Tailwind's `--font-sans`, which v4 also uses as the
  page default). Sans faces only: `geist`, `inter`, `figtree`, `manrope`,
  `dm-sans`, `space-grotesk`, `outfit`, and 10 more.
- `--font-mono <id>` — code. `jetbrains-mono` or `geist-mono`.
- `--font-heading <id>` — headings. Accepts **any** face, sans or serif, since a
  display serif over a sans body is the reason the slot exists. It emits a
  base-layer rule, so headings pick it up without touching every `<h1>`.
- Omit a slot and it keeps Tailwind's default stack, installing nothing for it.

An unknown id fails at `init` naming the slot it was resolving, so `--font-mono
inter` is an error rather than a proportional face quietly rendering your code
blocks.

`--icons <id>` picks the icon set: `lucide` (default), `tabler`, or `phosphor`.
The binding covers the dark-mode toggle's icons as well as the landing page's —
without that, `--icons tabler --dark toggle` would emit a toggle importing a
library the project no longer installs, a build failure from a flag with nothing
to do with dark mode.

> On a Svelte scaffold `npm run typecheck` runs `svelte-kit sync && svelte-check`
> (after `xano:routes`) rather than `tsc`. It checks the backend and the components together — `tsc`
> cannot read `.svelte` files at all.

> **The SvelteKit scaffold prerenders every route.** `frontend/src/routes/+layout.ts`
> sets `prerender = true`, so each route becomes its own HTML document at build
> time and loads as a real page. Pages live in `frontend/src/routes/`, and `files`
> in the `sveltekit()` plugin config keeps the project single-rooted with `xano/`
> as a peer. That config lives in `vite.config.ts` — there is no
> `svelte.config.js`, matching where SvelteKit's own scaffold now puts it.
>
> There is still no server at runtime — Xano is the backend and `deploy --static`
> ships to a host with no runtime, so `+page.server.ts`, form actions, and server
> `load` have nothing to run on, and the build does not stop you. Treat them as
> unavailable rather than trusting a green build.
>
> Two things follow from prerendering. Because it renders at build time,
> module-scope `window`/`document` access fails the **build** rather than the
> browser — use `onMount`, or guard with `browser`. And a dynamic route like
> `/posts/[id]` **fails the build** until it says how it renders. For rows
> created at runtime (the usual detail page), render it in the browser:
>
> ```ts
> // frontend/src/routes/posts/[id]/+page.ts
> export const prerender = false;
> ```
>
> The scaffold builds with the SDK's adapter (`@xano/sdk/sveltekit`), which then
> writes `404.html` as the app shell: the host answers `/posts/42` with it, and it
> boots the app and renders the route, so a reload or a deep link works (with a
> 404 status). `export const entries = () => [{ id: "1" }]` fits only ids known at
> build time — no other id gets a page. While every route is prerendered,
> unmatched paths get a real 404 from `frontend/src/routes/404/+page.svelte`,
> which prerenders to `404.html`. It has to be a route: SvelteKit never
> prerenders `+error.svelte` to a file.
>
> One more build-time check comes with prerendering: a hash link to an id that is
> not on the page it renders on — `<a href="#pricing">` with no `id="pricing"` —
> **fails the build**, naming the route and the id. A hash nav in
> `+layout.svelte` is exempt on `/404` only, since that route inherits the layout
> and by definition carries none of the page's sections.
