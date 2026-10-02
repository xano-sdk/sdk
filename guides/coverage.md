# Coverage & agent grounding

What Xano SDK covers against the engine catalog, what is deliberately out of scope, and the machine-readable grounding it ships for agents.

## Coverage & scope

Xano SDK emits only (the engine imports/executes). Fidelity is proven by deep-equal against
the real Xano engine golden fixtures, and a coverage report prints on every test run.

| Surface | Coverage |
|---|---|
| Object kinds | **27 / 33** — counted over the engine's catalog, where each trigger type is its own kind |
| Statements (via `s`) | **218 / 218 (100%)** — every engine statement surface has a factory |
| Filters (via `fl`) | **246 / 246 (100%)** — every filter's signature is known: 144 carry arguments, 102 take none |

The six engine kinds you cannot author here are `tablemap`, `run.job`, `run.service`, the
superseded `realtime_channel`, `branch` and `market_item`. Four of the six are the same
verdict: they are instance or account state rather than workspace source, so a bundle has no
section for them and a pull could not bring one back. `run.job`/`run.service` belong in that
group — a run is a named runnable registered against an ACCOUNT, carrying a user and a
signature, and a bundle carries only an install record for one. Nothing in this SDK targets
one either: `s.cloud.job` takes an `image` and a `command` directly, so a containerized job
is declared at the call site and needs no separate definition, and a long-running container
that belongs to a workspace is a `microservice()`. `llms.txt` names all six with their
reasons. `llms.txt` and `manifest.json` regenerate their counts from the SDK's own
catalogs; this table is hand-written, so a test asserts every figure in it against
`buildManifest()` (`@xano/sdk/internal`) — the numbers here and the numbers an agent
reads cannot disagree.

The statement catalog is generated from the engine's own schemas (`npm run codegen`): 153 of
the 218 surfaces are declarative and carry a typed field schema, and the remaining 65 —
control flow, the `db` family, the call family — are hand-authored. **Reachable ≠ byte-verified**: every surface is
authorable, but a structural special without a persisted golden yet emits a shape *modeled*
on the engine schema, to be deep-equal'd against fixtures as they are captured.

**Out of scope** — reimplementing the engine's XanoScript parser, executing objects at
runtime (Xano SDK only compiles), and generating engine-side numeric ids/timestamps.
(Object guids and canonicals *are* handled — deterministically derived or frozen via
`xano.lock`.)

**Deferred (by design)** — folder auto-discovery, and the `service` / `vault` / `branch`
payload sections. (Round-trip decompile is no longer deferred: that is
`xanosdk init --from`, in the [CLI guide](cli.md); nor is `workflow_test` — it is a
first-class kind, see `workflowTest` in [Object kinds](object-kinds.md).) `InferResponse`
auto-derivation covers the object-literal and single-`db`-variable cases (matching the engine's
static walk), and follows a CALL into the object it invokes (`s.function.call`/`.run`,
`s.tool.call`, `s.api.call` given a def handle bind the target's own `InferResponse`);
a response variable produced inside control flow or `set_var`, and addon/related-field
keys, resolve to `unknown` — declare `responseShape` for those.

## Agent grounding

Xano SDK ships two machine-readable descriptions of its whole authoring surface so an agent
can learn the SDK without reading source:

- **`llms.txt`** — the always-read router: the mental model, the deploy contract, control
  flow, the non-obvious rules in `## Gotchas`, and a `## Topic files` list naming each
  **`llms/*.md`** and when to open it. It does not document the CLI — `xanosdk <command>
  --help` and the `cli` array in `manifest.json` do, from the same registry that generates
  the shell completions. The written version is the [CLI guide](cli.md).
- **`llms/*.md`** — one file per surface (object def shapes, statements, values, fields,
  filters, lambda bodies, what a client pays to import a def, an index of exact error
  strings, and the legacy names a pulled workspace carries), read only when that surface
  is in play. **`llms-full.txt`** is all
  of them concatenated, for a reader that wants one file rather than two.
- **`manifest.json`** — the exhaustive reference tier, reached by targeted lookup (grep or
  `jq` one entry; never read it whole). Every object kind (factory, `Xano.register*` method,
  payload key), every statement surface (the `s.<path>` accessor, stored `mvp:` name, and a
  typed field schema for the 153 declarative statements), the value constructors, the tag
  catalog, the filter catalog, and every CLI command and flag — plus live coverage counts.

Both derive from the SDK's own sources of truth (so they can't drift), regenerate with
`npm run manifest`, and are available at runtime via `buildManifest()` / `renderLlmsTxt()`,
both exported from `@xano/sdk/internal`.
