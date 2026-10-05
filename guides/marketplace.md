# The marketplace

Finding published add-ons, adding one to the project you are standing in, and what the CLI does that `npm install` does not.

An **add-on** is an ordinary npm package that declares itself to Xano SDK in its own
`package.json`. The marketplace is the public catalogue of them, plus the six `xanosdk
marketplace` verbs that find one and change what your project has installed.

```bash
xanosdk marketplace list                          # every published add-on, newest first
xanosdk marketplace search auth                   # narrow by keyword
xanosdk marketplace details @xano-sdk/auth          # what it installs, and how to register it
xanosdk marketplace details @xano-sdk/auth --prompt # ...as instructions for a coding agent

xanosdk marketplace install @xano-sdk/auth          # add it to the project you are in
xanosdk marketplace reinstall <toolchain-package>  # re-ask a toolchain module its questions
xanosdk marketplace remove <toolchain-package>     # uninstall it and drop what it contributed
```

The split is deliberate. The three read verbs hit a public catalogue: no token, no
credential file, and they work signed out, so discovery is a first-class verb rather than
something you do in a browser before you can use the CLI. The three writing verbs touch no
network of their own and shell out to npm, so changing what a project has installed keeps
working when the catalogue does not.

## The two kinds of module

Every add-on is one of two kinds, and which one it is decides everything about how you use
it. The kind comes from the module's own `package.json`:

```json
{ "xanosdk": { "kind": "toolchain" } }
```

A **workspace module** (`@xano-sdk/auth`, `@xano-sdk/vector`, `@xano-sdk/chatbot`) adds tables and
endpoints to the bundle you deploy. You install it, import it in `xano/index.ts`, and call
its register function. What it contributes ships to your instance. This is the default: a
module that declares no `kind` is a workspace module, which is why every add-on published
before the toolchain kind existed still works.

A **toolchain module** (`@xano-sdk/xanoscript`) extends the **CLI** instead. It adds nothing to
the workspace, and registering it in `xano/index.ts` would be meaningless because there is
nothing to register. What it does is participate in commands: it declares questions the
CLI asks you, contributes lines to files your project owns, and runs hooks when a bundle
is compiled or a workspace is checked.

`install` tells you which one arrived, because the next step differs:

```
✓ Installed @xano-sdk/auth.
  Import it in your backend (`xano/index.ts`) and register it onto your workspace.
```

```
✓ Installed @xano-sdk/xanoscript.
  Extends the CLI (nothing to register). Configured in this project's package.json "xanosdk" block.
```

A module whose `kind` is a string the CLI does not recognize is reported and read as an
ordinary package rather than defaulted to one kind or the other. That is a typo in the
module's own manifest, and guessing which loader it meant would run code the manifest did
not describe.

## Finding an add-on

`list` prints the whole catalogue, newest first. `search` matches a keyword across title,
slug, package name, tagline and description, and extra terms are joined into one phrase
rather than dropped, so `search ai agent` searches for "ai agent".

Both print a formatted summary to a terminal and stable JSON to a pipe. There is no flag to
discover: an agent gets the machine shape by doing what an agent already does.

```bash
xanosdk marketplace search auth | jq -r '.modules[].npm_package'
```

Each JSON row is the whole record `details` returns — `description`, `includes`,
`requirements`, `register_snippet`, `agent_prompt` — so one `list` fills a catalogue without a
`details` call per module. A row also carries `kind` (`workspace` or `toolchain`) when the
catalogue records it; a row without it says nothing about the kind until the package is
installed.

The headline field in a listing is `npm_package`, because that is the string you retype into
`install`. The `slug` names the module's web page and is deliberately absent from the
terminal rendering: printing it beside an install line invites someone to install it.

`details` is the one to reach for when wiring an add-on. It prints the long description, the
objects the module puts on your workspace, what you have to supply yourself, the
`xano/index.ts` registration to copy, and the install line:

The rendering has a fixed shape, filled from the module's own catalogue record:

```
  <Title>
  <tagline>

  <the long description>

  Package  @scope/name
  Tags     a · b
  Docs     <docs_url>
  Repo     <repo_url>

  Installs
    table     <name>  — <item summary>
    endpoint  <name>  — <item summary>

  You supply
    • <what the module cannot provide for you>

  Register it
    <the xano/index.ts snippet, verbatim>

  xanosdk marketplace install @scope/name
  xanosdk marketplace details @scope/name --prompt  to hand the wiring to a coding agent
```

The `Installs` rows carry one of `table`, `endpoint`, `function`, `task`, `trigger`, `agent`,
`mcp`, `middleware`. A toolchain module lists none of them, because it puts nothing on the
workspace.

`--prompt` emits the publisher's own wiring instructions, raw and alone, written to be piped
straight into a coding agent. It belongs to `details` and is refused on every other verb: a
flag that parses cleanly and then does nothing is worse than one that fails.

`details` takes an npm package name or a slug. A miss prints the catalogue's own sentence
plus a pointer at `search`, because a miss is usually a half-remembered name.

A module that has been **removed** from the marketplace (`listed: false`) keeps its name
reserved: `details` still answers it, with a warning before every output mode, `--prompt`
included, on stderr so a piped prompt is unaffected. It is dropped from `list` and `search`
entirely, and `install` refuses it.

### Pointing the reads somewhere else

`XANOSDK_MARKETPLACE_URL` repoints all three read verbs. The catalogue host is otherwise
hardcoded in a published package, so a move would break every installed copy of the CLI at
once and only a release would fix it. A base with a path works too, so an ephemeral or a
tenant (`https://<instance>/tenant/<name>`) can stand in for it. See
[Environment & identity](environment.md).

## Installing

```bash
xanosdk marketplace install @xano-sdk/auth
```

The argument is resolved through the marketplace the way `details` resolves it, before npm
runs: a module's npm name or its slug (`xanosdk marketplace install auth` installs
`@xano-sdk/auth`), keeping any version or tag (`auth@next`). The install is then
`npm install` of that module's package. A name the marketplace does not list is refused
before npm runs, whatever its scope, with the not-found **exit 8** `details` uses
(`xanosdk marketplace search <name>` finds the real one) — `install` adds marketplace modules,
not arbitrary npm packages. When the catalogue cannot be
reached, an `@xano-sdk/` name still installs as typed and any other name is refused. `file:`
paths, tarball URLs and git specs are installed as given, without a lookup.

What the command adds over typing `npm install` yourself is three things npm will not do:

1. **Add-ons are on the CLI's map.** `xanosdk --help` says they exist.
2. **It refuses before npm runs when you are not in a project.** This is the oldest reason
   the command exists: run `npm install` from a parent directory and npm cheerfully creates
   or mutates the wrong `package.json` and tells you it succeeded.
3. **It reconciles afterwards.** A toolchain module that arrived is asked its questions, and
   the project records the answers.

The reconcile reads **every** dependency rather than the name you just typed. So a module
that arrived some other way is configured by this run too: a plain `npm install`, a merged
pull request, a `git pull` that changed `package.json`. It also means nothing has to recover
a package name out of a `file:` or tarball specifier in order to configure it.

A **toolchain module** gets two more steps, and `reinstall` runs both as well. Its peers other
than `@xano/sdk` (`zod`, say) are added as direct dependencies through the project's package
manager: yarn never installs peers, and pnpm does not link them where `routes.gen.ts` can import
them. Then, when the project keeps a `routes.gen.ts` beside its entry, the file is regenerated,
so the module's section lands with the module rather than at the next `xano:routes`. Under
`--json`, `peers` lists the specs that were added (`["zod@^4.0.0"]`, or `[]`), and `routes` says
what happened to the file:

| `routes` | Meaning |
|---|---|
| `written` | Regenerated. |
| `unchanged` | Already up to date. |
| `absent` | The project has no `routes.gen.ts` to refresh. |
| `skipped` | It could not be regenerated here. The warning says why; run `npm run xano:routes`. |

`remove` reports `routes` the same way, for the file it regenerates without the removed module.

`init` takes the same names and resolves them the same way — `--marketplace auth` is
`@xano-sdk/auth`, and an unlisted name exits 8 before anything is written — so a project can be
scaffolded with its add-ons already installed and registered:

```bash
xanosdk init my-app --marketplace @xano-sdk/auth,@xano-sdk/vector
```

`reinstall` and `remove` take those names too: `xanosdk marketplace remove auth` removes the
`@xano-sdk/auth` that `install auth` added. A name the project already depends on is taken as
typed, with no catalogue lookup, so both keep working offline. A name that is neither in the
project nor in the catalogue exits 8, as `install` does. `remove` is idempotent: removing a
marketplace module the project does not have succeeds (exit 0, `alreadyGone: true` under
`--json`), so a retried script does not fail.

See [The scaffolded project](scaffold.md) for what that writes and when a module is left
unregistered.

### Peer ranges

Every module published today peers on `@xano/sdk` with a range that names no prerelease,
and npm excludes prereleases from those. An install that npm refuses over a peer range is
retried once with `--legacy-peer-deps`, and the retry is reported out loud even when it
succeeds: that is a tree npm deliberately declined, in a project you have been running.

That retry is why the SDK asks the question again itself, after npm. It reads the module's
declared range against the running version with a comparison that knows the difference — a
prerelease CLI and a range shape it cannot parse are both "no opinion", never a mismatch — so
only a version you are **definitively** outside of is refused.

What happens then depends on whether the module predates the command:

| Situation | What you get |
|---|---|
| `install` added it this run | Refused and **uninstalled again**, so the project is exactly as it was. Upgrade the SDK and re-run. |
| `install` re-run over a module already in `dependencies`, or `reinstall` | Refused and **left alone**, settings included, because deleting a module you already had over a version mismatch is not a repair. Upgrade the SDK, or `marketplace remove` it. |
| `init --marketplace` | Reported as a module that was not added and taken back off disk. The scaffold itself completes and works. |

A *different* installed module that is out of range does not stop the verb. `install`, `reinstall`
and `remove` skip it with a warning naming its range and the fix, and leave its settings and its
`routes.gen.ts` block exactly as they were. `export`, `deploy` and `preflight` still refuse it.

The point of undoing the install is that the alternative is worse: a module whose hooks were
built against a contract this SDK does not have registers and applies **nothing**, so
`Installed` would be followed by a project where every command that loads modules refuses it.

## Configuration lives in your package.json

A toolchain module's per-project settings live in the consuming project's `package.json`,
under the `"xanosdk"` key, namespaced by package name:

```json
{
  "xanosdk": {
    "@xano-sdk/xanoscript": { "enabled": true, "dir": "xanoscript" }
  }
}
```

That block is written from your answers to the module's questions and read back on every
later run, which is what makes a choice made once survive every run after it. It is also the
only memory a module has.

**Absent config means enabled.** A package in `dependencies` with no block is enabled with
no settings: the next `deploy` fires its hooks with an empty config and it runs on its own
fallbacks with nothing you chose. `export` and `deploy` report that state on every run,
because the likeliest way a module reaches it is a plain `npm install` or a merged PR,
neither of which runs a xanosdk verb:

```
! A toolchain module is installed but never configured, so it runs on its own
  defaults with nothing this project chose.
  @xano-sdk/xanoscript — configure it with `xanosdk marketplace install @xano-sdk/xanoscript`
```

Running `install` on a package that is already installed reads as a no-op until you know it
reconciles. It is the fix.

**`"enabled": false` switches a module off.** It is then never imported at all, which is why
reading config first matters: a disabled module costs nothing on every `compile`, `export`,
`deploy` and `preflight` that does not use it.

A module also contributes lines to your `.gitattributes`, in its own marked block:

```
# xanosdk:begin @xano-sdk/xanoscript
# xanosdk 1.2.0 — generated; edits inside this block are overwritten
xanoscript/** linguist-generated
# xanosdk:end @xano-sdk/xanoscript
```

Each module's lines land in a block naming it and stamped with the version that wrote them,
so re-answering one module's questions rewrites exactly that span and nothing around it.
Two installed modules cannot clobber each other's lines, because neither module writes the
file.

### Answering questions without a terminal

Each question a module declares derives a long flag that answers it, so a non-interactive run
does not have to accept defaults:

```bash
xanosdk marketplace install @xano-sdk/xanoscript --xanoscript --xanoscript-dir=generated
```

A `string` or `choice` question takes `--flag=value`, not `--flag value`. The CLI cannot know
a contributed flag takes a value, because the module is not loaded when the arguments are
parsed, so it never consumes the following token. A `boolean` question takes the bare
`--flag`, or `--no-flag` to decline one whose default is true.

A flag no question claims is refused by name, naming the verb you actually typed.

`--json` makes the run non-interactive, and so does a stdin or a stderr that is not a TTY:
prompts are drawn on stderr, so a run whose stderr is redirected has nowhere to ask even
when stdin is a terminal. That is said once, up front, rather than question by question:

```
  Not a terminal, so nothing was prompted — each setting is this project's stored
  value or the module's declared default.
```

The machine output names where every answer came from (`flag`, `prompt`, `config`,
`default`) and which flag answers each question, so an agent reading it can change one
setting on the next run.

## Re-asking: reinstall

```bash
xanosdk marketplace reinstall @xano-sdk/xanoscript
```

`reinstall` re-runs npm, then re-asks one module its questions and reconciles, offering your
project's **current** settings as the defaults rather than the ones the module shipped.
Stored answers outrank declared defaults, so a repeated run never quietly resets a directory
you chose.

It says four things before any of that runs, because each is a different mistake with a
different way out:

| State | What happens |
|---|---|
| Not a dependency | Refused before npm, so a typo never installs. Use `install` (a name no catalogue lists exits 8). |
| A dependency but not installed | Refused: the tree is broken, not the settings. Run `npm install`. |
| Not a toolchain module | Refused: there are no questions to re-ask. |
| `"enabled": false` | Announced, then switched back on. |

The last one would otherwise be a silent no-op, because a disabled module is never imported
and a reconcile would find nothing to ask. Re-asking a module its questions is asking
whether you want it, so the only coherent reading is "turn it back on and ask". Answer no to
its own enabling question and it goes straight back off.

npm runs before every check but the first, so `reinstall` also repairs a half-installed
module rather than refusing to work on one.

If a module does not map its stored settings back to answers, the re-ask starts from the
defaults it ships, and the command says so rather than letting you discover it by accepting
every prompt and finding your chosen directory reverted.

## Removing

```bash
xanosdk marketplace remove @xano-sdk/xanoscript
```

`remove` uninstalls the package and then drops the settings and the contributed lines
together. The order is the whole design: the reconciler derives a removal from
`dependencies`, so the block can only go once the dependency has.

**A plain `npm uninstall` is not the same thing, and the leftover is not cosmetic.** The
package goes; the `"xanosdk"` block and the contributed lines do not. Nothing reports that
leftover, either: the loader only visits packages the project still declares, so once npm has
taken the name out of `dependencies`, the module is invisible and its check is simply not
run. A `--frozen-lock` run in that state exits 0 having verified less than it did yesterday,
and says nothing. Only the next `install`, `reinstall` or `remove` drops the stale block.

The state that does fail **every** `--frozen-lock` run is the other one: a module still
declared in `dependencies` but missing from `node_modules`, which is what `npm uninstall
--no-save`, a deleted `node_modules/<pkg>` or a drifted lockfile leaves behind. There the
project still says the module is expected, so its absence is reported rather than assumed
away:

```
A toolchain module could not be loaded, so whatever it checks was not checked — and
this run was asked to verify, not to write:
  @xano-sdk/xanoscript — it is configured in this project's package.json but is not installed
```

That half-removed project is a first-class input to this verb, not a refusal. A package that
is no longer a dependency but is still configured skips npm (there is nothing to uninstall)
and the reconcile does the repair.

These states are refused before npm touches anything:

| State | Why |
|---|---|
| A workspace module your backend still imports | Refused, naming the files that import it: uninstalling under that import breaks the next export. Drop the import and registration, then re-run. A workspace module nothing imports is uninstalled, the inverse of its install. |
| An ordinary npm package | Nothing here contributed settings. `npm uninstall` is the honest instruction. |
| A dependency that is not installed, and not configured either | Nothing on disk to read and no stored settings, so there is no way to tell whether it ever contributed anything. npm owns the whole job. |
| Neither a dependency nor configured | A marketplace module: already removed, exit 0. A name the catalogue does not list: exit 8. |
| `"enabled": false` | Switched off is not removed. It is still installed and still in `dependencies`. |

A failed uninstall costs nothing. The dependency is still there, so a reconcile would derive
no removal, and the project is byte-for-byte what it was. Fix what npm reported and re-run.

`remove` does not offer to delete a directory the module generated. That is the module's
data, the contract names no such directory, and a removal that deletes rendered source is not
one you can undo.

## What a reconcile guarantees

Every one of these verbs ends in the same idempotent pass. The correct on-disk state is a
pure function of your `dependencies` plus your stored `"xanosdk"` block, so it can be rebuilt
from scratch at any moment, however a module arrived.

- **Nothing is written until every target has been checked.** An unparseable `package.json`,
  a `"xanosdk"` key that is not an object, an unbalanced managed block, a contribution the
  contract refuses: each aborts before any write, so a refusal never leaves one of two files
  patched.
- **An unchanged file is not rewritten.** Mtimes included. A tool that rewrites two
  version-controlled files on every install fills a repository with no-op diffs.
- **A module whose hook throws loses its contributions, not your command.** Every byte it
  owns is left exactly as it was, and it is reported.
- **A module that cannot be recomputed faithfully is carried forward untouched** rather than
  re-derived from shipped defaults. The run reports it as carried.

The reconciler re-reads both files at the moment of writing and replays its decisions over
whatever is there now. The questionnaire blocks on a human, so the window between reading and
writing is unbounded: long enough for another verb, an `npm install` or a hand edit to land
in it. Every decision is keyed by package, so the replay touches only the packages that run
settled.

## Under `--frozen-lock`

A frozen run is a guard, and a guard that silently stops running is worse than one that fails
loudly. So under `--frozen-lock` a toolchain module that fails to load is **fatal** rather
than a warning, and so is a hook that throws.

On a normal run both are reported and skipped, matching every other optional side effect in
the CLI. The asymmetry exists because if a plugin fails to resolve in CI (a partial install, a
stale plugin path after a version bump) then its hook never fires, nothing checks what it
checks, and `xanosdk export ./xano/index.ts --frozen-lock` exits 0 against a tree that is wrong. A red guard
gets fixed; a green one gets trusted.

A module's own check therefore rides on the same `--frozen-lock` run as `xano.lock`, so a
stale generated tree fails CI beside a stale lock. See [The scaffolded project](scaffold.md)
for the workflow `init` writes.

## Writing your own

Both kinds of module are documented in [The module contract](module-contract.md): the
manifest fields, the `@xano/sdk/plugin` types, every hook, and what the SDK refuses.
