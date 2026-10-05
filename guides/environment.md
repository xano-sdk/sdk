# Environment & identity

The environment variables Xano SDK reads on your machine, the workspace env vars your deployed stack reads at runtime, and how `xano.lock` pins object identity across deploys. Every build writes the lock; commit it.

## Environment variables

Every variable the CLI and SDK read. All are optional — the defaults in the right column
are what you get when the variable is unset.

**Authentication** (see [Signing in & deploying](deploying.md) for the full precedence ladder)

| Variable | What it does |
|---|---|
| `XANO_INSTANCE_URL` | Instance origin for the meta credential (CI, agents), e.g. `https://your-instance.xano.io`. Set with `XANO_WORKSPACE_ID` + `XANO_META_TOKEN` — all three together, or none. |
| `XANO_WORKSPACE_ID` | Numeric workspace the meta credential acts on. |
| `XANO_META_TOKEN` | Meta API bearer token. With the two above it forms a complete credential that outranks every other source, reads no file, and never rotates. |
| `XANO_REFRESH_TOKEN` | OAuth refresh token for non-interactive runs (CI, agents). Paired with `XANO_CLIENT_ID`; the target instance comes from the token's own `aud` claim. Rotates on use — prefer the meta credential above. |
| `XANO_CLIENT_ID` | OAuth client id that goes with `XANO_REFRESH_TOKEN`. Both are copied once out of the profile in `auth.json` after a local `xanosdk login`. |
| `XANO_CONFIG` | Explicit path to the credential file. Wins over both default locations — the same thing `--config <path>` does. Refused beside `--local-auth`, which names a different file. |
| `XANO_PROFILE` | Which stored credential profile to act as, when no `--profile` names one. Outranked by the flag, by the project's `xano.profile.json` pin, and by an environment credential (which displaces it with a note on stderr). |
| `XANO_GLOBAL_CONFIG` | Moves the **shared** credential cache off `~/.xanosdk/auth.json`. Only changes where the global cache lives; the project-local `./.xano/auth.json` and the `XANO_CONFIG`/`--config` override are unaffected. |
| `XANO_CLIENT_FILE` | Moves the OAuth **client-registration** cache off `~/.xano/xanosdk-clients.json`. That file holds the `client_id` minted per auth host + redirect URI, not a credential. |
| `XANO_ORIGIN` | OAuth host to sign in against, instead of the default — the same thing `--origin` does. An origin only (`https://host`): a path, query or fragment is refused. |
| `XANO_NO_BROWSER` | Set to anything non-empty and `xanosdk login` will **not** launch a browser; it prints the authorize URL to stderr for you to open yourself. The loopback server still runs and still waits for the redirect, so the flow completes only if the browser you open it in can reach this machine's `127.0.0.1`. For a machine that has no browser to launch. When the browser is on a **different** machine, that redirect cannot arrive — use `xanosdk login --paste` instead. |

**`xanosdk preflight`** — its own target, deliberately separate from the deploy login

| Variable | What it does |
|---|---|
| `XANO_VALIDATE_INSTANCE` | Base URL of the instance to validate against (`https://your-instance.xano.io`, or `http://localhost:8080` for local Docker). Required; `--instance <url>` overrides it. |
| `XANO_VALIDATE_TOKEN` | Meta API bearer token for that instance. Required. |
| `XANO_VALIDATE_WORKSPACE_ID` | Parent workspace the run's throwaway environment is created under. Defaults to `1`. |

**Output & diagnostics**

| Variable | What it does |
|---|---|
| `XANOSDK_DEBUG` | Appends the untouched underlying error to a failure message, instead of only the mapped explanation. |
| `NO_COLOR` | Suppresses ANSI color on the stderr progress output ([no-color.org](https://no-color.org)). Color is off by default whenever stderr is not a TTY. |
| `FORCE_COLOR` | Forces color on even when stderr is not a TTY; `FORCE_COLOR=0` forces it off and beats `NO_COLOR`'s absence either way. |

**Update notifier**

| Variable | What it does |
|---|---|
| `XANOSDK_NO_UPDATE_CHECK` | Turns the "a newer version is out" notice off (it reads the registry at most once an hour). |
| `NO_UPDATE_NOTIFIER` | The de-facto convention, honored identically. `CI` being set also silences the notice. |
| `XANOSDK_INSTALL_MODE` | `global` or `local` — pins whether the notice suggests `npm i -g` or `xanosdk upgrade` (a project-local install), instead of detecting it. |
| `XANOSDK_UPDATE_REGISTRY` | Registry URL the check reads, instead of the npm endpoint for `@xano/sdk`. |
| `XANOSDK_UPDATE_CACHE` | Moves the check's cache file off `~/.xanosdk/update-check.json`. |

**Xano Engine** (see [Deploying locally](deploying.md#deploying-locally))

| Variable | What it does |
|---|---|
| `XANOSDK_ENGINE_OVERRIDE` | An engine to run instead of the project's pinned one, for every `deploy --local` in this shell: a version (`v0.1.8`), an `https://` URL to an engine archive (plain `http://` only from this machine), or an archive path. A value on `--local=` beats it; it never reads or moves the pin. |
| `XANOSDK_ENGINE_TOKEN` | Bearer credential sent with an override URL's download — only to that URL's own origin, never to another host a redirect leads to. |
| `XANOSDK_ENGINE_HOME` | Moves everything the Xano Engine writes off `~/.xanosdk/local-engine`: the engine cache, the running-engine records, and the engine's own logs and runtime data — see [where the engine keeps its data](deploying.md#where-the-engine-keeps-its-data). |
| `XANOSDK_ENGINE_RELEASES_URL` | A different engine release service for version lookups. Its engines are fetched fresh each deploy, the pin is not read or written, and `xanosdk local update` refuses while it is set. |

**Escape hatches**

| Variable | What it does |
|---|---|
| `XANOSDK_MARKETPLACE_URL` | Base URL the `xanosdk marketplace` reads hit, instead of the published catalogue. Repoints the three read verbs without waiting for a release. A path is kept, so `https://<instance>/tenant/<name>` works. |
| `XANOSDK_PROVE_DIFF` | A file path. Codegen appends one JSON line per statement that fell back to `raw()` — the arm that declined and the key paths where the re-encode disagreed. The decline *reason* is on the report either way; this adds the machine-readable detail. |

> `process.env` read inside a **workspace definition** is a different thing entirely: it
> resolves at export time and bakes the literal into the bundle. For a value the deployed
> stack reads at runtime, use `workspaceConfig({ env })` + `env("NAME")`, covered in the next
> section.

## Workspace environment variables

Everything above is read by the **CLI, on your machine**. A *workspace* env var is a different
set entirely: it lives in the backend, the deployed stack reads it at request time with
`env("NAME")`, and the CLI only ever carries it to the engine. Nothing in the table above
affects one.

Names are declared in source; values are not.

```ts
workspaceConfig({ name: "my-app", env: { STRIPE_KEY: "" } });
```

```bash
# xano/.env: gitignored, and the default a bundle-producing command reads with no flag.
STRIPE_KEY=sk_test_REPLACE_ME
```

A pull carries the **names** into the config and leaves the values in the backend, so a
checked-out project never holds a secret it did not fetch on purpose.

**The files**

| Path | What it is |
|---|---|
| `xano/.env` | Where the values live. Gitignored by the scaffold, and preserved across a `xanosdk pull` rather than rewritten. Read with no flag by the commands that compile a bundle: `deploy`, `export`, `preflight`, and `release create` when its optional `--bundle` comparison compiles one. |
| `xano/.env.example` | Generated beside it, listing the declared names as commented lines. Committed. Copy it to `xano/.env` on a fresh clone and fill in the values. The lines stay commented on purpose, so an unedited copy meets the refusal below rather than sending empty strings to your backend. |

`xano/` is the scaffold's backend directory. The file is read from the directory of the
entry you compile: an entry anywhere under a top-level `<dir>/` (`src/index.ts`, `backend/index.ts`) reads
`<dir>/.env`, and an entry at the project root reads `xano/.env`. A tree `generate` wrote
reads the `.env` beside its own `index.ts`. The info line each compile prints names the file
it looked for.

**Filling it**

```bash
xanosdk env pull                        # fetch the values from the source this project last deployed to
xanosdk env pull --from tenant:prod     # name the source explicitly
xanosdk env pull --from workspace --yes # and skip the confirmation
```

The source is a backend that is running: `workspace`, `ephemeral[:<name>]`,
`local[:<name>]`, or `tenant:<name>` — the [backend grammar](cli.md#naming-a-backend)
every command shares. Left off, it is the ephemeral or Xano Engine this project last
deployed to. A bundle path is refused, because its env is whatever it was built with,
which is the stale set this command exists to replace.

`env pull` overwrites an existing `xano/.env`, so it confirms first and names the source it is
about to read. A developer expecting dev secrets should not silently take production's. `--yes`
skips that confirmation, including the list of local values the pull would drop. Creating a
missing `xano/.env` replaces nothing, so it is not asked about; a file already holding exactly
the source's values is up to date, and nothing is asked or written.

It is the only command that writes `xano/.env`, but not the only place a secret lands on
disk: signing in stores your tokens in the credential file, and a compiled bundle carries the
resolved env values in cleartext (see the `--bundle` note below).

**Changing one value on a running backend**

```bash
printf %s "$STRIPE_KEY" | xanosdk env set STRIPE_KEY --to workspace --yes  # value on stdin
xanosdk env set FEATURE_FLAG on --to local                          # or as the second argument
xanosdk env unset STRIPE_KEY --to tenant:prod-eu                            # remove it
```

`env set` creates the variable or replaces its value, and `env unset` removes it. Every other
variable on the backend stays as it is, and nothing is deployed. Use these to rotate a secret:
a deploy can't do that job. A merge deploy only adds names that aren't there yet, and
`--replace` rewrites the whole workspace.

The destination is `--to workspace`, `--to ephemeral[:<name>]`, `--to tenant:<name>`, or
`--to local[:<name>]` for a Xano Engine. With none of these, the command writes to
the ephemeral or Xano Engine this project last deployed to. It never falls back to your
workspace or a tenant, and a Xano Engine needs no Xano account. A write to
the workspace or a tenant asks for confirmation first, and `--yes` skips it; that flag is
required when there is no terminal, including when the value is piped in. Ephemerals and the
Xano Engine are throwaway, so the command doesn't ask.

The value is never printed. Pipe it on stdin to keep it out of shell history. One trailing
newline is dropped, so `echo` works too. An empty value is refused unless
`--allow-empty-env=NAME` names that variable, because an empty value usually means a shell
variable wasn't set. To remove a variable, use `env unset`. `unset` on a name the backend
doesn't have reports that nothing was there and exits zero.

Neither command touches `xano/.env`. The next deploy still sends what that file holds, so
update it too if the change should outlive the next deploy.

**Overriding it**, on any command that compiles a bundle:

| Flag | What it does |
|---|---|
| `--env-var KEY=VALUE` | One value, for this process only. Never written to `xano/.env`, never printed back. Repeatable. Highest precedence: it beats whichever file supplied values, the default `xano/.env` or an explicit `--backend-env-file`. On `export` the value is still compiled into the bundle that command writes. A secret on the command line also lands in shell history and the process table, so prefer `--backend-env-file` in CI. |
| `--backend-env-file <path>` | Read values from this dotenv-style file **instead of** `xano/.env`. It replaces the default rather than layering over it, so pointing at a CI secret mount cannot also ship a developer's local file. The flip side: a name that only `xano/.env` had is now unsupplied. |
| `--allow-empty-env=NAME[,NAME]` | Send these declared names empty on purpose, **clearing whatever the target holds for them**. Per-name only; there is deliberately no bare form. |
| `--allow-empty-doc-token=NAME[,NAME]` | The same, for a documentation token — but it **opens** something: the target's doc-site gate is cleared and those docs become publicly readable. Per-name only, no bare form. |

**A deploy replaces the workspace's env set.** So a declared name left empty in the config
that no file and no flag supplies would clear the live value, and `deploy` refuses instead,
naming the variables. That refusal fires on the ordinary path (a fresh clone has no
`xano/.env`), and it is a refusal rather than a warning because the cleared value is not
recoverable from anything the project holds. A name the config itself spells a real value for
is supplied by the config and is never refused. `export` and `preflight` report instead of
refusing: one writes a file, the other imports into a throwaway tenant. A `--keep-data` deploy
merges, and a merge only adds names the target does not hold, so an empty value clears nothing
and is not refused — unless `--keep-data` cannot keep that environment's data and the deploy
replaces it after all. A `deploy --to` without `--replace` merges the same add-only way, and it
still refuses: a name the target does not hold would be created there with no value, on a
backend someone keeps. A `--dry-run` sends nothing, so it reports the refusal the real deploy
would make as a warning and prints its plan. `xanosdk env pull` warns about each declared name
the backend holds no value for, since the file it writes has none for it either.

**The refusal only covers declared names.** A variable that exists in the backend but is not
in `workspaceConfig({ env })`, and is not among the values being sent, is dropped by the same
replacement with no refusal and no warning, because nothing declares it to check. Two ordinary
routes reach that state: someone adds a variable in the backend after your last pull, and
swapping `xano/.env` for an `--backend-env-file` that holds only the declared names. So declare every
name the stack reads, and carry the rest across when you swap files.

The refusal is part of the **compile**, so `xanosdk deploy --bundle <path>` does not get it. A
pre-built bundle carries whatever env it was built with and sends exactly that, so a
build-once-deploy-the-artifact pipeline resolves its values at build time: pass
`--backend-env-file`/`--env-var` to the `export` that produces the bundle. Two consequences worth
knowing before you build that pipeline:

- **The bundle is a secret-bearing file.** A compiled bundle carries the resolved values in
  cleartext. Keep it out of git and out of shared build artifacts, and delete it after the
  deploy. The scaffold gitignores `workspace.json`, but not an arbitrary `--out` path.
- **Nothing re-checks the env at that deploy.** `--env-var`, `--backend-env-file`, and
  `--allow-empty-env` are accepted on a `--bundle` deploy and do nothing, because there is no
  compile to resolve them into. Rebuild the bundle instead, and rebuild it whenever a declared
  name is added: the `export` that skipped a value only warns, and the deploy that ships it
  does not check again.

**Documentation tokens go in a different file.** `xano/.env` is backend-only. The token gating
a hosted doc site lives in `xano/.secrets.json`, also gitignored, also preserved across a pull.

The split is not arbitrary, and the rule tells you where a future secret lands. A backend
variable is addressed by **name** — `env("NAME")` is how a stack reads it, so the name *is* its
identity, and a dotenv file is the right shape. A documentation token is addressed by the
**object** that holds it: this workspace, that API group. It has no name of its own, so it is
stored under that object's identity instead, and `env(...)` cannot read it from anywhere.

That file is SDK-owned. `xanosdk pull` writes it and every build reads it back, so a pull
followed by a deploy restores the gate with no manual step — which is the whole reason it
exists. Nobody edits it by hand; `--no-secrets` on a pull finds the tokens and writes none, for
a machine where a secret on disk is not wanted.

A pull only answers for an object that already HAS a token. A gate you declare in source — a new
API group, or a doc site you decided to close — has none to fetch, and that is what
`xanosdk secrets fill` is for:

```bash
xanosdk secrets fill                   # every declared gate with no value gets one
xanosdk secrets fill ./xano/index.ts   # name the entry when you are not in the project root
```

It mints a cryptographically random token per gate, the same shape a platform-minted one has,
and only ever **adds**: a value already in the file is never replaced, because replacing one
invalidates every doc-site link already handed out and may be the value the live gate is using
right now. An entry no scope in your source claims is left alone for the same reason. When
every gate is already filled it writes nothing at all, so a re-run is a no-op rather than a
file change. A minted token gates nothing until a deploy sends it — the file having a value and
the doc site wanting that value are two different moments. Because it is gitignored, a teammate's clone
and CI both have none: those pass `--secrets-file <path>` (which *replaces* the default, the
way `--backend-env-file` does) or `--doc-token "<scope>=<value>"` for one scope. A scope is `workspace`
or an API group's **name**; the flags take one per occurrence and repeat, and refuse a name two
groups answer to rather than guessing which you meant. Prefer the file: a token on the command
line is visible in shell history, the process list, and any CI log that echoes the command.

A pull refuses to write the file when git says the path is not ignored, and reports the drop
rather than failing — the tree it wrote is fine, it just carries no tokens. When git cannot be
asked at all (no repository, no git on `PATH`) it writes: there is nothing there that could
commit the secret.

The refusal works the same way as the backend one, with one difference worth knowing: an
unsupplied gate emits **no `documentation` block at all** rather than an empty token. On the
**workspace** that leaves the target's gate as it is instead of clearing it, which is what stops
a two-step `export` then `deploy --bundle` pipeline from clearing a gate no refusal could fire
on.

On an **API group** an absent key is not a non-action — the engine writes its default, which
clears that group's gate. There is no safe bundle to write, so a group that publishes docs and
declares a gate with no token supplied **fails the export** on every command, not just
`deploy`. Only `--allow-empty-doc-token=<scope>` turns an unsupplied gate into a deliberately
cleared one.

One thing to clear out by hand if you used an earlier build: a `XANO_DOCS_TOKEN…` line left in
`xano/.env` from when tokens lived there is now an ordinary **backend** variable, because that file
is backend-only again. It will be sent as part of the workspace's env, where `env("NAME")` reads it
from every request. Delete the line — the value belongs in `xano/.secrets.json`, and `xanosdk pull`
puts it there.

An entry the file holds that no scope in your source claims is **reported and never deleted** —
usually a renamed API group in a project with no lock. The SDK cannot tell a rename from a group
you commented out, and it cannot re-fetch a secret it throws away.

Do not confuse any of this with `deploy --static-env`, which bakes **public** config into the
HTML a browser downloads. One is a workspace secret; the other is visible to everyone.

`typedEnv()`, the `stack.env-undeclared` warning, and what a release does with env across
environments are in [Authoring reference](authoring.md).

## Identity & the xano.lock file

Every top-level object carries a stable `guid` — Xano's identity anchor. On a sync import
the engine matches an incoming object to an existing one **by guid** and updates it in
place; no match means a new object. So re-running `export`/`deploy` on the same code maps
cleanly onto the same workspace — **no duplicates**. By default the guid derives from the
object's `name` — for a **query**, from its api group, verb, and name together, which is
the engine's own uniqueness for an endpoint, so `GET items` and `POST items` are distinct
objects and a path may repeat across groups. Set an explicit `guid` to pin identity across
a rename, or to adopt an existing workspace object into code.

**`xano.lock`** freezes the whole workspace's identities at once — every auto-derived guid,
plus the `canonical` URL tokens of API groups and toolsets (which the engine otherwise
randomizes, giving the same code different public URLs per environment). Every command that
compiles an entry file writes it — `export`, `deploy`, `release`, `preflight`, with no flag —
and updates it on every build, atomically, before the bundle. **Commit it next to your code.**
`npm run xano:check` is the CI guard (`xanosdk export ./xano/index.ts --check --strict`, which implies
`--frozen-lock`, writes nothing, and needs neither `xano/.env` nor `xano/.secrets.json`): it fails rather than change the lock,
so an uncommitted identity change is caught in review instead of on a deploy. It also fails
while the lock carries an entry no exported object matches. That entry is how a rename looks
before its fix-up — the old name keeps the identity while the new name mints a fresh one, so
the next sync deletes the object and creates another in its place. A plain `export` only warns
and writes the entry down, and from then on nothing tells a rename from a deletion, so the
check asks you to say which: `lock rename` to finish the rename, `lock prune` to drop an entry
whose object really is gone. If you adopted a live workspace with `lock import` and are porting it
a piece at a time, those unported entries pin objects that are still serving and must not be
pruned — pass `--allow-lock-orphans` to accept them and keep the rest of the check. An installed
toolchain module's own frozen check rides on the same run, so a stale artifact it owns fails
there too, instead of being rewritten.

`compile` and `paths`/`routes` only *read* a lock; they never write one, so listing your
routes never mints a URL token it would then discard.

**`--no-lock`** builds without one, for a throwaway run or a tree that cannot be written.
Identities then derive from names, the instance invents public URLs your project will not
learn, and `deploy --to workspace --prune` is unavailable. It is *refused* over a lock that already
parses — building name-derived guids against a lock that pins different ones is a
delete-and-recreate of every object, reported as success. If the lock itself is corrupt,
`--no-lock` is the way past it.

**Releasing to a workspace that already exists?** Adopt what it already serves *first*:

```bash
xanosdk lock import <its-packageExport.json> --lock=xano/xano.lock
```

Without that step your first locked build mints its own URL token for every API group that
names no `canonical` in code. The workspace keeps the slug it already serves — an unpinned
value is a preference, and an update keeps the stored one — so the lock would record a URL
that is not the one being served, and would keep recording it. Adopting first makes the lock
true. A brand-new workspace has nothing to adopt and needs no such step.

**One directory, one lock.** The lock lands beside the *entry file*, so two entry files in
the same directory share it — each build then reports the other's objects as orphans, and a
`lock prune` would delete them. Give each entry its own directory, or name its lock
explicitly with `--lock=<path>`.

Precedence at emit is always **explicit in-code value → lock entry → name derivation**.

**When the lock is actually load-bearing.** Because the default derivation is deterministic
— `md5("<type>:<name>")`, and `md5("query:<group>|<verb>|<name>")` for a query — a project
that created all of its own objects can regenerate a
byte-identical lock from its own source. Delete that lock, release again, and the same guids
come back: the objects match and update in place. For that project the lock is a *cache*, and
losing it costs nothing.

The lock is load-bearing exactly where a live guid **diverges** from that derivation, which
happens two ways:

- **Adopted** objects — anything built in the Xano UI first and taken over with `lock import`.
  The engine assigned those guids randomly; nothing in your code can re-derive them.
- **Renamed** objects — `lock rename` pins the original guid under the new name, so the
  derivation no longer reproduces it.

For those entries the lock is irreplaceable, and losing it means the next release matches
nothing and creates a duplicate of every diverged object. A workspace adopted wholesale from
the UI can be almost entirely divergent, so treat *that* lock as the critical artifact.
Either way, commit it — the cache is worth having, and you generally will not know which
entries have diverged without looking.

**Renames** — with a lock, a rename in code no longer means delete+create on sync. The
export warns about the orphaned entry and names the fix-up:

```bash
# code: defineFunction({ name: "signup" }) → { name: "register" }
xanosdk export ./xano/index.ts             # stderr: lock entry "function:signup" matches no exported object…
xanosdk lock rename --entry=xano/index.ts function signup register
xanosdk export ./xano/index.ts             # emits signup's original guid under "register" → engine renames in place
```

**Merge conflicts** — two branches that both touched the lock can conflict in git, and a
lock still holding `<<<<<<<` markers is refused by every command, saying so. Resolve it as
the union of both sides: keep every entry under `objects` (and `landed`) from each, then
delete the markers. If both branches renamed the same object — one to `stock`, the other to
`goods` — the union holds one guid under two keys, which every command refuses, naming both.
Keep the name your code exports and drop the other; both commands read such a lock:

```bash
xanosdk lock rename --entry=xano/index.ts table stock goods    # moves stock's identity onto goods
xanosdk lock prune --identity-only --yes table:stock --lock=xano/xano.lock   # or just drop it
```

`rename`/`adopt` take no entry file, so on their own they look for `xano.lock` in the
**current directory**. Pass `--entry=<path>` to derive it beside the entry the way
`export`/`deploy`/`prune` do, or `--lock=<path>` to name the file outright. They never
reach for a lock you did not point them at — when they spot one next door they say so and
stop, rather than writing a file you did not name.

**After `--replace`** — a replace rebuilds the workspace with fresh engine identities, so the
lock is stale the moment it finishes and the next ordinary merge would match nothing and
try to create everything. `xanosdk deploy ./xano/index.ts --to workspace --replace` now re-pins the lock from the rebuilt
workspace itself and tells you to commit it. If there is no lock to re-pin, it says so —
without one, the next merge duplicates every object.

**Importing a live workspace's identities** — `xanosdk lock import <bundle.json>` seeds the lock from a
real engine `packageExport`, capturing the live workspace's random guids by `(type, name)`
so code takes over an existing workspace and the first sync updates in place instead of
duplicating.

**CI** — `xanosdk export ./xano/index.ts --check --strict` (the scaffolded `npm run xano:check`) runs every
check an export runs and writes nothing, so it needs no secrets. It implies `--frozen-lock`, which
fails instead of changing the lock, so a canonical
minted in a throwaway container can never silently diverge public URLs. Mint locally, commit
the lock. It fails on an entry no exported object matches too, which is the state a rename
leaves behind until `lock rename` moves the identity across (or `lock prune` drops it).
