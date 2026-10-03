# Legacy paradigms and retired statements

> Read when the code was PULLED from an existing Xano instance — how a codegen'd tree reads, the shapes in it that must not be "fixed", and any `raw({ name: "mvp:…" })`, `realtimeTrigger()`, or name the catalogs do not list.

Older paradigms this SDK still supports and still emits when it decodes an existing
workspace. **Do not author these.** They are listed by name only so you recognize them
in pulled code rather than "fixing" them; each line names what to use instead.

Names overlap across the split deliberately — the engine reused words like
"realtime" and "channel" for both generations. A name matching is NOT evidence that
two things are the same object; check which list it came from.

- `c.expressionLegacy` — the older `const:expr` expression form, emitted by codegen for workspaces that still hold one — author `c.expression` instead.
- `realtimeTrigger()` — the SUPERSEDED realtime trigger, against the workspace-global realtime layer — a different object from the current `channel`, despite the similar name. For a join hook use `realtimeChannelTrigger({ actions: { join: true } })`; for message handling use a `realtimeMessage()` handler, which is the current equivalent of its `message` action (a message is an authored unit now, not a trigger action).
- `s.api.realtime_event` — publishes to the SUPERSEDED workspace-global realtime layer, NOT to a `realtimeChannel()` — its `channel` is a string against that layer, so pointing it at a current-layer channel path publishes into the void. Use `s.realtime.publish` instead: it names the owning `realtimeServer()`, so it addresses a real `realtimeChannel()`.

Retired statements and statement VERSIONS — no `s.` surface exists. Pulled code shows
them as `raw({ name: "…" })` and they keep running as stored, so leave them; author
the replacement only for NEW code. Never swap one for the other — the stored shapes differ.

- `mvp:crypto_jwe_decode` → `mvp:crypto_jwe_decode2`
- `mvp:crypto_jwe_encode` → `mvp:crypto_jwe_encode3`
- `mvp:crypto_jwe_encode2` → `mvp:crypto_jwe_encode3`
- `mvp:crypto_jws_decode` → `mvp:crypto_jws_decode2`
- `mvp:crypto_jws_encode` → `mvp:crypto_jws_encode2`
- `mvp:connect_ncscale_send_log` — retired, no replacement
- `mvp:dbo_get` → `mvp:dbo_getby`
- `mvp:guid` — retired, no replacement

Statements the engine writes but will NOT import back — no `s.` surface exists, and
unlike the retired versions above these must be FIXED, not left alone. Pulled code shows
them as `raw({ name: "…" })`; `export()` refuses any bundle that still contains one.

- `mvp:placeholder` — an unconfigured statement slot the engine writes in place of a statement it could not resolve, so an export stays well-formed. There is no statement class behind it: importing a workspace that contains one fails outright with "Missing statement: mvp:placeholder". Replace it with the statement it stands in for before deploying — there is no destination where it runs.

## Reading a pulled tree

`codegen` emits objects as FACTORY calls (`table({...})`, `query({...})`, …) — the form
you author by hand — so inference survives the round trip.
Three shapes read differently and must not be "fixed": a trigger its factory cannot
reproduce (its target outside the pulled tree, or `meta` it cannot write) stays
`{...} satisfies TriggerDef`; a
statement the catalog cannot model round-trips verbatim through `raw()`
(`@xano/sdk/codegen`); and an object ALREADY EMPTY upstream decodes to a def with
no `stack`, reported as `empty-source` — faithful, not a decode failure. Workspace env
var VALUES go to `xano/.env` (owner-only, gitignored); `xano/workspace.ts` declares each as `""`.

Markers for stored shapes the checks refuse — keep them, not for new code:
`uncheckedAs: true`, `lam.raw(body, { unchecked: true })`, `rawWhere([...])` from
`@xano/sdk/codegen` (view filter), `"key" as never` (a key the target dropped; remove once declared).
