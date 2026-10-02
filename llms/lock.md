# Lock file

> Read when a `xano.lock` exists or should — renaming/pruning/importing identities, seeding the lock programmatically, or asking which commands write it.

`xano.lock` pins each object's guid and each api-group/toolset canonical, so renames
stay renames (guids otherwise derive from `(type, name)`; a query's from `(api group,
verb, name)`). Committed. A composed entry is keyed by that identity —
`query:<group>|<verb>|<name>`, `channel:<server>|<path>`, `message:<server>|<path>|<name>`
— its guid's seed; a legacy `query:<name>` is migrated by the next locked export.

- `xanosdk lock rename <kind> <old> <new>` — `kind` is the SDK kind (`table`, `apiGroup`) or stored key (`dbo`).
  Run it when `export` names it after a rename in code (it prints the command); the next export emits the original guid under the new name.
  Reads the `index.ts` beside the lock (or `--entry`); refused while `<old>` is still exported. Composed names go in full; renaming a parent moves them.
- `xanosdk lock prune <entry-file> [keys…] --yes` — drops orphaned entries. Finding orphans
  RUNS the entry's module scope (env assertions included); `--identity-only --yes <key>…`
  prunes named keys (`table:users`) with no evaluation and no orphan check.
- `xanosdk lock import <live-bundle.json> [--yes]` — seed the lock from a `workspace export`
  to take over an existing workspace (a compiled bundle is refused).
- Every lock subcommand accepts `--lock=<path>`; from outside the lock's directory pass it.
- Merge conflict: keep both sides; two keys on one guid → `lock rename` onto the kept
  name, or `lock prune --identity-only --yes` the other.
- Programmatic use: call `seedLockOverrides(readLockFile(path))` BEFORE importing any def
  module — references bake guids at import time; `writeBundle` refuses an unseeded lock.

What writes the lock: `export`/`deploy`/`release`/`preflight` of an ENTRY FILE update it;
`compile`/`paths` only READ. `--no-lock` builds
without one (names derive guids, the instance invents public URLs, no `--prune`);
REFUSED over a parseable lock. A DEPLOY or a RELEASE writes back only `landed`: what
this project LANDED on each destination (ephemerals: `.xano/ephemeral.json`). `--prune` deletes only that — never a merely
exported name; no record there, no prune until one landing (commit it). A `deploy` (`--replace`
too) PRESERVES the archive's guids, so the lock still describes the rebuilt
workspace. CI: `--frozen-lock` fails (`SDK_DRIFT`) instead of changing the lock, and fails while the lock
carries an entry no exported object matches — a plain `export` only warns and writes that
entry down, after which nothing tells a rename from a deletion: resolve it with
`lock rename` or `lock prune`, or accept them with `--allow-lock-orphans` when they are the
not-yet-ported half of an adopted workspace.
`export --check` implies `--frozen-lock` and writes nothing — no bundle, no lock — so it
reads no `xano/.env` or `.secrets.json` and refuses the flags that supply them; this is
what `npm run xano:check` runs, so CI needs no secrets. With no lock at all, either flag
fails only when the source has identities to record (an empty workspace passes).
