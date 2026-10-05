# Signing in & deploying

Authentication, ephemeral environments, static hosting, releasing to production, and validating against a live instance.

## Signing in & deploying (in depth)

**Sign in once** with `xanosdk login`. It runs the standard authorization-code + PKCE
browser flow (powered by the OpenID-certified [`openid-client`](https://github.com/panva/openid-client)):
opens your browser, you approve, and the CLI captures the redirect on a `127.0.0.1`
callback. On first use it dynamically registers its own OAuth client (RFC 7591) so the
authorize step never depends on the server tolerating an arbitrary loopback port; the
registration is cached in `~/.xano/xanosdk-clients.json`. The instance you're bound to is
read from the token's own `aud` claim.

`login` also **pins the numeric workspace** you consented to into the credential, so every
later command acts on exactly that workspace without looking it up again. There is **no
`--workspace` flag** — a credential addresses exactly one instance and one workspace. Run
`xanosdk workspace details` to see which.

The credential caches by default in a **shared** `~/.xanosdk/auth.json`, reusable
from **any** project directory — so a single `xanosdk login` covers all your projects.
Override the OAuth host with `--origin`/`$XANO_ORIGIN` and the loopback port with `--port`.

**Named profiles.** That file holds any number of credentials, each under a name.
`xanosdk login --profile staging` adds one without touching the others; `--profile <name>`
(or `-p`) selects one for a single command. See [Credential profiles](#credential-profiles)
below.

**When the browser can't reach this machine** — a remote shell, a container, a
Codespace — the `127.0.0.1` redirect lands nowhere and `login` waits five minutes for a
callback that will never arrive. Run `xanosdk login --paste` instead. It binds nothing:
it prints the authorize URL, you finish signing in in whatever browser you have, and
your browser then fails to load the `127.0.0.1` callback — which is expected. Paste that
URL back from the address bar (or just the `code=` value out of it) and the sign-in
completes. Everything else is identical, including the instance and workspace you pick
at consent.

Two things follow from how the code is bound. The paste has to happen in the same run
that printed the URL, so `--paste` needs a terminal — for automation use the environment
credential instead (see [Environment variables](environment.md)). And `--port` still
matters under `--paste`, not because anything binds it, but because it is part of the
redirect URL's identity.

Note this is **not** what `XANO_NO_BROWSER` does: that only suppresses the browser
launch, and still needs the redirect to arrive here.

Running `login` again when the **selected profile** already holds a usable credential
prints what you're signed in to and stops, rather than spending another browser round
trip — pass `--force` to sign in anyway. `login --profile staging` on a machine that
already has `prod` proceeds to consent: the guard is per profile, not per file.

## Credential profiles

`auth.json` holds a map of **named profiles** under a versioned envelope. Each profile is
one credential — one instance, one workspace — in one of two shapes:

- **`oauth`** — written by `xanosdk login`. Refreshes and rotates. Do not hand-edit.
- **`token`** — a meta API bearer token for the same meta APIs, for automation. No login
  flow, no refresh, no rotation. Store one with `xanosdk profile add <name> --instance <url>
  --workspace-id <n>`, which prompts for the token (or reads it piped on stdin) rather than
  taking it as a flag (a secret on a command line lands in the process list and the shell
  history), and checks it against the instance before storing it. The token
  itself stays valid until you revoke it wherever you minted it — `xanosdk logout` and
  `xanosdk profile delete` only remove the CLI's copy.

Both shapes work at **either** location (project-local `./.xano/auth.json` or global
`~/.xanosdk/auth.json`) on the same file precedence ladder below.

**Which profile a command acts as**, highest first:

1. `--profile <name>` / `-p <name>` on the command line.
2. `xano.profile.json` at the project root — a committed, secret-free pointer naming one
   profile, found by walking up from the working directory and stopping at the first
   `package.json`. Write it with `xanosdk profile use <name>`. Nothing ambient outranks it:
   a `$XANO_PROFILE` left in a shell rc cannot retarget a pinned project.
3. `$XANO_PROFILE`.
4. The credential file's own `default` key. Set it with `xanosdk profile set-default <name>`.
5. The literal name `default`.

`xanosdk profile use` pins **this project**; `xanosdk profile set-default` changes **this
machine**. `xanosdk profile list` shows every profile with the default and the active one
marked, and `xanosdk whoami` and `xanosdk status` both report which profile is in play and
which rung chose it.

Writes are serialised on a lock and merge one profile at a time, so signing in, signing
out, or refreshing a token in one profile never touches another — including from two
processes at once.

> **Upgrading:** a file written before profiles is read as the `default` profile with no
> action needed. It is rewritten in the new shape the next time something writes to it.

**Project-local credentials** — pass `--local-auth` to `login` to cache tokens in a
**project-local** `./.xano/auth.json` instead (which `login` **auto-adds to `.gitignore`**),
scoping the sign-in to that directory. Every command that **reads** credentials
(`deploy`/`details`, `whoami`, token refresh) resolves them **project-local first, global
as a fallback**: it uses `./.xano/auth.json` when present, otherwise `~/.xanosdk/auth.json` —
so a `--local-auth` project keeps working without repeating the flag. `login` and `logout` do
**not** fall back: they target the shared global cache unless you pass `--local-auth`. A `logout`
naming a profile that only `./.xano/auth.json` holds exits 8 (not found in the shared file)
and names `xanosdk logout --local-auth -p <name>` — it does not report the session as gone. A
logout clears stored profiles only: with the `XANO_*` credential variables still set, it
says so, and commands keep authenticating with them. An explicit
`--config`/`$XANO_CONFIG` wins over both default file locations; only the three-variable
environment credential (below) outranks it, since it reads no file at all.

`deploy <file>` runs the exact same pipeline as `export` (including writing and
seeding `xano.lock` — the identities come from your code, so a throwaway
environment cannot leak into them), then create-or-refreshes the target environment and imports the compiled
workspace into it as a full replace — or, with `--keep-data`, as a merge (see
[Keeping your data between deploys](#keeping-your-data-between-deploys)). `deploy --bundle <path>` skips the compile and uploads a
bundle a previous `export` wrote (handy in CI). A **projected, secret-free summary** prints to stdout
as JSON, while the human-readable progress (and the live URLs) echoes to stderr:

```jsonc
{
  "kind": "ephemeral",                  // or "local"
  "destination": {                     // the PARENT it was created under, then the environment itself
    "instance": "https://x.xano.io", "workspaceId": 1, "kind": "ephemeral",
    "label": "ezm0-xkdq-6564", "url": "https://x.xano.io/tenant/ezm0-xkdq-6564",
    "display": "my-app"                // its display name, when it has one other than the handle
  },
  "profile": { "name": "default", "source": "implicit" },              // null for an environment credential
  "url": "https://x.xano.io/tenant/ezm0-xkdq-6564",                    // the environment's own base URL
  "ephemeral": { "name": "ezm0-xkdq-6564", "display": "my-app", "expiresAt": "…" },
  "created": true,                      // false on a refresh
  "data": "replaced"                    // or "kept" — see Keeping your data between deploys
}
```

Present only when they apply: `localEngine` (in place of `ephemeral`), `keepDataSkipped` and the
merge lists (see [Keeping your data between deploys](#keeping-your-data-between-deploys)),
`static` (`url`; `canonical`, the build's identity, and `verified` when the frontend was
confirmed live serving it; `staticEnv` — `{ injected, keys, documents, skipped?, reason? }` — when config was
injected; or `error` with `retry`, the `xanosdk publish` that retries only the static step),
`microservices` (or `microservicesError`, `{ message, remedy }`, when their status could not be
read after the deploy), `testRun` (`total` — the whole suite, `passed + failed + notRun` —
`passed`, `failed`, `notRun`, and `tests[]` each with `kind`,
`name`, `qualified` — the `type:object/name` form `xanosdk test run` takes (a query's object is its
lock key, `query:<group>|<verb>|<name>/<test>`), `workflow:<name>` for a workflow test — `object` for a
unit test (a query's carries `group` and `verb`), `status`, `message` (the first failure),
`expectations` for a unit test — every expectation in order, `{ index, status, message? }`, `index`
from 0 — and `timing` for a workflow test — the engine reports none for a unit test; plus `error` and `retry`, the `xanosdk test run-all` to run
again, when the suite could not be run — exit 6 — and `unreachable`, the tests it never reached
(as `test run` takes them), when it stopped answering part-way; the same `N passed, M failed,
K not run` line `test run-all` prints closes the run), `landingRecord` (`{ destination, file,
recorded, changed, cleared }`: what this deploy recorded as landed, the scope of a later
`--prune`; `null` for a Xano Engine), `staticRemoved` (`{ urls, verified }`: the frontends a replace took down, below),
`notApplied` (flags accepted and not acted on — `--expires-hours` on an ephemeral that already
exists), `unconfigured`, and `passwordHashesUnverifiable` (below). The raw
workspace blob is deliberately never dumped: it carries per-tenant secrets that must not land
in shell history or CI logs.

`xanosdk test run-all --json` (and `test run`, `test list`) writes the same per-test entries at
the top level, beside the backend they ran on: `kind`, `env` (the ephemeral's or tenant's handle;
`null` for a Xano Engine or a workspace), `name` (the backend's own name whatever its kind — the
same handle on an ephemeral or tenant, the engine's name on a Xano Engine) and `display` (its display
name), each always present, `null` where the backend has none. When the suite stops answering
part-way, the rest are not started and the run exits 6 with a failure document whose
`details.results` is that document — `total` the whole suite, `notRun` and `unreachable` the tests
that could not be run, `tests[]` the ones that did — and `details.unreachable` names them again
(as `test run` takes them). Every run document carries `notRun` (`0` on a run that finished), the
same counts `deploy --test`'s `testRun` carries.

**A retry the error prints** — when a deploy stops short (a new ephemeral not ready yet) or its
import's answer is lost, the error names the command to run next: this run's own, with its
credential flags, without create-only flags like `--expires-hours` (the ephemeral already
exists), and with no secret in it. `--env-var`, `--doc-token` and `--origin` values are left
out and named (`--env-var GREETING`) — pass them again, or keep them in `xano/.env` and
`xano/.secrets.json`, which a deploy reads. The same text is the `--json` error's `message`.

**Where it goes** — the instance your **token is bound to** (the token's `aud`), never a
flag. `xanosdk deploy --ephemeral` create-or-refreshes an **ephemeral**; a bare `xanosdk deploy`
runs the code on the Xano Engine on this machine instead ([below](#deploying-locally)). Reaching your real workspace is the separate release flow: cut a release from
what ran, then `xanosdk promote <release>` lands it there as a new branch, leaving live
untouched until you say otherwise.

**Static host** — `deploy --static <dir>` archives a directory and deploys it to a
static host after the backend import. The frontend lands **on the ephemeral itself**, so the
backend and the frontend live in one environment. The CLI uploads the archive to
`/api:meta/workspace/{id}/static_host/default/build` with your ordinary bearer. That route
auto-creates the `default` host (and only that one: a `--static-host` naming a host the target
does not have is not found, exit `8` from `publish`, naming the hosts it does have) and
**auto-deploys to `dev`**, returning the live URL — so
the static step is independent of the backend deploy (the backend still runs first because
it's the primary action). The directory is checked **before anything is uploaded**: a missing
path, a file, an empty directory, or a build whose compressed archive is over the 100 MB upload
cap is refused and nothing is deployed (`publish` checks the cap before it asks, too). An upload that fails
after the backend landed leaves the backend in place and still writes the deploy's own `--json`
summary (not a failure document), with `static` holding `error` (the reason, as printed),
`retry` (the `xanosdk publish` that retries only the static step) and `completed`. The exit
code says whether the frontend is up: `3` with `completed: "no"` when nothing was sent or the
host refused it, `9` with `completed: "unknown"` when the upload was sent and its answer lost
(a 5xx, a timeout, a dropped connection) — run `retry`, which settles it either way.

A **replacing** deploy clears the target's static hosting — whatever the flags, the replace
removes it — so a later plain `xanosdk deploy`, or `deploy --to … --replace` (a workspace, a
tenant, or an ephemeral named as one), takes a published frontend down. Before the import (and
in a `--dry-run` plan) it reads which frontends the target is serving from the platform — one
another project or the dashboard published included — warns naming each URL, and reports them
as `staticRemoved: { urls, verified: true }`. Only when that read fails does it fall back to
this project's record of its last publish, said as unverified (`verified: false`). With
`--static` the new frontend is published again (the URL may change), and a URL it no longer serves
at is still named under `staticRemoved`. Re-run with `--static <dir>` to publish again, or merge (`--keep-data`; under
`--to`, drop `--replace`), which leaves the frontend serving.

**Liveness verification** — the build endpoint returning `200` only means the archive was
*accepted*; the edge may still be starting a cold host (which `503`s for tens of seconds) or
briefly routing the previous build. So after the upload the CLI polls the deployed URL until
the static server reports it is serving **this** build — its `X-Xano-Canonical` response header
matches the canonical returned for the build just pushed — then prints `Frontend is live`. It
polls every second for the first 30s, then every two seconds out to 120s. An unconfirmed poll
is a **warning, not a failure** (the build uploaded fine and usually comes online moments
later; the exit code stays `0` and the summary records `"verified": false`). Verification is
skipped when the response carries no canonical to compare against. Pass **`--skip-liveness`** to
skip the wait entirely — useful for fast iterative deploys or when the deployed URL isn't
reachable from the machine running the CLI.

**Config injection** — before archiving, the deploy rewrites EVERY `.html` document in the
build, inserting an inline `<script>` at the top of `<head>` that assigns each config value to a
`window.<KEY>` global (so it runs before the app bundle). The backend URL is seeded
automatically as `window.XANO_HOST` (from the backend deploy's own response), and
`--static-env KEY=VALUE` (repeatable) merges in extra keys, overriding the seed on a name
clash. A static host has no server runtime — it serves these files verbatim — so injected
values are **public**: base URLs and *publishable* keys only, never secrets (those go in
backend env, read via `env(name)`). Rewriting every document, not just the root, is what a
prerendered build needs: it serves a different document per route, so a root-only injection
leaves every deep link and refresh running with the global unset — and the page still renders.
Injection is skipped (reported as a warning, not a failure) when the archive has no document
with a `<head>` to anchor to, and any individual document that lacks one is named; values are
`<`-escaped so one containing `</script>` can't break out of the element. This is why a
prebuilt `frontend/dist` can retarget any environment with no rebuild.

> **Caching — verify with a cache buster.** The static host serves `index.html` with
> `Cache-Control: public, max-age=3600`, so a browser (or CDN) that loaded the page before
> your latest deploy can hold the old HTML — including a *pre-injection* `<script>`-less
> version — for up to an hour. If `window.XANO_HOST` looks missing, it's almost always this:
> hard-reload (Cmd/Ctrl+Shift+R) or open DevTools with "Disable cache" checked. When
> verifying from a script or agent, append a throwaway query param so you never read a cached
> copy — `curl -s "$URL/?nocache=$(date +%s)"` — and check the fetched HTML for the injected
> `window.XANO_HOST` line rather than retrying the same cached URL.

`xanosdk status` prints the same **environment base URL** out of band, for cases where you'd
rather bake it in at build time — along with the environment's name and expiry, without your
having to know either. (`xanosdk whoami` prints the *instance* base URL, i.e. the account's
origin rather than the environment.) A static failure after a committed backend deploy **does not roll
back**: it exits `3` (`9` when the upload was sent and its answer lost) and prints the `xanosdk publish` command that retries just that
step, without re-importing the backend.

**Publishing a frontend on its own** — `xanosdk publish <dir>` uploads an already-built
directory and nothing else: no compile, no backend import. `--to` picks the destination —
`ephemeral[:<name>]`, `workspace`, or `tenant:<name>`; left off, the backend this project last
deployed to — and a workspace or tenant asks before replacing what its users are served
(`--yes` in CI). After a local deploy it publishes to that engine (`--to local`
names it), server half included — the upload `xanosdk deploy --local --static <dir>`
makes, without re-importing the backend (below). Scaffolded projects carry it as
`npm run xano:deploy:frontend`, which rebuilds first.

```bash
xanosdk promote v2 --set-live                     # the backend, landed and live
xanosdk publish ./frontend/dist --to workspace --release v2 --branch <label> --yes
```

The destination's own URL is injected as `window.XANO_HOST` at publish time (under any
`--static-env`), so a byte-identical build published to an ephemeral and to your workspace
serves two different HTML documents. That is the build-once, configure-per-destination
model, not drift.

A release carries no frontend and nothing records which release a static host is serving,
so the pairing is checked only as far as it can be, and `--json` says how far in `association`:

| `association` | What was checked |
|---|---|
| `none` | No `--release`. |
| `release-exists` | `--release` names a release in this workspace — nothing more. |
| `live-branch` | …and `--branch` is the label your workspace is serving. A label match, not a comparison of the branch's contents with the release. |

`--branch` refuses to publish when the label is not live, since the frontend would otherwise
sit in front of a backend it was not built for. It applies to `--to workspace` only.
Publication and rollout are reported apart — `published: true` with `verified: false` and
`verification: "unconfirmed"` means the upload succeeded but the host was not seen serving it
inside the wait window. Unlike `deploy --static`, `publish` holds no seed rows, so it cannot scan
the build for non-public seed values. An `index.html` that loads `.ts`/`.tsx`/`.jsx` source (the
unbuilt source directory, not its build output) is still published, with a warning on stderr and
in `--json` `warnings` naming the build step.

`deploy` reuses cached tokens and **refreshes them automatically** when the access token
expires (Xano rotates the refresh token on every use; the new one is persisted). A rejected
refresh (`invalid_grant`) clears the stale cache and tells you to `xanosdk login` again.

**CI & agents** run non-interactively. The credential to reach for is the **meta credential
as three environment variables** — the `type: "token"` record above, with no file:

```bash
XANO_INSTANCE_URL=https://your-instance.xano.io \
XANO_WORKSPACE_ID=3 \
XANO_META_TOKEN=your-meta-api-token \
  npx xanosdk deploy ./xano/index.ts
```

Nothing is read from or written to disk, and nothing rotates, so the same three secrets keep
working run after run — which is what makes this the right shape for a CI job. It **outranks
every other credential**, including an explicit `--config` path, `$XANO_PROFILE` and
`$XANO_REFRESH_TOKEN`; whichever it displaces is named on stderr, so it never wins silently.

An explicit `--profile` is the one exception: it is a **hard error** rather than a
displacement, because it selects a stored credential that the environment has already
outranked, and acting on a different tenant with a contradicting flag on the command line
is the failure this ladder exists to prevent.

All three are required **together**. Setting some but not others is a hard error naming the
rest, rather than a quiet fallback to another credential — a workflow with one misspelled
secret must not deploy against whatever happens to be on the runner.

> **Automated agents:** do **not** invoke `xanosdk login` — it blocks on interactive browser
> consent. Use the three variables above.
>
> The older `$XANO_REFRESH_TOKEN` + `$XANO_CLIENT_ID` pair still works (both copied once
> from the profile in `auth.json` after a local `xanosdk login`; the target instance is read from the refresh
> token's `aud` and the workspace resolved per run), but Xano **rotates refresh tokens on
> use** — a stored one is spent by its first exchange, so a job that runs twice fails the
> second time. Prefer the meta credential.

## Checking against a live instance (xanosdk preflight)

`xanosdk preflight` proves your compiled output against a **real, running Xano
instance** — not a static snapshot. It compiles your workspace, imports it into a
**fresh ephemeral environment created for that run**, exports it back, and diffs it
against what you compiled, so you catch three classes of problem a local build can't:

1. **Import accepts** — the engine actually accepts the bundle (malformed-but-shaped output is rejected here).
2. **Round-trip parity** — the workspace the engine stores, re-exported in the same bundle format, matches your compiled JSON after normalization (full object logic included). Every authored kind is diffed — tables, functions, queries, triggers, tasks, and more — each object matched by identity and reported per kind.
3. **Runtime** (`--runtime`) — each deployed function actually runs on the engine, with no input, with logs surfaced on failure. A function that throws (a failed precondition, say) fails the gate with the engine's message. A function that declares inputs and is refused only for a missing or invalid one is reported as not run (`needs inputs`, and `needsInputs: true` in `--json`) and does not fail the gate — the run said nothing about its logic, so cover it with a unit test that supplies the inputs.

It talks only to public meta API routes — the **same** archive import `xanosdk
deploy` uses, plus the workspace export. There is one way into an instance, so a
transport bug is one `preflight` reproduces rather than routes around. (It also
fetches the engine's own XanoScript rendering of the imported environment, but only
when an installed toolchain module asks for it; the SDK fetches and hands it over,
and the comparison belongs to the module.)

It is non-destructive: nothing you own is written to. Each run creates its own
ephemeral environment, imports into that, and deletes it afterwards — including when
the import is rejected or a transport error is thrown. The environment carries a
short expiry, so even a killed process leaves nothing permanent behind. A fresh
environment per run is also what makes the diff trustworthy: the objects read back
can only have come from this bundle, never from what a previous run left.

**Setup** — nothing, if you have run `xanosdk login`. With no `XANO_VALIDATE_*`
variable set, `preflight` uses the credential the rest of the CLI already acts on
and creates its ephemeral under the workspace that credential pins.

To point a run somewhere else — a different instance, or a local Docker one —
copy `.env.example` to `.env` (gitignored) and fill in a base URL + token. That
pair takes over whenever it is set, and switching between a cloud dev instance
and a local Docker one is just a different `XANO_VALIDATE_INSTANCE`:

```bash
# .env
XANO_VALIDATE_INSTANCE=https://your-instance.xano.io   # or http://localhost:8080 for local Docker
XANO_VALIDATE_TOKEN=your-meta-bearer-token
# XANO_VALIDATE_WORKSPACE_ID=…                          # optional; PARENT workspace the run's env is created under (default 1)
```

```bash
xanosdk preflight ./xano/index.ts                      # import + round-trip diff, reports per object (every authored kind)
xanosdk preflight ./xano/index.ts --runtime            # + run each deployed function
xanosdk preflight ./xano/index.ts --capture            # + write fetched JSON to ./validate-out (fixture candidates)
xanosdk preflight ./xano/index.ts --instance http://localhost:8080   # override the target for one run
xanosdk preflight --bundle ws.json                     # check an already-exported bundle
```

Two sources, and the environment wins. Set any `XANO_VALIDATE_*` variable (or
pass `--instance`) and the run targets what it names, reading the token from
`XANO_VALIDATE_TOKEN` — env-only, never a flag, so it stays out of your shell
history and the process list. A `.env` in the current directory is autoloaded for
those three variables and nothing else, and a real environment variable beats the
file. Set none of them and the run falls back to your stored login, where
`--profile` selects which credential to act as. A half-set environment is an
error naming the variable it is missing, never a silent fall back to your own
workspace. A non-zero exit means a check failed; `--verbose` prints full diffs and
raw engine detail instead of a projected summary.


## Wiring the frontend to the backend

**Wiring the frontend to the backend.** The deploy bakes the environment's backend URL into
every HTML document in your build automatically, as a `window.XANO_HOST` global evaluated
*before* your app bundle — every document, so a prerendered build's deep links and refreshes
boot with the same backend the root does. So read it at runtime with a build-time fallback and you never have to
know the URL ahead of time:

```ts
const HOST = (typeof window !== "undefined" && window.XANO_HOST) || import.meta.env.VITE_XANO_HOST;
```

`window.XANO_HOST` is the **environment** URL your deployed APIs answer at (the same value
`xanosdk status` prints as the environment's URL); it is *not* `xanosdk whoami`, which prints
your account's instance origin. Because injection happens at deploy time, a prebuilt
`frontend/dist` retargets any environment with **no rebuild** — ideal for headless agents.
Add your own public config (base URLs, *publishable* keys) with `--static-env KEY=VALUE`
(repeatable), exposed the same way as `window.<KEY>`. A static host serves these files
verbatim to the browser, so everything injected is **public** — never put secrets here;
those belong in backend env, read server-side via `env(name)`.

**Your dev server follows the deploy.** In a scaffolded project, a deploy that publishes no static site writes the backend
URL into the project's gitignored `.env.local` as `VITE_XANO_HOST`, in a marked block that leaves your own values alone and
is replaced rather than repeated next time. **Restart the dev server to pick it up.** `--no-dev-env` turns it off, and so
do `--static <dir>` and a site an earlier deploy published there that still serves — a frontend reads the URL at runtime. A `.env.local` your repo does not ignore is
reported, never written.

**Showing a stored file.** A file column comes back as `{ path, name, type, size, meta,
access, url }`. Don't use its `url`: on a tenant-scoped environment that field addresses the
instance host *without* the `/tenant/<name>` segment and 404s — as a broken `<img>`, while
every assertion about the response still passes. Build the URL from `path` and the host you
already have:

```ts
import { fileUrl } from "@xano/sdk";

<img src={fileUrl(row.avatar, HOST) ?? ""} />   // null for an absent file
```

**Verifying the injection:** the served `index.html` writes the global in **bracket
notation** — `window["XANO_HOST"]="…";` — so grep for the bare token `XANO_HOST`, not the
exact string `window.XANO_HOST` (the dot form is valid to *read* the global in your app,
but it's not what the file contains, so an exact-string grep for it wrongly reads as "not
injected"). It can also be served from cache for up to an hour after a deploy — fetch once
with a cache-buster (`curl -s "$URL/?nocache=$(date +%s)" | grep XANO_HOST`) rather than
retrying the bare URL.


## Deploy targets, and what a release changes

**Disposable targets and real ones**, so the dev loop and the production step stay distinct:

| Command | Where it goes |
|---|---|
| `xanosdk deploy` | The **Xano Engine** on this machine — the default, with no flag and no Xano account needed ([below](#deploying-locally)). `--local` spells it out. |
| `xanosdk deploy --ephemeral` | A disposable **ephemeral** environment on Xano's cloud — create-or-refreshed each run, auto-expiring, with its own URL. |
| `xanosdk promote <release>` | Your **main Xano instance** workspace — the production target. Lands a release on a branch named for it (`--set-live` serves it). Its table changes reach live as it lands — see [what a landing does to tables](#what-a-landing-does-to-tables). |
| `xanosdk tenant deploy <tenant> <release>` | A **customer tenant** — the same release, landed on someone else's deployment. It **replaces** what the tenant serves: anything the release does not carry is removed. Static hosting is kept. |
| `xanosdk deploy --to <dest>` | The **escape hatch**: merges a local build straight into `workspace` or `tenant:<name>`, skipping the release record. |
| `xanosdk test` | Nothing — it only reads. Runs the tests an already-deployed backend carries; `--on` picks which one, `local` and `workspace` included. |

Not every instance has ephemeral environments enabled. Where they are off, `deploy --ephemeral`
says so and names who can turn them on. A bare `deploy` (the Xano Engine), `xanosdk export` and
`xanosdk preflight` still work meanwhile.

Every `deploy` is a **full replace** of the disposable environment — always fresh — unless
you pass `--keep-data`. Landing somewhere real is the opposite by design: it changes what
your code defines and leaves the rest of the workspace — including every row in every
table — alone.

A replace clears everything the ephemeral holds, so before it writes, a refresh reads the
ephemeral and checks for objects **another source landed there** (another project's
`deploy --to tenant:<name>`, say) — anything this project neither sends nor landed before. As
with `--keep-data` below, those are deleted only with `--yes` or a yes on a terminal; without
one the deploy is refused before anything is written (`SDK_PRUNE_OUT_OF_SCOPE`, exit 2, each
object in `details.outOfScope`, and the rerun with `--yes` printed).

### Keeping your data between deploys

`xanosdk deploy --keep-data` redeploys to your ephemeral or Xano Engine by **merging** into
what an earlier deploy put there, instead of replacing it. Code and schema changes land,
objects removed from the project are deleted, and the rows already in the tables stay. Seed
rows are not written again.

The merge mirrors this project's source: the environment is the project's own sandbox, so
anything on it the project no longer declares is deleted. The preview tells that apart from
objects another source put there (a `deploy --to tenant:<name>` naming it from another
project, say) by the ephemeral's landing record: an object this project landed there is one
it "no longer declares"; anything else is "not in this project (landed by another source)".
Those are deleted only with an answer — `--yes`, or a yes on a terminal (a no writes nothing
and exits 0, as any declined confirmation does). Without one the
merge is refused before it writes, as `--prune` refuses the same deletion:
`SDK_PRUNE_OUT_OF_SCOPE`, exit 2, each object in `details.outOfScope` as `{ type, name, label }`
(the shape `deploy --to --prune` uses), and the rerun with `--yes` printed. A merge that goes ahead names them in `--json`'s `notLanded`. The scaffolded
`npm run xano:deploy` passes it, so the rows you enter through your app survive
every code change.

It merges only into an environment an earlier deploy **finished** filling. Otherwise it
replaces and seeds as a plain deploy does, and says why:

| Reason (`keepDataSkipped` in `--json`) | When |
|---|---|
| `new` | Nothing was recorded for this project yet. |
| `recreated` | The recorded environment is gone — the ephemeral expired, or the engine restarted. |
| `never-filled` | The environment exists, but no deploy into it completed (or `.xano/ephemeral.json` lost the marker that one did — the message says which). |
| `reset` | `--reset` was passed; it always wins. |

A deploy that fails does not unmark the environment: a refused one wrote nothing, and one
whose outcome is unknown (its answer was lost, or the instance failed the merge with a 5xx —
exit 9) may have landed in whole or in part. Check what the environment holds before rerunning;
either way the next `--keep-data` still merges.

The `--json` summary carries `data: "kept"` or `data: "replaced"` on every deploy.

Before it writes, a merge prints what it will cost, without prompting:

- every table it drops (removed from the project) with its rows, and every column it drops;
- every column whose **type** changes — only the definition changes, and the stored values stay:
  a value that reads as the new type does (int → text: `11` reads `"11"`), one that does not
  reads `null` while the column has the new type, and reads again if it is retyped back. A
  vector's size is part of its type (`vector(3)` → `vector(4)`, see the table below);
- every value removed from an **enum** column — rows holding it are not rewritten, and read
  `null` until the value is restored;
- every **table reference** pointed at another table — the ids the rows hold are kept, and now
  name rows of the new table;
- every public URL slug a changed `canonical` moves — every endpoint under the old slug stops
  answering;
- every column that becomes **nullable** — a merge keeps the table's NOT NULL (an insert without
  it still fails) though the export reads nullable, and only this preview can see it; `--reset`
  (or `--replace` under `--to`) recreates the table, which relaxes it;
- every column that stops being nullable — rows holding `null` there are not rewritten, and read
  back as the type's empty value (int `0`, text `""`; a date column's key is left out of every row);
- every index it adds or drops;
- every new table whose seed rows it does not write;
- every env var whose project value differs from the live one — a merge keeps the live
  value (`xanosdk env set <NAME> <value>` changes it). Only names are printed, never values;
- every other object it deletes, named `<kind>:<name>` (`function:old_helper`,
  `query:GET ping (apiGroup shop)`).

The `--json` summary carries the same lists, each only when it names something:
`droppedTables`, `droppedColumns`, `retypedColumns` (each `{ table, column, from, to }`, plus
`stored` — the type its values are held as, when known — `default` and `nullable` when declared,
`useXdo` on a JSON-storage table,
and `omittedInsertsFail` / `setInsertsFail` when inserts fail; see below),
`notNullKept`, `pairedColumns` (`{ table, dropped, added }`: a drop beside an add, not a rename),
`narrowedEnums` (`{ table, column, removed }`), `retargetedRefs` (`{ table, column, from, to }`),
`indexChanges` (`{ table, index, action, unique }`), `notNullTightened` (`{ table, column, type }`),
`storageChanges` (`{ table, from, to }`: the table's `useXdo` before and after),
`removed`, `unseededTables` (new tables whose seed rows the merge did not
write), `renamedTables` (each `{ from, to }`: renamed through `xanosdk lock rename`, rows kept),
`unchangedEnv` and `canonicalChanges` (each `{ kind, name, from, to }`: a public URL slug a
changed `canonical` moved — every endpoint under `from` stops answering). A realtime server's
moved slug, or a channel renamed in place, also leaves its `conversation` transcript and
`at_least_once` replay under the old name (warning `plan.realtime-history-detached`); moving
the name back restores them. Columns are named
`table.column` everywhere.

The limits, in one place: rows survive only in tables and columns that keep their identity
(a table renamed through `xanosdk lock rename` keeps its rows; an unrecorded rename is refused,
below); changed env values and a new table's seeds need `--reset`;
a Xano Engine's rows last as long as its process (an engine update restarts it empty, and the
next run seeds); and a test whose `datasource` is `"live"`
sees the kept rows, not only the seed fixtures.

If the merge is refused, nothing is written — neither the environment nor `xano.lock` — and
the environment keeps its data. Each refusal is exit 2 and names its remedy:

- **A rename the lock was not told about** (`SDK_IDENTITY_CONFLICT`, `details.refused:
  "renamePending"`): the merge would drop a table `xano.lock` still pins, with its rows, while
  the project adds a new one. Each is in `details.renames[]` as `{ table, guid, candidates,
  rename, prune }` — `rename` is the `xanosdk lock rename …` to run if it was renamed (the merge
  then renames it and keeps its rows), `prune` the `xanosdk lock prune …` if it was deleted.
  Run one, then deploy again. When the new table's def pins its own `guid:`, `setGuid: { table,
  guid, pins }` replaces `rename`: set that def's `guid:` to `guid` — a def's guid replaces any
  lock entry, so a `lock rename` would not keep the rows. The lock marks such an entry
  `"guid_source": "code"`. An export that re-pins a table to its def's guid keeps the guid it
  replaced as `"replaced"` (warning `lock.repinned-table`), so the merge refuses to drop a
  table still holding it; `prune` is then `lock prune --identity-only table:<name>`.
  The same refusal names a realtime channel (realtime server, api group) renamed in code whose
  children — its messages — now collide by name: its entry in `details.renames[]` is
  `{ kind, name, guid, candidates, rename, conflicts }`, and its `lock rename` moves the
  children's entries with it.
- **A name the environment holds under another identity** (`SDK_IDENTITY_CONFLICT`,
  `details.refused: "identityConflict"`): the same kind and name, a different guid, so the
  merge would delete the live one and create the project's beside it. Each is in
  `details.conflicts[]` as `{ kind, name, liveGuid, projectGuid }`. Pass `--reset` to rebuild,
  or rename one of the two.
- **A pinned public URL the merge cannot serve** (`SDK_IDENTITY_CONFLICT`, `details.refused:
  "identityConflict"`, each in `details.conflicts[]` as `{ kind, name, canonical, liveGuid }`):
  a `canonical` written in code is served as declared or the merge is refused. The usual cause
  is an api group (toolset, realtime server) renamed while keeping its `canonical`: a merge
  creates the renamed object beside the old one, which still holds the slug. The entry carries
  `heldBy` and `rename` — the `xanosdk lock rename …` that makes the merge rename it in place,
  keeping its URL. Otherwise pick another `canonical`, or `--reset`.
- **A unique index the rows already there break** (`SDK_IMPORT_REFUSED`, `details.refused:
  "uniqueViolation"`, the indexes the merge adds in `details.indexes[]` as `{ table, index }`,
  exit 2, nothing written — `deploy --to` too): remove the duplicate rows or the index, then deploy again.
  Under `--to … --seed`, `details.seededIndexes[]` names the unique indexes on seeded tables: a
  seed row colliding with a live row there is fixed by changing the seed value or the live row.
- **Another source's objects** (`SDK_PRUNE_OUT_OF_SCOPE`, `details.refused:
  "pruneOutOfScope"`, above): rerun with `--yes`, or declare them in this project.
- **A table trigger in an ephemeral or a tenant** (`SDK_IMPORT_REFUSED`, `details.refused:
  "tableTrigger"`, each in `details.triggers[]` as `{ name, table }`): a merge into one fails
  while the environment holds a table trigger — the instance answers 500, after part of the merge
  may have landed — and removing the trigger from the project does not help while it is live.
  A replace works: rerun with `--reset` (`--replace` under `deploy --to`), which replaces the
  rows with the seed rows. A merge into a workspace is not affected.
- **A table holding rows switched to the other storage mode** (`SDK_IMPORT_REFUSED`,
  `details.refused: "storageModeChange"`, each in `details.tables[]` as `{ table, from, to, rows }`):
  `useXdo` (the table's own, or the workspace `use_xdo` it inherits) changed. A merge from JSON to
  columns keeps the rows and erases every value for good; columns to JSON fails partway on NOT NULL.
  `deploy --to` and `promote` refuse it too. Keep the mode, or move the rows to a new table
  yourself; an empty table switches, with a note. `tenant deploy` is a replace, and differs:
  JSON to columns converts the table and keeps every value (a note), while columns to JSON is
  refused for every table, empty or seeded — the instance cannot convert a table back to JSON
  storage, and nothing is sent. A `deploy --replace` rebuilds the tables, so it switches either way.

A keep-data refusal's `details` carries `refused` (the reason, a string), `conflicts`, `renames`
and `outOfScope` (each a list, empty when it does not apply), `serverCode` when the environment
itself refused, and `warnings` when the run had some. A `--keep-data` deploy never falls back to a replace.

Another import already running on the instance is not a refusal of the project: any deploy
(`--keep-data`, a replace, `--to`) exits 8 with `SDK_IMPORT_REFUSED`, `details.refused:
"importInProgress"`, writes nothing, and prints the same command to run again in a moment.
`--to` already merges, so `--keep-data --to` is refused; the flags that only mean something
with `--to` (`--seed`, `--prune`, `--dry-run`, …) stay refused alongside it.

### Deploying locally

`xanosdk deploy --local` deploys to an engine running on this machine instead of an
ephemeral — no network round-trip per deploy. It needs nothing configured:

- **The first run** resolves the latest published engine for this machine's platform,
  downloads it, checks it against the sha256 its release recorded, and **pins** that version in
  your `package.json` under `"xanosdk": { "@xano/sdk": { "engine": "vX.Y.Z" } }` —
  creating a `package.json` holding only that pin when the project has none. Commit that change —
  every checkout of the project then runs the same engine.
- **Every later run** uses the pinned version, whatever is newest. Each version downloads once
  per machine and is shared by every project on it (`~/.xanosdk/local-engine`, or
  `XANOSDK_ENGINE_HOME`); a cached pin deploys with no network access.
- **A newer engine** is announced on each deploy (checked at most once an hour; opt out with
  `XANOSDK_NO_UPDATE_CHECK=1`). In an interactive terminal the deploy asks whether to update,
  defaulting to no — a version you declined is only noted afterwards, not asked again. In CI,
  piped output or `--json` it prints a one-line notice and keeps the pin. The pin never moves
  without a yes or an explicit `xanosdk local update`.
- **A running engine on a different version** than the one the project now resolves to — after
  an update, or after a teammate moved the pin — is stopped and replaced, and the deploy says
  so.
- **No lifetime limit.** The engine runs until it is stopped. From v0.1.15 an `--ephemeral`
  engine stops itself after an hour by default, so the SDK starts one with `--ttl 0`, and the
  data and frontend it holds survive between deploys. An ephemeral engine you start by hand
  keeps the one-hour default; its `--ttl <duration>` flag changes it.

An engine update restarts the engine, and a restarted engine starts **empty**: the next
`--keep-data` run (which the scaffolded `npm run xano:deploy` passes) seeds it
rather than merging, so rows entered through your app do not survive the upgrade.

**Operating on it.** After a local deploy, the engine is the backend this project
tracks, so bare `xanosdk test run-all`, `env set`, `env pull`, `tables`, `impersonate` and
`status` reach it — none of them needs a Xano account. Name it explicitly as `local`,
or `local:<name>` for another one from `xanosdk local list` (the full grammar is in
[the CLI guide](cli.md#naming-a-backend)). `publish` puts a built frontend on it without
re-importing the backend. One command cannot serve it and refuses it by name: `release create`
(the cut runs on the instance — pass `--from ephemeral`).

| Command | What it does |
|---|---|
| `xanosdk local update` | Moves the pin to the latest engine (`--version <v>`: that one, downgrades included), downloads it, and restarts the project's running engine on it. Commit `package.json`. |
| `xanosdk local cache list` | Each cached engine version, its size on disk, and the engines running on it. |
| `xanosdk local cache clear` | Removes every cached engine (`--version <v>`: just that one). An engine running on a removed version is stopped first; the next deploy fetches it again. |

#### A frontend on the Xano Engine, and server rendering

`xanosdk deploy <entry> --local --static <dir>` publishes a built frontend to the
engine's own static host after the import, as on an ephemeral, and reports it as `static.url`:
`http://<prefix>.localhost:<port>`. Chrome, Firefox and Safari 26 resolve `*.localhost` to this
machine by themselves (Safari on macOS 15 and earlier does not); a tool that does not resolve it
can call the engine's own URL with a `Host: <prefix>.localhost:<port>` header. The engine needs a release
that hosts static sites: an older one answers the upload with a 501, which the deploy reports
without failing the backend (exit `3`), and `xanosdk local update` moves the pin on.

The engine hosts built output only, and refuses a build of more than 20,000 files or 256 MB unpacked.
The deploy checks both before the import, so an oversize directory stops the run with nothing
written. A symbolic link in the directory is not uploaded.

A SvelteKit app can also render on the server there. Build it with the SDK's adapter (it needs
`esbuild` in the app: `npm i -D esbuild`). In a project `xanosdk init` scaffolded, SvelteKit's
config is the object passed to `sveltekit()` in `vite.config.ts` (a `svelte.config.js` is ignored
there), and it already builds with this adapter: stop prerendering the routes that should render
per request (the scaffold prerenders every route from `frontend/src/routes/+layout.ts`):

```ts
// vite.config.ts, inside sveltekit({ ... })
import adapter from "@xano/sdk/sveltekit";
// ...
    adapter: adapter({ out: "frontend/dist" }),
```

In a plain SvelteKit project it goes wherever that project configures SvelteKit, writing `build/`:
`sveltekit({ adapter: adapter() })` in `vite.config.ts` in a project `npx sv create` makes (it
writes no `svelte.config.js`), or `export default { kit: { adapter: adapter() } }` in a project
that keeps a `svelte.config.js`.

`vite build` then writes the client assets and prerendered pages at the output's root, a
`404.html` fallback shell, and the server half in `.xano-ssr/`. Deployed with
`--local --static <that directory>`, the engine serves the files as files and renders every other
path (a dynamic route, `__data.json`, a form action) through the server half, so a crawler that
fetches `/products/lamp` gets that product's own `<title>` and meta tags. A server `load` reads
the engine's own URL as `XANO_HOST` from `$env/dynamic/private`:

```js
// src/routes/products/[slug]/+page.server.js
import { env } from "$env/dynamic/private";
export async function load({ params, fetch }) {
  const res = await fetch(`${env.XANO_HOST}/api:shop/products/${params.slug}`);
  return { product: await res.json() };
}
```

A rendered page gets the same `window.XANO_HOST` (and `--static-env`) globals the deploy writes
into the prerendered documents.

Any other host (an ephemeral, a tenant, your workspace) is not sent `.xano-ssr/`: it serves the
static half, and answers every other path with the `404.html` shell (status 404), which boots the
app in the browser. There, a route whose data comes from a server `load` (`+page.server.js`)
fails: its `__data.json` is not a file on that host. Prerendered routes, and routes with a
universal `load` or none, work. A prerendered `/404` route (the scaffold has one) stays
`404.html` only while every page route is prerendered; once one is not, the adapter writes the shell
there instead (and says so in the build log), so that route boots — an unknown path still answers
404 and renders `+error.svelte`. Two things to know about the server half:

- **It can hold secrets.** SvelteKit inlines `$env/static/private` values into
  `.xano-ssr/server.js`, which is why it is never served: the engine answers `/.xano-ssr/` with a 404.
- **It runs inside the engine, not in Node.** Module state is per runtime (the engine runs up to
  four per site, so keep state in your API), request and response bodies are buffered (no
  streaming), `request.formData()` reads urlencoded forms only, and there is no
  `AsyncLocalStorage`. A render has 30 seconds and may answer up to 10 MB.

#### Where the engine keeps its data

The cache above holds the engine **binaries**. A running engine keeps its own **runtime data** —
its unpacked runtime files, its logs, and the records of running engines — beside them, under
`engine/` in the same directory (`~/.xanosdk/local-engine`, or `XANOSDK_ENGINE_HOME`): in
`engine/Library/Caches` on macOS and `engine/.cache` on Linux, the directory holding `dist`,
`instances` and `logs` folders. Its `logs` folder holds one file per engine start; a start that
fails names it.

Expect it to reach roughly 600 MB after the first deploy, and to grow by a similar amount for
each engine version you run, since every version unpacks its own copy. `xanosdk local cache
list` shows its size, and `xanosdk local cache clear` (with no `--version`) removes it with the
engines once none is running — it names any engine still up; stop it and clear again. The next
deploy recreates what it needs.

Versions before this layout unpacked the same runtime into your own per-user cache directory.
Nothing runs from that copy now; `cache list` shows it when it is there, and
`xanosdk local cache clear --legacy-runtime` removes it after asking (`--yes` without a
terminal).

#### Running a different engine without moving the pin

To try an experimental build, or a published version the project hasn't moved to, override the
pin for your own runs instead of editing `package.json`:

- `--local=<value>` for one deploy;
- `XANOSDK_ENGINE_OVERRIDE=<value>` for every deploy in this shell, including
  `npm run xano:deploy`, which passes a bare flag.

Both take a **version** (`v0.1.8`, or `0.1.8`: that release from the release manager), an
**`https` URL** to an engine archive, or the **path** to an engine archive on this machine. A
value on the flag beats the variable, and the variable beats the pin. Plain `http://` is refused
unless the host is this machine (`127.0.0.1`, `::1`, `localhost`) — the engine is a program the
deploy runs — and so is any other URL scheme (`ftp://`, `file://`). A path that names no file is
refused too; all of these are usage errors, reported before anything compiles or downloads.

An override never reads or writes the pin and never checks for updates. Each deploy that uses
the variable says so. A URL is printed only when its download fails, and then as its origin and
path, never its query string (a pre-signed link carries its credential there). The engine it names
replaces the project's running engine like any other version change (it starts empty and the
next `--keep-data` run seeds it); unset the variable and the next deploy goes back to the pinned
engine the same way.

```bash
export XANOSDK_ENGINE_OVERRIDE=~/Downloads/engine-experimental.tar.gz
npm run xano:deploy          # runs the experimental build; package.json untouched
unset XANOSDK_ENGINE_OVERRIDE        # next deploy is back on the pinned version
```

`XANOSDK_ENGINE_TOKEN`, when set, is sent only to an override URL's host.
`XANOSDK_ENGINE_RELEASES_URL` points version lookups at a different engine release service. Its
engines are downloaded fresh on every deploy and kept apart from the version cache, and the
deploy runs its latest without reading or writing the pin or checking for updates;
`xanosdk local update` refuses while it is set.

### The release flow

This is the path to a real destination. Each step leaves something the next one can name:

```bash
xanosdk deploy ./xano/index.ts --ephemeral --test   # 1. stand it up on an ephemeral, run its tests
xanosdk release create v1               # 2. cut a release from what just ran (after a local deploy: --from ephemeral)
xanosdk promote v1                      # 3. land it in your workspace, on a branch named for it
xanosdk tenant deploy acme v1           #    …or on a customer tenant
```

Step 2 is what makes the rest re-runnable. A release is a stored record that this code came
up and answered, so `promote v1` a week later lands the same bytes — and `xanosdk release
list` says what you have. Cut a release per merge, per tag, or per deploy you want to keep;
an existing name is refused rather than replaced, because a tenant may be running it.

The platform lands a release itself, so `promote` and `tenant deploy` run no local
pre-flight: no plan preview, no prune scope. They say so before writing. What they have
instead is the release — a thing that came up, that can be landed again.

`promote` does run the identity check `deploy --to workspace` runs, against the release's
archive and the branch it will land on: a name the workspace gives another object, or a slug
pinned in code that another workspace serves, refuses with `SDK_IDENTITY_CONFLICT` (exit 2)
before anything lands — the platform's landing would otherwise add a suffixed second object or
mint another slug and report success. A release's identities are fixed when it is cut, so the fix
is a new release. After landing, `promote` reads the branch back: a pinned slug served under
another value fails the run (`verify: no`, exit 2, `--set-live` not applied); an unpinned one is
warned about (`promote.canonical-substituted`).

##### What a landing does to tables

Tables have no branch. Every landing reads the destination's tables first and names every
effect under one code. `promote`, `deploy --to` and `deploy --keep-data` **merge**: the
release's definitions go over the rows and the stored values stay. `tenant deploy`
**replaces**: the tenant ends up with exactly the release's tables, and values are rewritten.

| Change | Merge | Tenant deploy | Code |
|---|---|---|---|
| table not in the release, or there by name under another guid | left alone | **dropped with every row** (counted, named in the confirmation); the same name under another guid is refused first (`SDK_IDENTITY_CONFLICT`), as `promote` refuses it | `plan.table-drop` |
| column dropped | values destroyed | values destroyed | `plan.column-drop` |
| column retyped | values re-read (int → text: `11` reads `"11"`); one that does not fit reads null, and reads again if retyped back | int, decimal and text values **converted for good** (`"1.5"` → `2`; `"hello"` → `0`; to bool: `false`); one that cannot convert stops it partway; bool → decimal converts (`true` → `1`), timestamp → bool converts to `false`; bool → int or text and timestamp → text are re-read; bool → timestamp and timestamp → int or decimal stop it partway while the table holds rows | `plan.column-retype` |
| vector size changed (`vector(3)` → `vector(4)`) | every stored vector reads null while the column has the new size, and reads again if changed back; an insert that sets a vector fails (SQL `22000`) — add the new size as a new column | stops it partway while the table holds rows | `plan.column-retype` |
| enum value removed | a row holding it reads null until restored | same | `plan.enum-values-removed` |
| table reference retargeted | ids kept, now naming rows of the new table | same | `plan.tableref-retarget` |
| index added or dropped | a unique index over duplicate rows refuses the landing | same | `plan.index-change` |
| column made nullable | a column created required keeps refusing rows without a value | relaxed | `plan.not-null-kept` (merge) |
| column made required | a row holding null reads the type's empty value | null **rewritten** to the empty value for good | `plan.not-null-tightened` |
| new table or column | existing rows read the column's default, else the type's empty value | same | `plan.schema-additive` (promote) |

A merge keeps the old type's storage, and an insert that leaves the column unset writes the
new type's empty value into it — `""` for text, email, password or enum, `{}` for json, `0`
for a number or timestamp, nothing for a date. Where the old storage cannot hold that, every
such insert fails with an SQL error:

| Retyped to | Fails from | Remedy |
|---|---|---|
| text, email, password | int, decimal, timestamp, bool, date, json, uuid, geo | a default the old type reads: `"0"`, `"false"`, `"1970-01-01"`, `"{}"`, a uuid (none for geo) |
| enum | int, decimal, timestamp, bool, date, json, uuid, geo | an enum value the old type reads |
| json | int, decimal, timestamp, bool, date, uuid, geo | none — set it on every insert |
| int, decimal, timestamp, bool | date, uuid, geo | none — set it on every insert |
| uuid | every type but json; one that SETS it fails too unless held as text, email, password or enum | none — add the uuid as a new column (another name) |

A column already declaring such a default is not flagged. A tenant deploy converts all but
bool and timestamp, so only those two retyped to text fail there (SQL `22P02`). The warning
names each column with its remedy, and `--json` marks it `omittedInsertsFail: true` (and
`setInsertsFail: true` when setting it fails too). The old storage is the type the column was
created with: an earlier merge retype does not change it. An ephemeral's landing record tracks
it (`stored`); with no record, the note says the prediction assumes the created type. Some
merge readings differ from the rule in the table above: decimal → int reads truncated (`29.789`
reads `29`, and whole again once retyped back), decimal → text reads padded to the column's
scale (`"29.78900"`), bool → text reads `"1"` / `""`, and int → date reads the int as epoch
milliseconds.

A table with `useXdo: true` keeps its fields as JSON, so none of the failures above apply there:
every value stays as written, an insert that leaves the column unset (or sets a uuid) lands,
and `--json` marks the column `useXdo: true`. Its readings differ too: decimal → text reads as
written (`"1.5"`), text or enum → timestamp or date can read as written or as the time of the
read rather than null, and json → date makes every read of the table fail (HTTP 500) while a
row holds an object there.

`promote` lands on a new branch, but these apply to **live** as it lands, before any
`--set-live`, and deleting the branch does not undo them. So a promote that alters a table
is refused (exit 2, `SDK_SHARED_SCHEMA_CHANGE`, every change in `details.changes`, additions
included) unless you pass `--allow-shared-schema-changes`; additions are named and land, and so
is a non-unique index added or dropped — it changes how rows are found, not what they hold. A
unique index added stays refused. A table that drops a column and adds another is called out
(`details.pairedColumns`): columns have no rename identity, so the old values are destroyed and
the new column starts empty — to keep them, add the new column in one release, backfill it, and
drop the old one in the next. A workspace whose
tables cannot be read is refused the same way. `--json` carries the effects as
`tableEffects`.

A `tenant deploy` of a release without rows keeps the rows of every table the release
carries, and drops the tables it does not carry. A release cut with `--seed` **replaces**
the rows of each table it carries rows for — every row there now is deleted — and keeps
every other carried table's. It names each one with both
counts before asking (`table items: 300 rows replaced by 3 seed rows`, `seedRowsReplaced`
in `--json`); off a terminal it needs `--yes`.

They differ in what they leave behind. `promote` adds a branch and leaves the live one
serving. `tenant deploy` replaces what the tenant serves with the release, so an API that
an earlier landing or a `deploy --to tenant:<name>` merge added is removed. Static hosting
is kept. Cut a release that carries everything the tenant should serve.

A `promote` over rows that break a unique index the release adds lands nothing — no
branch, live as it was — and exits 2 (`SDK_CONSTRAINT_VIOLATION`, `details.constraint`
naming the index when the release adds exactly one, `uniqueViolation: true`).

A `tenant deploy` that stops partway can leave the tenant partly replaced. When the
tenant's rows break something the release adds — a unique index over rows that share a
value, a required field that rows leave empty, a stored value a retype cannot convert
(`constraint.kind: "conversion"`, naming the column when one retype could cause it) — it
fails with `completed: "no"`, `partlyReplaced: true`, the `constraint` it hit, and
`recoverWith`: the `tenant deploy` of the release it ran before, which puts its logic and
definitions back (values a conversion already rewrote stay rewritten). Fix the rows, then land again. For
an `unknown` outcome, an unmoved `deployedAt` means the release did not land, not that the
tenant is untouched: land the previous release again to be sure.

#### Reading the result: `--json` and exit codes

`release create`, `promote`, `tenant deploy` and `release transfer` answer in one shape. Under `--json`, or
whenever stdout is not a terminal, stdout holds a single JSON document. The command writes
it on failure as well as success, once it knows what it was about to write. Every date in a
`--json` document, from any command, is ISO 8601 UTC (`2026-10-01T09:13:16.000Z`):

```jsonc
{
  "ok": false,                          // only when the run failed, beside `error`
  "operation": "promote",
  "destination": { "instance": "https://…", "workspaceId": 1, "kind": "workspace" },
  "release": { "instance": "https://…", "workspaceId": 1, "id": 42, "name": "v1" },
  "branch": "v1-20260922T140000Z-3f2a", // the label promote landed on; null for tenant deploy
  "completed": "unknown",               // yes | no | unknown
  "steps": [
    { "name": "land", "completed": "unknown" },
    { "name": "verify", "completed": "skipped" }
  ],
  "resolveWith": "xanosdk workspace branch list --json",
  "resolveSteps": ["If \"v1-…\" is absent, nothing landed: re-run as `xanosdk promote v1 --branch v1-… --yes`.", "…"],
  "startedAt": "2026-09-22T14:00:00.000Z",
  "resolveNotBefore": "2026-09-22T14:10:00.000Z",
  "error": { "code": "SDK_ERROR", "message": "…", "exitCode": 9 }   // only when the run failed
}
```

A run that failed carries `ok: false` and `error` — the same `code` and `message` the failure document
below carries, and the exit code the run ends with — so `completed: "no"` always arrives
with its reason. `resolveSteps`, when present, says what to do with each answer `resolveWith` gives. A declined confirmation and a dry run that answered carry none.

`destination` is one shape on every command that writes: `{ instance, workspaceId, kind }`
for the workspace, and for an ephemeral or tenant (`tenant deploy`, `deploy --to tenant:<name>`)
`{ instance, workspaceId, kind, label, url }` — the instance and workspace it lives under,
`kind` its actual type (`"ephemeral"` or `"tenant"`, whichever way it was named), `label` its
bare name, and `url` its own base URL. `branch` is `null` wherever no branch applies — a tenant
deploy, and a release cut from an ephemeral. Beside it, `selector` spells that destination as `--to` takes
it (`"workspace"`, `"tenant:acme"`) and `workspaceId` repeats its workspace.

`release create` also carries `drift`: whether the source was compared against this
project's compile (`checked`), how many objects differ, are missing there, or exist only
there (`count`), and each of them named as `workspace diff` names it (`objects`, a source-only
one suffixed `(not in this project)`, one missing there `(not on the source)`) — or `checked: false` with the `reason` it could not run.

`completed` answers one question: does the outcome you asked for exist?

| `completed` | Exit | Meaning | What to do |
|---|---|---|---|
| `yes` | 0 | It exists. | Nothing. |
| `no` | non-zero; 0 when you declined the confirmation | It does not. If the run left something behind (a landed branch, a cut it could not delete), `residue` names it and the command that removes it. | Fix the cause and re-run. |
| `unknown` | **9** | The write was sent and the answer was lost: a timeout, a dropped connection, a 5xx, or Ctrl-C mid-write. | Run `resolveWith` before anything else. |

A run ended by a signal writes `interrupted: true`. With a write on the wire the outcome is `unknown`;
with none it is `cancelled` (exit 130 for Ctrl-C, 143 for SIGTERM, 129 for SIGHUP). Either way `landed`
says what this run had already landed, such as the deploy before its rename or static publish.

Never retry an `unknown` blind. The platform gives a taken release name a suffix rather
than refusing it, so a second `release create` after a lost response can leave two
releases. A read that says "absent" before `resolveNotBefore` is not proof either, because
the server may still be finishing the write. A step an earlier failure kept from running is
`skipped`. For `promote`, `verify` only checks the landing: a verification that could not
run leaves the landing `yes`.

A declined confirmation (typing `n`, or Ctrl-D) exits 0 and still answers `--json`. The
operation commands write their document with the step `no`; `tenant delete`, `ephemeral delete`,
`release delete` and `workspace branch delete` write `{ verb, destination, name, deleted: false,
alreadyGone: false, declined: true }` (a branch delete names `branch` instead of `name`).
`publish` writes its own document with `published: false, declined: true`, and `env set|unset`
write `{ verb, name, action: null, destination, declined: true }`; each carries `declined: false`
when it went ahead, so the shape is the same either way.

Every other command that fails under `--json` (`deploy` included) writes a failure document
instead, so stdout is never empty. Branch on `code`, not on the message:

```jsonc
{
  "ok": false,
  "error": {
    "code": "SDK_SEED_IN_STATIC",
    "message": "Refusing to publish: …",
    "exitCode": 1,
    "details": { "leaks": [{ "file": "assets/index-….js", "table": "user", "column": "password" }] }
  }
}
```

`details` is an object, never a bare list: each code's list sits under its own key, beside
`warnings` (`{ code, message }` each) when the run printed some.

| `code` | Means | Extra fields |
|---|---|---|
| `SDK_SEED_IN_STATIC` | `deploy --static` found seed values in the build (below). | `details.leaks`: `{ file, table, column }` per leak |
| `SDK_EXPORT_INVALID` | The workspace failed an export check, or `--strict` promoted a warning. | `details.diagnostics`: `{ severity, code, message }` per failed check; under `--strict`, every warning that fails it; `code` names the check, e.g. `seed.public-seed`; `details.warnings` beside it, empty when the run printed none |
| `SDK_CREDENTIAL_REJECTED` | The instance, or its sign-in server, refused the credential this run used: exit 1. The message names the sign-in that fixes it. | `details`: `{ profile, credentialType, instance, workspaceId, signIn }` (`profile` is `null` for an environment credential; `instance` and `workspaceId` are `null` for a refused `XANO_REFRESH_TOKEN`; `signIn` is `null` when the fix is a variable or an upgrade rather than a command) |
| `SDK_USAGE` | The command line was mistyped or incomplete — an unknown flag, a value on a flag that takes none, a flag without the one it needs (`--dry-run` without `--to`), a missing argument, a confirmation with no terminal to ask on, a local file or directory it names that does not exist: exit 1. | `suggestion`: the closest match, when one is close enough |
| `SDK_ERROR` | Any failure without a code of its own yet — including a NAMED thing that cannot be found (a backend, release, branch, static host, test, profile or Xano Engine version: exit 8). A network failure or a server error (5xx) is exit 8 before anything is written — the backend's lookup, a read-only command's read (`tables`, `test list`, `env pull`, `status`, `whoami`, `workspace details`, `workspace branch`'s list), a Xano Engine's release lookup or download, and `--keep-data`'s reads ahead of its merge (whether the environment can merge, its live read, the merge preview) got no answer or a 5xx; rerun as printed — and exit 1 at a later step that never reached it (an import that was not sent: nothing was written — retry). A `501` on `--keep-data`'s check is an answer, not an outage: that backend cannot merge, so it is exit 1 with the deploy that replaces instead. | `suggestion`: the near name a not-found one is one slip from, when there is one (`suggestions`: every one, when a command missed several) |

A piped stdout gets the document too, without `--json`, so a script reading the pipe never gets
an empty stdout. The exception is a command whose stdout is the data itself (`export` to stdout,
`llms`, `completion`, `--help`): a failure appended to it would corrupt it, so those write one
only under `--json`. A piped `release` or `promote` write prints its operation result (above)
either way.

`SDK_SEED_IN_STATIC` means `deploy --static` found seed values from a non-public column in the
build. If they are deliberately public (a demo login the frontend shows), declare the columns on
the table with `publicSeed: ["password"]`. Every deploy path then reads the same declaration.

#### Guarding what is live

`promote --set-live --expect-live v1` lands only if `v1` is the live branch when the
promote starts. It checks again immediately before switching live, and if live moved in
between, the new branch stays landed but is not served. The platform has no
compare-and-set, so the check narrows the race; it does not close it.
`workspace branch set-live <branch> --expect-live v1` takes the same guard, checked before
it asks and again before it switches. `deploy --set-live` does not take it.

A check that does not hold is a conflict: exit 2, `SDK_LIVE_BRANCH_MISMATCH`, and the branch
that is live under `details.conflictsWith.live` (`null` when no labelled branch is).

#### What a release carries

Every table's **schema**, always. That part is not selectable, so a release cut with no
extra flags is not a release "without tables" — it has all of them.

What it does not carry, unless you ask for it, is any table's **rows**:

```bash
xanosdk tables                              # id, guid, and name — of what this project deployed to
xanosdk tables ephemeral:e4f2-9ab1          # …or a named env (its name, not its display name)
xanosdk tables tenant:acme                  # …or a tenant
xanosdk tables workspace                    # …or your workspace
xanosdk release create v1 --seed            # every table's rows ride along
xanosdk release create v1 --seed=<guid>,<guid>   # only those two tables' rows
```

Rows are opt-in because a release is durable and can be landed on another environment; data
should not travel there by accident. When a selected table has a column the schema marks
non-public, the cut names it and asks before going ahead (`--yes` answers in advance).

Seeded **password** columns carry hashes, and a password hash is keyed to the environment that
made it — every workspace, ephemeral and tenant has its own key, and no release carries it. The
hashes land unchanged, so logins against those rows work only back on the environment the
release was cut from; anywhere else each one answers as a bad password. A landing that hits this
warns and names the columns (`passwordHashesUnverifiable` in `deploy --json` and `tenant deploy --json`). To log in
elsewhere, deploy the entry file (its seed sends plaintext, which the destination hashes) or
reset those passwords after landing. A standard tenant takes only a release, so there the
choices are a reset on the tenant, or a release cut without that table's rows.

A release carries no file **bytes**. A file column's value and an MCP icon declared with
`hostedFile()` both point into the source's file library, and a release cut from it copies the
pointer without the file — on the backend it lands on, the row's file would be empty and the
icon would answer 404. So `release create` refuses (`SDK_RELEASE_FILES_NOT_CARRIED`, exit 2) a
cut whose source serves `hostedFile()` icons, or whose `--seed` selects a table with a file
column while the source holds files. Land a project like that by deploying it directly, which
ships its files: `xanosdk deploy --to tenant:<name> --seed`.

List from **the source you are cutting from**, not from your workspace. A table this project
deployed carries the guid `xano.lock` pins for it wherever it landed, but one created anywhere
else — in the dashboard, by another project — has a guid its own backend assigned, so a guid read
off one backend is not proof of the same table on another. That is what `tables <backend>` is for.

#### Why guids, and the one thing to know about them

Selection is by **guid**. Not by id, and not by name, and both exclusions are about how the
wrong choice *fails* rather than about convenience.

An **id** is a small dense integer, so an id from the wrong backend almost always exists on
this one — and names a different table. The server does not refuse an identifier it does not
recognize; it ignores it and answers 200. So a stale id cuts a release that reports success
and carries the wrong rows into something you can promote to production. A stale **guid** is
simply absent from the source's listing, so the cut is refused before anything is written.

A **name** is the one identifier you can change, so a saved name selection silently
re-targets at whatever holds that name after a rename — the same failure by a different
route. Names are also unfiltered free text (they may contain a comma), so a comma-separated
list of them could not be read back reliably.

> **A guid survives a redeploy.** A deploy sends the guids `xano.lock` pins — derived from each
> table's name (`md5(dbo:<name>)`, 32 hex characters) — and the import keeps them, a full replace
> included: the table's **id** moves on every replace, its guid does not. So a guid you wrote down
> keeps matching after the next deploy, and is preserved **exactly** from there on: cut a release
> from that environment and promote it into a workspace branch and the guid is byte-identical at
> every hop, while the ids move.
>
> What changes one is a **rename** — the name is what the guid derives from. A 32-hex guid that
> no longer matches usually means the table was renamed or removed in code since it was noted;
> `xanosdk lock rename` carries the identity across a rename you meant. A guid in the engine's own
> shape (about 27 base64url characters) belongs to a table this project did not deploy, and does
> not travel between backends.

`release create` checks every guid against the source it is about to read, prints that
source's real tables if one does not match, and names the listing verb for that source.

### The alternative: merging a local build

`xanosdk deploy <entry> --to workspace` (or `--to tenant:<name>`) skips the release record and
merges the build on your disk straight into the destination. Reach for it when you want the
pre-flight the release path does not have — a plan preview, a prune scope, loss warnings —
or when you are deleting objects, which a release does not do.

What it leaves behind is the **landing record** in `xano.lock`: which identities this project
wrote to that destination, and the whole scope of a later `--prune` there (see below). Commit
the lock after it. What it does not leave is a release: no stored archive, nothing to land again
or on a second destination, nothing for a tenant to be pointed at, and no record of what the
build *was* beyond the commit you built it from. Prefer the release flow for anything you may
need to repeat.

The flags that describe the ephemeral a plain deploy refreshes — `--name`, `--expires-hours`,
`--reset`, `--keep-data`, `--test` (with `--kind`/`--concurrency`), `--no-dev-env`,
`--require-microservices`, `--open` — are refused beside `--to`, before sign-in. `--static`
publishes beside the merge, but not under `--dry-run`; `--skip-liveness` needs `--static` there.

| `deploy --to` flag | What it does to the destination |
|---|---|
| *(none)* | Adds new objects, updates existing ones. Nothing is deleted, no rows are written. |
| `--dry-run` | Prints the plan and exits without sending anything. |
| `--prune` | Also deletes objects **this project landed on this destination** and no longer defines — per the `landed` record in `xano.lock`, see below. |
| `--reset-data` | Empties every table the bundle carries. |
| `--seed` | Writes the bundle's table rows **by id**: a row the destination holds at a seed row's id is overwritten (a seed row with no `id` is numbered by position, 1, 2, …). The plan names each table's rows written and how many overwrite a live row, and the confirmation repeats the count. Combine with `--reset-data` to reset **and** re-seed. |
| `--replace` | The disposable-environment behavior: wipe the workspace — **including every branch** — and import in its place. See below. |
| `--branch <label>` | Land on a branch instead of the live one. See below. |
| `--set-live` | Promote that branch to live once the import succeeds. |
| `--backup-branch[=<label>]` | Snapshot the live branch's logic first. Switching back restores logic only — see below. |
| `--allow-shared-schema-changes` | Proceed even though table and microservice changes reach every branch. |
| `--allow-branch-deletion` | Proceed even though `--replace` permanently deletes the workspace's other branches. |

#### `--replace` clears by workspace, not by branch

The name suggests it replaces what you are deploying. It does not: the clear runs
against the whole **workspace**, so every branch in it is deleted — not hidden,
not detached — along with the vault secrets, services, marketplace installs,
request history and the **saved versions** that would otherwise be the way back.
Nothing restores them afterwards.

The live branch comes back, because the archive recreates it. Every other branch
does not, and that includes the `ide-before-*` and `v2-*` snapshots the platform
takes on your behalf — a real workspace was measured holding 1,841 of them.

So a replace is refused when the workspace has any non-live branch:

```
✗ Refusing to `--replace` workspace #33: it has 6 non-live branches — 1 yours,
  5 platform backups, and the clear deletes branches by WORKSPACE.
```

The plan lists them before anything is written (the first ten, plus a count), and
marks which were made by the platform, so the number that decides whether to go
ahead — how many are **yours** — is the first thing you read. Branches the engine
reports with no label are counted too: they cannot be named or exported, and a
replace deletes them like any other.

`--yes` does not cover this; it waives the confirmation, not the loss. To go
ahead, pass `--allow-branch-deletion`. To keep the work first, export each branch
on its own — a bare `xanosdk workspace export` reads the **live** branch, which is
the one a replace restores anyway:

```sh
xanosdk workspace export --branch branch2
```

Or drop `--replace`: the default merge leaves other branches untouched. Tenants
have no branches, so none of this applies to `--to tenant:<name>`.

Under `--json`, the same facts arrive as `branchDeletion` — an exact `total`, the
`authored` / `platformBackups` split, an `unlabeled` count for the rows that
cannot be named, and the `labels` that can — so a tool can show the scope before
it asks anyone to approve it. `unknown: true` means the inventory could not be
read, which is not the same as nothing to lose.

### Where a release lives

A release is always a record **in your workspace**, whatever it was cut from —
that is what `xanosdk release list`, `promote`, and `tenant deploy` all read.

Cutting from an environment is one call. The platform reads that environment's
live state and writes the record here — **nothing is written to the
environment**, so a disposable one expiring later takes nothing with it and a
sandbox you cut from is left exactly as it was.

Only a throwaway environment may be a source. `--from tenant:<name>` is accepted
for an ephemeral or a sandbox, and refused for a `standard` or `run` tenant: that
is a live deployment. `xanosdk tenant get <name>` names the last release landed
there, which lands anywhere as it is — but a `deploy --to` merge since may have
changed what the tenant runs. To start from what it runs now, `xanosdk pull` it,
deploy that to an ephemeral, and cut from there.

Cutting `--from workspace` packages a branch directly — whatever the workspace
currently serves, or the one `--branch <label>` names.

An instance that predates the one-call cut does not reject the request; it
ignores the source and cuts from your workspace instead. The CLI confirms every
sourced cut against the workspace audit log, and if the source was not honored it
deletes the release it just created and refuses, rather than leaving one whose
contents are not what its name claims.

### Moving a release to another workspace or instance

`xanosdk release transfer <name> --to-profile <profile>` copies a stored release into the
workspace a stored credential profile is bound to — another workspace, or another
instance. It moves the archive and nothing else: no compile, no branch, nothing lands.
Run `promote` on the destination afterwards, exactly as you would at the source.

```bash
xanosdk release transfer v1 --to-profile prod --dry-run   # is it already there?
xanosdk release transfer v1 --to-profile prod --yes       # copy it
xanosdk promote v1 --profile prod                         # land it there
```

`--to-profile` names a profile from `xanosdk profile list`; the run's own credential is the
source. A profile bound to the same instance and workspace is refused.

A transfer decides "already there" by content, never by name or size: the sha256 of the
archive's tar, which is the same on every host that stores it. So it is safe to re-run.

| The destination holds… | Result |
|---|---|
| a release with the same content | Reused — nothing imported, `completed: yes`, `reused: true`. |
| a **different** release under the name | Refused, exit `2`. Releases are never replaced; `conflictsWith` names the holder. |
| neither | Imported under the archive's own name, read back, and hashed again. |

`--dry-run` writes nothing and answers `present`: `identical`, `conflict` or `absent`.
Under `--json` the result is the shape above, with steps `read`, `search`, `import`, `verify`
(`read` is the source side, so a release that is not there fails as `read: no`, exit `8`);
`release` is the destination's copy, `source` is where it came from, and `sha256` is the
digest both sides agree on. A transfer never deletes: if what landed does not hash to what
was sent, it exits `2` and `residue` names the import and the `release delete` that
removes it.

### Pulling a backend into a project

`xanosdk pull <source>` refreshes `xano/` in a project that already has a frontend, a lockfile,
and a git history — where `xanosdk init --from <source>` writes a whole new project instead. It
takes the same source vocabulary everything else does: `release:<name>`, `ephemeral:<name>`,
`tenant:<name>`, `workspace`, or a bundle path.

```bash
xanosdk pull release:v1        # refresh xano/ from a release (keeps files you added)
xanosdk pull workspace         # …or from the live workspace
xanosdk pull release:v1 --yes    # skip the confirmation and the dirty-tree refusal (CI)
```

`pull` **replaces** and cannot merge: a file the previous decode wrote that this one does not
is deleted, and a decoded file is rewritten, hand edits included. A file no decode wrote (a def
you added, notes) is kept and named. It lists the deletions, asks, and refuses a dirty working
tree.

`xano.lock` is **reconciled**, not preserved — an entry survives only when the source carries an
object with the same key *and* the same identity, so a lock cannot pin a guid the new backend
never had. If none of the lock's identities appear in the source, that is what pointing a
project at an unrelated backend looks like, and the pull is refused unless you pass `--yes`.

### Which side changed: the sync baseline

When a workspace and this project differ, `workspace diff` also says **which side moved** since
they last matched. Every command that makes them match records a baseline in `xano.lock`, under
`synced`. A baseline is one content digest per object, kept per workspace and per branch. The
commands that record one are `deploy --to workspace`, a verified `promote`, `pull workspace`
and `init --from workspace`. Commit it with the rest of the lock.

```bash
xanosdk workspace diff ./xano/index.ts --json
```

```jsonc
{
  "matched": false,
  "differing": ["query:GET list (apiGroup orders)", "table:order"],
  "baseline": { "at": "2026-10-05T13:36:31.000Z", "by": "pull" },
  "changedThere": ["query:GET list (apiGroup orders)"], // edited in Xano since the baseline
  "changedHere": ["table:order"],                        // edited in this project since
  "changedBoth": [],                                     // edited on both sides: a conflict
  "unclassified": []                                     // differs, direction unknown
}
```

- `changedThere`: pull before you deploy, or the deploy overwrites that edit.
- `changedHere`: deploy it.
- `changedBoth`: reconcile by hand.
- `unclassified`: the baseline cannot tell. The object has no baseline entry, both sides
  already differed when it was taken, or it is the workspace's own settings row, which is
  never digested. A changed slug also shows only here, because digests leave slugs out.

Additions and deletions are classified as well. The baseline keeps this project's objects apart
from the rest of the branch, so an object the project never held (another source's, or a section
a pull does not write into `xano/`) is never reported as deleted here; it shows up only when it
changes in Xano. An object that is new in Xano counts as `changedThere` only when the baseline is
**complete**: a pull, an `init --from`, a verified
`promote` and a `--replace` record every object on the branch, and so does a merge deploy
that read the branch first. With no baseline for the branch, `baseline` is `null` and the
four lists are empty. A run that finds the branch exactly as recorded leaves the lock alone.

A few things to know about the baseline:

- It records what the branch holds after the sync, read back from the branch where the command
  can do so, so an object stored differently from how it compiles is not reported as changed in
  Xano. It is recorded whoever's objects landed (a `--bundle` from elsewhere, a release another
  project cut), because it describes the branch, not ownership.
- A baseline taken by a different SDK version under an older digest scheme is set aside
  (`baseline: null`) and replaced by the next sync, rather than read as every object changed.
- An SDK older than this feature drops `synced` when it rewrites `xano.lock`. Nothing breaks: the
  next sync records a new baseline.
- On a merge conflict in `xano.lock`, keep either side's baseline for a branch, or delete it.

### Deploying to a branch

`--branch <label>` stages on a Xano branch instead of the live one, which is the safer shape
when a workspace has no staging twin. `deploy --to workspace --branch <label>` creates the
branch as a clone of live, and refuses a label that already exists (exit 2,
`SDK_BRANCH_TAKEN`) — pick a new label for each deploy, or delete the old branch first. Nothing
serves the branch until you promote it.

`promote` lands a release on a branch and takes the same flag:

```bash
xanosdk promote v1 --branch staging          # land the release there, live untouched
xanosdk workspace branch list                # see what exists, and what is live
xanosdk workspace branch set-live staging    # promote when you are happy
```

A promote **always** lands on a branch, named or not: without `--branch` the label is derived
from the release and the moment (`v1-20260910T200511Z`), and the run prints it. There is no
unnamed landing — a branch the engine leaves unlabelled cannot be selected, promoted or
deleted afterwards, so the CLI names it rather than letting that happen.

`--set-live` does that last step in one go, the moment the import lands — with `--branch` to
stage first and cut over immediately, or on its own as the one-shot to production:

```bash
xanosdk promote v1 --set-live                # land on a derived branch and serve it
```

The merge path takes it too, when you want the preview a release cannot run:

```bash
xanosdk deploy ./xano/index.ts --to workspace --branch staging --dry-run   # preview against the branch
xanosdk deploy ./xano/index.ts --to workspace --branch staging             # land it, live untouched
```

There, `--backup-branch` snapshots live first, so the way back is `xanosdk workspace branch
set-live <backup-label>`. That restores **logic only**: tables are shared by every branch, so a
column or table the deploy dropped stays dropped, with its data, after the switch back. The
data-safe path is before landing: read `droppedColumns` in the `--dry-run` plan, and keep the
column in code until its data has moved.

**A branch stages LOGIC, not SCHEMA.** Api groups, queries, functions, and toolsets are
per-branch; **tables and microservices are shared across every branch in the workspace**. So
landing a table schema change changes it for live too, branch or not — the merge path refuses
that combination unless you pass `--allow-shared-schema-changes` (`SDK_SHARED_SCHEMA_CHANGE`, exit 2, as `promote`; under
`--dry-run` it is reported in the plan, and `sharedSchemaChanges` counts them), because "I staged
it on a branch" is exactly the belief that makes a dropped column surprising.

**A branch does not carry the workspace's own settings either.** The name, description,
preferences, request history, realtime settings and workspace-tier middleware live on the
workspace, one copy for every branch. `deploy --to workspace --branch` therefore leaves all of
them as the workspace has them — `workspace("…")` does not rename the workspace from a branch —
and names each one it held back (`workspaceSettingsNotApplied` under `--json`). They apply when
you deploy without `--branch`, onto the live branch; after `--set-live`, that is the branch you
staged. Env is the exception: a merge only ever creates a name the workspace lacks, and the staged
logic reads it. A `promote` lands a release the server holds, so it keeps the name and description
but applies the release's other workspace settings, and says so before it writes.

**Seeded ROWS are shared too, which gives reference data an order.** A table's rows are
workspace-wide for the same reason its schema is, so rows reach production the moment they
are applied — even while the logic that reads them is staged on a branch. No ordering makes
a half-data, half-logic change atomic; one order is simply less bad than the other:

```bash
xanosdk workspace reset-tables ./index.ts --table <guid>          # dry run, per-table counts
xanosdk workspace reset-tables ./index.ts --table <guid> --write  # then apply
xanosdk promote v2                                                # then the logic
```

Rows first, then logic: new rows under old logic break only a feature you are removing, while
new logic over old rows breaks the one you are shipping. `reset-tables` empties each named
table and re-inserts the rows your project compiles, restarting the key sequence so int ids
land where the seed declares them, and touches no other table. The two calls are not one
transaction — a failure between them leaves that table empty, which the command says plainly,
and the remedy is to run it again, because the rows come from your source.

**The merge refuses rather than guessing.** It will not proceed unless the server confirms
which branch it planned against. An instance whose build predates branch-targeted import
fails closed instead of quietly landing on live.

**An unchanged project is a no-op.** Before importing, the release compares the bundle it is
about to send against the workspace it is about to send it to, object by object. When every
object is already there, nothing is sent: the plan prints `no changes`, the JSON summary
reports `"upToDate": true` with `"operations": 0`, and no `updated_at` moves. A `--dry-run --json`
carries the same `upToDate`, and lists each matched object with action `unchanged`. That makes
`release` usable as a reconcile step — safe to run on a schedule, in CI on every merge, or
behind a "make production match main" button.

**One document for a dry run and a real run.** `deploy --to … --json` writes the same keys
either way, and `dryRun` says which it was:

| Key | Meaning |
| --- | --- |
| `dryRun` | `true` for `--dry-run`; nothing was written. |
| `landed` | an import ran. `false` with `upToDate: true` is a success. |
| `upToDate`, `operations` | already converged; how many operations were (or would be) sent. |
| `mode`, `prune`, `truncate` | `merge` or `replace`, and the flags that were in force. |
| `records` | rows were actually written — on a dry run, rows the real run would write. |
| `workspaceId`, `destination` | where it lands (`destination.kind` `workspace`, `tenant` or `ephemeral`; a tenant's carries `label`, `url` and `display`). |
| `plan`, `conflicts`, `canonicals`, `branch` | the plan it was confirmed against, identity conflicts, the public URLs served, the branch (`null` for a tenant). |
| `renamedTables`, `droppedColumns`, `retypedColumns`, `narrowedEnums`, `retargetedRefs`, `indexChanges`, `notNullKept`, `notNullTightened`, `storageChanges` | the table effects (see [What a landing does to tables](#what-a-landing-does-to-tables)); `tenant deploy` and `promote` carry the same keys, plus `droppedTables` (`{ table, rows }`), under `tableEffects`. |
| `unchangedEnv`, `droppedEnv`, `unappliedDocumentation`, `workspaceRename` | the rest of what the plan cannot say. |
| `workspaceSettingsNotApplied` | workspace settings a `--branch` landing held back (`[]` otherwise). |

Present only when they apply: `branchDeletion`, `unnamedPublicUrls`, `staticRemoved`, and on a
real run `setLive` and `sharedSchemaChanges` (with `--branch`), `backupBranch`, `liveRestored`
and `static`.

The comparison is deliberately one-sided: a false "changed" costs one import that was
happening anyway, while a false "unchanged" would silently skip a real release. So anything
it cannot prove equal counts as changed, and it is skipped entirely for `--replace` (which
rebuilds the workspace whatever it holds) and for `--seed`/`--reset-data` (which write table
rows, about which the comparison knows nothing). Under `--prune`, an object the workspace holds and the project
no longer defines is work to do, so that is not a no-op either.

On the merge path, anything destructive is **previewed first** — the CLI fetches the plan,
prints what would change, and asks (an ephemeral never does). `--yes` skips the prompt for CI but never skips the
preview. Start with `xanosdk deploy ./xano/index.ts --to workspace --dry-run` to see the plan
without committing to it. (`promote` runs no preview — the platform lands the release — which
is the trade the release flow makes and says so before writing.)

> ⚠️ `--prune` removes tables this project released and no longer defines, and a removed
> table takes its rows with it — no flag prevents that. The preview reports it explicitly;
> read it before confirming.

**`--prune` deletes only what this project landed on that destination.** A lock entry is
not enough: guids derive from names and every export writes an entry, so two projects that
both define a `double` function would each "own" the other's. Instead, `xano.lock` keeps a
`landed` record per destination — `<instance host>/workspace/<id>` for a workspace,
`<instance host>/tenant/<name>` for a tenant — naming each identity (lock key, guid, and
whether a `toolset` entry is an agent or an MCP server) this project actually wrote there. An
ephemeral's record (`<instance host>/ephemeral/<name>`) is kept in the uncommitted
`.xano/ephemeral.json` instead, never the lock: ephemerals are throwaway, so recording them
there churned the committed file on every new one. `ephemeral delete`, `tenant delete`, and an
expired or recreated ephemeral clear its record; `tenant delete` of a standard tenant removes
its entry from `xano.lock`. A planned deletion is this project's only when the record for *that* destination names
its key, its guid and its kind; anything else — a table built in the UI, another project's
agent of the same name, an object this project only ever exported — is refused, and nothing
is sent. That refusal is a conflict, not a usage mistake: it exits `2` with
`SDK_PRUNE_OUT_OF_SCOPE`, and `--yes` cannot waive it. The plan says of each object why it
would go — "this project no longer declares it" only when the record shows this project landed
it there and its lock entry came from this project's own source, "adopted by `lock import`, not
declared by this project" when the entry only ever came from `lock import` (the lock marks such
an entry `"adopted": true` until an export of this project declares it), "never declared it"
when neither the record nor the lock names it. Once declared, an adopted entry is marked
`"imported": true` instead: its guid is still the live object's, so an export never offers it
as an orphan's new name and `lock rename` refuses to replace it.

What writes the record, always after the write answered (never on a dry run or a decline):

| Command | Record for that destination |
|---|---|
| `deploy --to workspace\|tenant:<x>` (merge) | adds what it sent — a converged run too |
| `deploy --to … --replace` | becomes exactly what it sent |
| `deploy --to … --prune` | drops what it deleted |
| `deploy` to the project's ephemeral | becomes exactly what it sent (both arms leave only what was sent) |
| `promote <release>` | adds the release's objects — only when every identity it carries matches this lock |
| `tenant deploy`, `deploy release:<name>` | becomes the release's objects when they match this lock; cleared when they do not (said as a clear) |

A release deploy onto a branch counts for the whole workspace: a new branch starts as a copy of
live, objects keep their guids across branches, and tables are shared by all of them. Exports
never touch the record, so it never trips `--frozen-lock` or `export --check`. It is only as
good as it is committed: a deploy from CI records into CI's checkout, so commit the lock back
(or prune from where the record is), and a fresh clone of a lock without one prunes nothing.
The refusal says so, and names the destination key. The remedy is one landing without
`--prune`; an object removed from the project before its landing was ever recorded is deleted
by hand, or defined again, deployed, and then removed. A prune with no lock at all has no record
either, so it is the same refusal — `SDK_PRUNE_OUT_OF_SCOPE`, exit `2`, the refusal document
under `--json` — saying there is no lock; reaching that usually means `--no-lock` suppressed
it, and the remedy is the same one landing without `--prune` (and without `--no-lock`), then
committing the lock. A lock alone does not unlock a prune: `xanosdk export` writes one with no
landing record. Deploying a pre-exported `--bundle` carries no entry file to find a lock beside,
so name it with `--lock=<path>` — without one that is a usage error (exit `1`). None of
that applies to an ephemeral: its record is `.xano/ephemeral.json` in the project the run is in —
the directory you deploy from when it is a project (it has `.xano/` or its own `xano/` entry),
otherwise the entry's (`suites/alpha/.xano/` for `xanosdk deploy suites/alpha/xano/index.ts` typed
from a repository root holding no project) — written lock or not, so a prune there needs no lock,
and one refused there names that file and asks for a landing of that entry, with nothing to
commit. The credential in `.xano/auth.json` is read from the same project. Commands that default
to the tracked ephemeral read it from there too: run them from `suites/alpha`, or from a root
holding no project give them the entry (`--entry=suites/alpha/xano/index.ts`). From inside a
project, an entry another project owns (one below a directory with its own `xano/index.ts`,
`../beta/xano/index.ts` from `suites/alpha`) is refused (exit `1`) with the command to run it
from that project; a second entry of the same project, or a file no project owns, deploys, and a
refresh from another entry than the one that last landed asks first (`ephemeral.entry-changed`).

A merge that would turn an object into a different KIND under the same identity — an MCP
server onto someone's agent of the same name, which share a guid — is refused as a conflict
(exit 2), naming both kinds, rather than reported as an update.

**A dropped column is destructive, and does not need a flag to happen.** Removing a column
from a table schema and releasing destroys the column and every value in it. The server's
plan calls that a routine in-place update, so the release compares your schema against the
live workspace, names each column that would be dropped, and asks before doing it — on an
ordinary release, with no destructive flag passed. That comparison needs the target read: a
read that loses its connection or gets a server error is tried again a few times, and if it
still fails a real deploy is refused before anything is written (exit 8, with the command to
run again) — there is no flag to deploy without the check. `--dry-run` still prints the plan,
with a warning naming why the target could not be read.

**Environment variables are add-only on a release.** A merge creates keys that do not exist
yet and leaves existing ones as they are, so changing a value in code and releasing will not
change it on the workspace. The preview names any key it will decline to update. To change
one, set it on the workspace directly, or use `--replace` (which rebuilds the workspace).

A merge matches objects by the stable identity your project assigns them, so it only
recognizes a workspace it has deployed to before. A `--replace` keeps the identities the
project sends, so a workspace it rebuilt is one of those. Deploying into one built by hand
matches nothing: every object is a create, and with `--prune` the workspace is emptied and rebuilt rather than updated. The
preview says so in as many words when it happens. To adopt objects that are already there,
pin their `guid` on the matching defs first. Deploys are **authenticated over OAuth** — sign in once,
and the CLI refreshes tokens automatically. The target instance comes from your token
(never a stray flag), and the CLI prints what it's about to do before it touches anything.

**A name the workspace already uses for a different object refuses the release.** Before the
import runs, the CLI reads the live workspace and compares it to the archive by lock key. An
object this project would create under a name the workspace already holds with a *different*
identity is refused: the import would not update it, it would create a **second** object beside
it under a suffixed name and report success — with an auth table, that binds every endpoint to
one table while tokens are minted against the other. Three ways forward, all named in the
message: adopt the objects that are already there with `xanosdk lock import` and commit the lock,
rename yours, or release into a workspace that does not hold them. A workspace that could not be
read refuses too — a failed read is not evidence that there is no collision.

**A public URL slug is unique across the whole instance, not per workspace.** Two workspaces on
one instance cannot serve the same slug, and no flag makes them share one. A slug this project
does not pin is a preference, and the import settles it: an update keeps the slug the object
already had (`kept`), and a create whose slug is taken gets a random token instead (`minted`).
Every slug served under a value other than the one compiled is printed, lands in the JSON
summary, and **refuses `--static`** — a frontend built against the compiled value answers 404 on
every route derived from it. Only the frontend publish is refused; the backend release stands. A slug pinned in code is a contract rather than a preference: the
instance serves it or refuses the release — from the object's first release on, dry run
included, before the lock has recorded it.

**A conflict refuses and exits `2`, and `--yes` cannot waive it.** `--yes` waives the
confirmation, which is a question about whether you want a plan applied; a taken identity is not
a question. Exit `2` is distinct from an ordinary failure's `1` on purpose — a `1` is worth
retrying, and nothing about running a conflicting release again changes the answer. Nothing is
written, and nothing is written back to the lock. When the holder is this workspace, every
remedy is in your own project: pin the identity that is already there so the release updates it
(`guid: "<it>"` on the def — a def's explicit guid wins over the lock's entry, and the next build
re-pins the lock and says so; the message offers this first, because it takes over that one
object), rename the object, or adopt everything the workspace holds — `lock import` takes an
exported bundle, so the message names the export that writes one (`workspace export`, or
`ephemeral export <name> --format json` for an ephemeral) and then `lock import … --yes`: the
import overwrites the identity the lock pins, which is the adoption you chose. It adopts **every**
identity in that file, not only the one that conflicted: each becomes this project's, and once a
deploy or release records it as landed, a `--prune` from this project can delete it. Run
without `--yes`, `lock import` lists what it would overwrite and asks on a terminal; with no
terminal it refuses and names the flag. A standard tenant cannot be
exported, so there the remedies are the pin (the guid is in the message) or a rename. When the holder
is **another workspace on the instance, no remedy in this project applies** — the message names
that workspace by id and says the fix lives there. On `--to tenant:<name>` the refusal names the
tenant or ephemeral you chose (with its display name), never its internal workspace. A refusal
at apply time reports that the destination was not changed, and names any backup branch taken
moments earlier as redundant rather than as a rollback target.

Under `--json` every refusal — a taken identity, a kind swap, a prune out of scope, or one at
apply time — writes the failure document every command writes: `{ ok: false, error: { code,
message, exitCode, details } }`. `error.code` names the refusal — `SDK_IDENTITY_CONFLICT`,
`SDK_KIND_CONFLICT`, `SDK_PRUNE_OUT_OF_SCOPE`, or `SDK_IMPORT_REFUSED` for one at apply time
(`SDK_IDENTITY_CONFLICT` when the instance's reason was a taken identity) — and `error.exitCode`
is `2`, or `1` for an apply-time refusal that is not a conflict. `error.details` carries the
refusal itself: `refused` (`identityConflict`, `kindConflict`, `pruneOutOfScope` or
`importRefused`), `landed` (`false`), `conflicts`, `kindConflicts`, `outOfScope` (each object as
`{ type, name, label, reason? }`), `canonicals` and `landingRecord` (`null`) — each always
present on a `deploy --to` refusal, a list empty when it does not apply — plus the dry run's
`dryRun`, `declined`, `workspaceId`, `destination`, `mode`, `prune` and `branch` once the
destination was read, and `serverCode`, the instance's own code, on a refusal at apply time.
A `--keep-data` merge's refusal is smaller: `refused` (`identityConflict`, `renamePending`,
`pruneOutOfScope`, `storageModeChange`, `tableTrigger` or `uniqueViolation`), `conflicts`, `renames` and `outOfScope`, plus
`serverCode` when the environment refused — [above](#keeping-your-data-between-deploys).

**CI & agents** run headless with the meta credential — `XANO_INSTANCE_URL`, `XANO_WORKSPACE_ID`
and `XANO_META_TOKEN`, [above](#signing-in--deploying-in-depth) — no browser, nothing on disk,
nothing that rotates:

```bash
XANO_INSTANCE_URL=… XANO_WORKSPACE_ID=… XANO_META_TOKEN=… npx xanosdk deploy ./xano/index.ts
```

> ⚠️ A deploy without `--keep-data` is a full replace of the target environment, including
> its table records, before importing. The blast radius is your own disposable ephemeral — but anything
> you only ever created by hand in it (or any data it accumulated) is gone. That's exactly
> why a real workspace or tenant is reached only by naming it, with `deploy --to`.
