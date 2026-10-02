# The module contract

How to build a Xano SDK add-on: the manifest fields both kinds of module declare, the `@xano/sdk/plugin` types a toolchain module compiles against, every hook and when it fires, and the shapes the SDK refuses rather than absorbs.

An add-on is an ordinary npm package. It becomes a Xano SDK module by describing itself in a
`"xanosdk"` field in its own `package.json`, which is the only description of a package that
ships with the package. Everything below is that field plus, for a toolchain module, the
default export of one file.

Read [The marketplace](marketplace.md) first for the user-facing side: what `install`,
`reinstall` and `remove` do to a project, and what your module's settings look like once they
land in it.

## Which kind are you writing?

|  | Workspace module | Toolchain module |
|---|---|---|
| Extends | the deployed workspace | the CLI |
| Declares | `"register"`, `"returns"`, `"options"` | `"kind": "toolchain"`, `"plugin"` |
| Ships | tables, endpoints, functions, agents | questions, file contributions, hooks |
| Wired by | an import and a call in `xano/index.ts` | nothing: it is configured, not registered |
| Examples | `@xano-sdk/auth`, `@xano-sdk/vector` | `@xano-sdk/xanoscript` |

The `kind` field is what routes a package to one loader or the other. It defaults to
`workspace`, because every module published before the toolchain kind existed declares none
and defaulting the other way would strand them. A `kind` the SDK does not recognize is never
defaulted to one kind or the other: the failure a default would produce is a module reported
as unwired when its only fault is a typo in one string.

What that costs you depends on where the typo is read. `xanosdk init` refuses by name, with
the valid kinds listed, because a scaffold that silently drops your module is worse than one
that stops. Every other path, the marketplace verbs and the CLI's own module loading
included, warns and reads the package as an ordinary dependency rather than taking a whole
command down over one unrecognized string. Either way it is reported: nothing guesses which
loader you meant.

## Workspace modules

A workspace module exports a `register*` function that mutates a workspace and is called from
the user's `xano/index.ts`. It says how in its manifest:

```json
{
  "xanosdk": {
    "register": "registerAuth",
    "returns": "workspace",
    "options": { "canonical": { "value": "authn" } }
  }
}
```

| Field | Meaning |
|---|---|
| `register` | The exported function to call. Required for the declarative path. |
| `returns` | `"workspace"` or `"handle"`. Decides whether the call's result is bound to a name. |
| `options` | What the call's second argument needs, by option name. |

`options` entries take one of two forms. A **literal** is written into the generated file as
JSON, so nothing is imported for it:

```json
{ "canonical": { "value": "authn" } }
```

An **import** names another package's export, for a module that cannot be registered bare:

```json
{ "authTable": { "package": "@xano-sdk/auth", "export": "userTable" } }
```

### Declaring `options` is all or nothing

The field states what the **whole** argument is, and is taken at its word without your
register function being read. Declare `"options": {}` and the call is written bare.

**Omit the key and your module has said nothing either way**, so the SDK imports your entry
and measures `register`'s arity. A function that takes a second parameter nobody declared is
left **out** of the generated `xano/index.ts` rather than called without it, with a commented
call and a pointer to `xanosdk marketplace details <pkg> --prompt`. The call would not compile,
and a fresh scaffold that passes `npm run typecheck` is worth more than one that has your
module in it.

So: a module that needs an option only the user can answer (a URL into their own frontend,
their own role model) omits the key rather than declaring the rest. That is what lets the CLI
find the argument and leave the module out honestly.

Arity is a signal rather than a proof, because the published artifact is not the source.
`options?: Opts` and a default parameter downleveled to ES5 both report 2, and
`(xano, ...rest)` reports 1. Declaring the field is what settles it; nothing measured from
outside your module can.

### Registration must be a mutation

The generated file writes `registerX(app);` as a statement and default-exports `app`, in any
order. That is only correct because registration **mutates** the workspace it is handed.
Write your register function so it registers onto the instance it receives; `returns` only
decides whether the result is worth binding to a name, and is never load-bearing for
correctness.

### If you declare nothing

A module with no `"xanosdk"` field still works. Its installed entry is imported and searched
for a single export matching `/^register[A-Z]/`. Real exports are read, not prose, so nothing
can mistake a comment for code. Two matching exports is a refusal rather than a guess, and
the refusal says the manifest field is what settles it.

### Point somewhere useful

Declare a `homepage` in your `package.json`. It is where a refusal sends the reader when the
CLI cannot wire your module, and the installed manifest is the one place that says where
without the CLI knowing your package.

## Toolchain modules

A toolchain module declares its kind and the file whose default export is the plugin:

```json
{
  "name": "@acme/reviewable",
  "version": "1.0.0",
  "xanosdk": { "kind": "toolchain", "plugin": "./dist/plugin.js" },
  "peerDependencies": { "@xano/sdk": ">=1.0.0 <2.0.0" }
}
```

`@xano/sdk` is a **peer**, never a dependency. Your hooks are handed real compiled data, so
your module is only correct against the SDK versions whose shapes it understands. Write that
range out with a floor and a ceiling, as above: the ceiling is the next major, so a module
built for 1.x loads on every 1.x SDK and is refused on 2.0.

That range is **enforced at load**, on every command that discovers modules. An SDK outside it
is refused by name before your plugin file is imported, naming the range you asked for and the
version it got. So the floor is the version whose shapes your hooks understand, not an
aspiration — declare it accurately and the SDK will never quietly run your module against a
contract it was not built for. Ranges are read as `>=` / `>` / `<=` / `<` / `=` comparators,
`^`, `~`, exact pins and `||` unions of those; a shape outside that subset is not refused, it
is simply not checked.

### The import erases

```ts
import type { ToolchainPlugin, BundleContext } from "@xano/sdk/plugin";
```

`@xano/sdk/plugin` is a **types-only** entry. Nothing in it has a runtime representation, so
the import erases at compile time and your published bundle neither carries the SDK nor
resolves it at runtime. That matters because the SDK is the thing importing your plugin: a
plugin that pulled the SDK back in would load a second copy of the compiler into the process
already running one.

A plugin that wants the precise per-kind payload shapes can depend on `@xano/sdk/internal`
for them.

### The plugin

```ts
import type { ToolchainPlugin } from "@xano/sdk/plugin";

const plugin: ToolchainPlugin = {
  kind: "toolchain",
  questions: [...],
  contributes: (answers) => ({ ... }),
  answersFromConfig: (config) => ({ ... }),
  onBundle: async (ctx) => ({ ... }),
  onPreflight: async (ctx) => ({ ... }),
};

export default plugin;
```

`kind: "toolchain"` is repeated from the manifest so the two must agree. A plugin whose
default export does not say it is refused: the mismatch means one of the two is stale, and
guessing which would run code the manifest did not describe.

Every hook is optional. A module that only adds a `.gitattributes` line declares
`contributes` alone.

Five hooks, and deliberately no more. This contract was designed from one example, and a
contract designed from one example generalizes badly, so it covers exactly what that first
module needed and stops. The second toolchain module is the one that should widen it, with a
real second set of requirements in hand.

## Questions

A module declares questions as **data**, never as a prompt callback:

```ts
questions: [
  {
    id: "xanoscript",
    label: "Render the compiled workspace to a committed tree",
    type: "boolean",
    default: true,
  },
  {
    id: "dir",
    label: "Directory to render into",
    type: "string",
    default: "xanoscript",
    flag: "xanoscript-dir",
    when: (answers) => answers.xanoscript === true,
  },
]
```

| Field | Meaning |
|---|---|
| `id` | Stable key the answer is stored under. |
| `label` | One line shown to a human. No trailing punctuation. |
| `type` | `"boolean"`, `"string"` or `"choice"`. |
| `choices` | The allowed values, for `type: "choice"`. |
| `default` | Used when the question is not asked and nothing is stored. |
| `flag` | The long flag that answers it, without dashes. Derived from `id` when omitted. |
| `when` | Whether to ask at all, given the answers so far. |

Two reasons the callback form does not exist, and both are hard. A callback would let a
module hang a command on a TTY read in CI, where there is no one to answer it, and the SDK
could not even impose a timeout because it cannot tell a slow prompt from a slow computation.
And `xanosdk init --web` renders the questionnaire as a browser form, which can display a list
of choices but cannot run your callback at all. Declaring the question as data means the SDK
owns every way of answering it.

### Precedence

```
flag  >  the project's stored answer  >  your declared default
```

The middle rank is what makes a re-ask safe. A stored answer is both the prompt's default and
the non-interactive fallback, so re-running the questionnaire never quietly resets a
directory the user chose back to what you shipped. The machine output records which rank each
answer came from: `flag`, `prompt`, `config`, or `default`.

### The derived flag

Each question gets a long flag, from `flag` when you name one and from `id` otherwise.
Booleans get a `--no-` counterpart, because a question whose default is `true` is otherwise
unanswerable without a TTY. A `string` or `choice` question is answered with `--flag=value`
and never `--flag value`: your module is not loaded when the arguments are parsed, so the CLI
cannot know your flag takes a value and never consumes the following token.

**A collision is refused, not absorbed.** A flag matching one the CLI already owns
(`--name`, `--force`, `--framework`) would never reach you: the parser binds the real flag
first, so the SDK acts on a value meant for your module and your module quietly records its
default. Two wrong values, no message. Two modules deriving the same flag fail the same way
between them. Both are refused by name, naming your module and the command that hit it.

Declare an explicit `flag` when the derived name would read badly across several modules
(`--reviewable-dir` rather than `--dir`) or would collide.

### `when`, and what happens to a stale answer

A question `when` excludes is not asked **and no answer is recorded for it**. An unasked
question has no answer, and recording one would make a later `deploy` act on a choice nobody
made. On a re-ask that also deletes a stale key a previous run stored for it, and the
deletion is reported:

```
! @acme/reviewable: `dir` is no longer asked, so its stored setting was dropped.
```

A stored value the question no longer accepts (a choice you retired in an upgrade) is
replaced by your default and reported, rather than offered back as the prompt default.

`when` is evaluated against the answers so far, so a question can depend on one asked before
it in your own list.

## `contributes`

```ts
contributes: (answers) => ({
  gitattributes: answers.xanoscript ? [`${answers.dir}/** linguist-generated`] : [],
  config: { enabled: answers.xanoscript === true, dir: answers.dir },
}),
```

`contributes` is a **pure function from answers to contributions**. It has no knowledge of
which command is running and no access to the filesystem, and it may be called several times
in one run and must return the same thing for the same answers.

That is what makes the reconcile idempotent. A module is configured whenever its project is
reconciled, and `xanosdk init` is only the first of those moments: installing into a project
that already exists, re-answering later, and removing all run the same pass. The correct
state is a function of the project's dependencies and its stored answers, so it can be
rebuilt from scratch at any moment, however your module arrived.

`contributes` is **synchronous**. An `async contributes` returns a Promise, which is a
refusal: a pending Promise has no `gitattributes` and no `config`, which would read as the
empty contribution that switches your module off.

### The two slots

| Slot | What it is |
|---|---|
| `gitattributes` | Lines added to the project's `.gitattributes`, in your own marked block. One line per entry, no trailing newline. |
| `config` | Your module's block in the project's `package.json` `"xanosdk"` object, stored under your package name. |

Contributions are **additive against named slots the SDK owns**. You return lines and a
config object; the SDK composes them into the files it maintains. You never hand back a whole
file, never rewrite a script string, and never touch the disk yourself. That constraint is
what makes two installed modules safe together, and it moves the failure earlier: a malformed
contribution is refused where it was written rather than producing a broken file the user
meets later.

Your lines land in a block naming your package and stamped with your version:

```
# xanosdk:begin @acme/reviewable
# xanosdk 1.0.0 — generated; edits inside this block are overwritten
rendered/** linguist-generated
# xanosdk:end @acme/reviewable
```

**An empty contribution is meaningful.** Returning no `gitattributes` lines removes your
block rather than leaving an empty one, which is how a module whose answers turned it off
stops applying rules the user declined. Returning nothing at all is the SDK's signal that
your module reported itself switched off, and it is recorded as `{ "enabled": false }`.

### What you may not contribute

A `.gitattributes` rule is refused when it:

- **matches `*`.** That applies to every path in the repository, and a module able to set it
  from an add-on install could renormalize line endings repo-wide on the next checkout.
- **sets `text` or `eol`, including a bare `-text`.** `.gitattributes` is last-match-wins, so
  an appended `* -text` or `*.gen eol=crlf` silently defeats the `* text=auto eol=lf` rule the
  scaffold sets so a byte comparison cannot fail over a contributor's `core.autocrlf`.
- **spells a xanosdk block marker.** Blocks are located by counting markers, so one forged
  line leaves a file no run can balance, including another package's block.

Contribute display rules (`linguist-*`, `diff`) for the paths you own instead. Each check runs
**per physical line**, because the composer splits every entry on newlines before writing it:
`["docs/*.md linguist-documentation\n* binary"]` would otherwise pass and then land `* binary`
on every path in the repository.

A `config` that is not a plain object is refused too. The reconciler writes it into the
`"xanosdk"` block, and the reader refuses any entry that is not an object, so one run would
author a manifest that every later reconcile then refuses to read. It must also survive
`JSON.stringify`, so no BigInt and no cycles.

## `answersFromConfig`

```ts
answersFromConfig: (config) => ({
  xanoscript: config.enabled === true,
  dir: typeof config.dir === "string" ? config.dir : "xanoscript",
}),
```

The inverse of `contributes`: read your stored config block back into the answers that
produced it.

`contributes` is a **module-private transform**. Only you know that `{ enabled: true, dir:
"xanoscript" }` came from `{ xanoscript: true, dir: "xanoscript" }`. The SDK will not guess,
and matching question ids to same-named config keys would be a convention this contract does
not state.

**Declare it whenever your config keys are not your question ids.** Without it, a re-ask
offers your shipped defaults and, non-interactively, answers with them, silently resetting a
directory the user chose. A module that omits it is left as it is rather than re-derived, the
run reports it as carried, and `reinstall` tells the user what happened before the prompts
start.

It is the one hook that can never take a command down. Keys matching no declared question are
ignored, and a throw is reported and degrades to your defaults.

## `onBundle`

```ts
onBundle: async (ctx) => {
  if (ctx.entry === undefined) return { message: "no entry, nothing rendered" };
  if (ctx.frozen) {
    const stale = compare(render(ctx.bundle.payload), readFromDisk(ctx.cwd));
    return stale.length === 0
      ? { message: "rendered tree is current" }
      : { message: "rendered tree is stale", warnings: stale, failed: true };
  }
  write(ctx.cwd, render(ctx.bundle.payload));
  return { message: "rendered tree written" };
},
```

Fires on `export` and every `deploy` (`--to` included), **after the bundle compiles and before the network call**.
That placement is deliberate: a tree describes the **source**, so writing it before the deploy
means a failed deploy still leaves a correct tree, and a tree never claims something shipped
that did not.

Plugins run in sequence rather than concurrently. They write to the user's tree and to the
terminal, and interleaved output from two modules writing adjacent directories is harder to
read than it is slow.

| `BundleContext` | What it carries |
|---|---|
| `bundle.payload` | The compiled payload, keyed by payload key (`table`, `query`, `app`, ...). |
| `entry` | The entry file the bundle came from. **Absent** on the `--bundle <path>` branch. |
| `cwd` | The project root every relative path resolves against. |
| `command` | `"export"` or `"deploy"`. |
| `frozen` | The run is `--frozen-lock` (or `export --check` / `deploy --to … --dry-run`, which imply it): a verification, not a write. |
| `sdkVersion` | The running `@xano/sdk` version, for your own peer-range check. |
| `config` | Your block from the project's `package.json` `"xanosdk"` object. |

**`entry` is optional rather than a made-up path** so a plugin may decline the
`--bundle <path>` branch, where the input is already-serialized text with no entry and no
registry behind it. A tree rendered from a bundle the project did not compile describes
something other than the source beside it.

**Under `frozen` a plugin must compare and report, never write.** It is also the mode in which
a plugin failing to load is fatal rather than a warning.

### Env values are blanked before you see them

`payload.env` entries keep their `name` and carry `value: ""`. A hook's output is typically
committed, and the real values come from a gitignored file, so handing them to a renderer
would be handing them to git. Your obvious implementation, rendering the payload faithfully,
would put production credentials into a repository and nothing in the contract would have
warned you. The declarations survive because they are structure; the secrets do not.

## `onPreflight`

```ts
onPreflight: async (ctx) => {
  if (ctx.engineRendering.kind === "error") {
    return { message: `could not read the engine's rendering: ${ctx.engineRendering.why}` };
  }
  ...
},
```

Fires on `xanosdk preflight`, contributing a comparison to the report.

| `PreflightContext` | What it carries |
|---|---|
| `engineRendering` | The engine's own rendering of what it has, **or why it could not be had**. |
| `exportedPayload` | The payload as the engine exported it after import. |
| `remappedPayload` | The compiled payload with its guids translated to the engine's re-minted ones. |
| `verbose` | The command was run with `--verbose`: report at length. |
| `cwd`, `sdkVersion`, `config` | As on `BundleContext`. |

The SDK owns the fetch and nothing else. Every derivation past that point is yours: you have
both payloads, so you render both local sides and compute your own exclusions, and no
rendering knowledge stays behind in the SDK.

`engineRendering` is tagged because the difference is load-bearing. **A missing text route
must report as unavailable, never as drift.** Treating a failed fetch as an empty rendering
would diff every object in the workspace against nothing and report a catastrophic mismatch
that is really a network error.

Both payloads are blanked identically, so a comparison between them is unaffected. A
comparison against `engineRendering` should exclude env values, which the engine has no
reason to blank.

A project whose plugins declare no `onPreflight` never pays for the engine's rendering at all,
so declaring the hook is what turns that fetch on.

## `HookResult`: `failed` is not a throw

```ts
interface HookResult {
  message?: string;     // one line for the command's normal output
  warnings?: string[];  // per-item notes shown under the message
  failed?: boolean;     // the check this hook performed did not pass
}
```

This distinction is the whole reason the field exists.

- **A thrown error is a broken plugin.** It could not do its job. On `export` and `deploy` the
  command warns and carries on, and under `--frozen-lock` it is fatal: a check that did not
  run must not read as a check that passed. A throw from `onPreflight` is never fatal, because
  `preflight` is itself a check and its own report is worth printing, but it does fail the
  gate for the same reason.
- **`failed: true` is a working plugin reporting that what it checked does not pass.** A
  committed tree that no longer matches the source, say. It is never swallowed and reaches the
  command's exit code on every run.

Collapsing the two would break both directions: a bug in a plugin would fail a deploy that is
fine, and a real staleness finding would be swallowed as a plugin bug. `preflight` maps
`failed` onto the same non-zero exit code it uses for its own findings, which is what lets CI
keep gating on it.

Set `failed` only when your plugin ran correctly and the answer is no.

## Contract skew is refused, never absorbed

Because every hook is optional, a module written against a shape of this contract the running
SDK does not have would load, register, and contribute **nothing**, silently, since "a module
with no contributions" is a legitimate outcome. So the SDK detects each known skew structurally
and refuses it by name, with the upgrade to make.

| Shape | Why it is refused | The fix |
|---|---|---|
| A `files` hook and no `contributes` | `files` was renamed once the hook stopped running only at scaffold time. | Rename it. `contributes(answers)` returns a `ProjectContributions`. |
| A `ciSteps` entry in what `contributes` returns | The slot is gone. Your check already rides on `xanosdk export ./xano/index.ts --frozen-lock` through `onBundle` with `frozen` set. | Drop it. No workflow step of your own is needed. |
| `contributes` returning a string, a number, an array or a Promise | Indistinguishable from "contributed nothing", which is recorded as switched off. | Return an object, or nothing at all. `contributes` is synchronous. |
| A default export whose `kind` is not `"toolchain"` | The manifest and the module disagree, so one of the two is stale. | Make them agree. |
| An SDK outside your declared `peerDependencies["@xano/sdk"]` range | Your hooks were written against shapes this SDK does not have, so it would apply nothing. | Upgrade the SDK, or install a build of your module made for it. |

The peer-range row is the one that catches the skew **in the other direction** — your module
newer than the SDK running it. Nothing about the plugin object can reveal that: the check that
would recognize a hook name you have not yet invented would have to ship in the SDK that
predates it. Your declared range is the only fact both sides hold, which is why it is read
rather than trusted to npm's install-time warning — that warning is routinely bypassed by
`--legacy-peer-deps`, by pnpm and yarn peer handling, and by an SDK downgraded after the
install. It is also the only version check that reaches a **reconcile**: `sdkVersion` is handed
to `onBundle` and `onPreflight` only, so a guard of your own inside a hook first fires on the
next `export` or `deploy`, well after the `marketplace install` that quietly wrote nothing.

Someone pinned to an older SDK is never locked out by this: `"enabled": false` is read before
the check runs, and `marketplace remove` uninstalls before it reconciles.

The installers ask the same question, so a module of yours that cannot run on the SDK in front
of it never gets left on disk waiting to be refused: `marketplace install` undoes an install it
just made, `reinstall` refuses without touching the module you already had, and
`init --marketplace` reports it and takes it back off. See
[Peer ranges](marketplace.md#peer-ranges).

The last row in the table above is the pattern: silently dropping a contributed CI step would
be a guard that stops running, and a wrong return type would switch a working module off and
keep it off while `marketplace remove` refused it for being deliberately disabled. Neither
failure would ever reach you.

## What a throwing hook costs

A module that cannot describe its contributions loses its contributions, not the command.
`contributes` is third-party code running after an install has already written to the target
directory; letting it take the run down would leave a half-populated project every re-run then
refuses. Your module is reported and every byte it owns is left exactly as it was, including
its config, whose presence is what tells the next run the questionnaire already completed.

A **refusal** (the rows in the table above) does propagate. Those are deterministic, so
re-running cannot fix them, and carrying on would ship a project that does not do what your
module says it does.

## Testing your module

The SDK's own suite drives a generated fixture plugin through the real load path rather than
mocking it, which is the shape worth copying: write your plugin into a temp project's
`node_modules` with a real `package.json`, and run the CLI against it.

Things worth proving about your own module:

- `contributes` returns the same thing for the same answers, called twice.
- `answersFromConfig(contributes(a).config)` round-trips back to `a` for every answer set.
- Your `onBundle` writes nothing when `ctx.frozen` is true.
- Your `onBundle` handles `ctx.entry === undefined`.
- Your hooks never read `payload.env` values, because they are blanked.

## Publishing

Publish to npm like any package. To appear in `xanosdk marketplace list` and `search`, the
module also needs a catalogue entry, which carries its title, tagline, description, tags, the
objects it installs, what the user supplies, the registration snippet, and the agent prompt
`details --prompt` emits. Write that prompt for a machine: it is what `init --marketplace`
and `marketplace install` point at whenever they cannot wire your module themselves.

Nothing about the marketplace is required to use a module. Any package declaring a `"xanosdk"`
field works from a `file:` path, a tarball, a git spec or a private registry, and the CLI
passes the specifier to npm exactly as typed.
