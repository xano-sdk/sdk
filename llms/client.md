# Consuming defs from a client

> Read when a frontend calls the deployed backend or imports a def — request types and zod schemas without the import, its cost, `window.XANO_HOST`, local dev, file URLs, a Node spot-check.

Importing a def into a browser bundle or a Node script — for `getPath()`, `getUrl()`, `verb`, or `InferResponse` — runs its factory calls; these are the costs and the checks.

- **Client bundle size / tree-shaking.** `@xano/sdk` is `sideEffects: false` and pulls
  no Node built-ins, so a bundler drops unused SDK exports. But importing a **def** for its
  `getPath()`/`verb`/`getUrl()`/`getChannel()` also pulls whatever its `stack` references:
  the `s.*`/`c.*` factory CALLS run at module load to BUILD it. Types are free.
  The first def costs **~267 kB minified (~65 kB gzipped)**; the floor is the RUNTIME, not the def:
  each further def adds ~2 kB, so splitting or trimming defs does not help.
  Fix: `npx @xano/sdk routes <entry> --emit xano/routes.gen.ts` (`paths` is an accepted alias) — verbs, paths, and sockets as
  plain data importing NOTHING, still compile-checked: `routePath("GET blog/{slug}", { slug })`, `routeQuery("GET search", input)` (the GET query string, path params dropped),
  `channelPath("rooms/{room_id}", { room_id })`, `socketUrl("chat", baseUrl)` (tenant base
  URLs lifted to `wss://h/ws/<tenant>:<canonical>`), `mcpUrl("notes_mcp", baseUrl)` (an MCP
  server's address to show a user or hand a client; browser JS cannot call it). A rename is a type error, not a 404.
- **Request types without the def.** `routes.gen.ts` also exports types-only `RouteInputs`,
  `ChannelInputs`, `MessageInputs` (and `MessageName`), keyed like `ROUTES`, `CHANNELS`, and
  `"<channel key> <message name>"`: `type NewListing = RouteInputs["POST listings"]`. A
  frontend types bodies, channel params and payloads from these, not `InferInput` on a def;
  keep `InferInput` in code that already imports defs. They match `InferInput`, except a
  `dbLink` input is the linked table's columns, and an `input.file()` a `Blob`
  (multipart). Responses
  are not in the file: `InferResponse` on an `import type` of the def.
  Runtime validation: `npx @xano/sdk marketplace install zod` adds `@xano-sdk/zod`, which writes
  `ROUTE_SCHEMAS`/`CHANNEL_SCHEMAS`/`MESSAGE_SCHEMAS` into the file under the same keys, each
  checked against its type at typecheck; the file then imports `zod`, never `@xano/sdk`.
- **Verifying a def outside a bundler.** Inside a bundler (Vite/webpack), import the def and read
  `getPath()`/`verb` directly. From Node, run a REAL file with `tsx <file.ts>` **from inside the project root**.
  Not `tsx -e "import …"` (mis-resolves the package `exports` map → ERR_PACKAGE_PATH_NOT_EXPORTED),
  not bare `node file.ts` (cannot resolve the `.js`-specifier intra-workspace imports), and not from
  outside the project root (the `@xano/sdk` specifier does not resolve).

**Reading the injected backend URL.**

- `npx @xano/sdk deploy <entry> --static <dir>` writes the deployed env's URL into every html
  document. A prerendered build serves a different one per route; a route without the global
  renders fine while every call goes to the wrong origin.
- Read it at runtime with a build-time fallback:
  const HOST = (typeof window !== 'undefined' && window.XANO_HOST) || import.meta.env.VITE_XANO_HOST;
- The scaffold's `lib/api.ts` types it (`interface Window { XANO_HOST?: string }` — `undefined` in dev)
  and exports this as a `string`, `XANO_HOST`; outside a scaffold declare the global yourself.
- In LOCAL DEV there is no injected global, so the fallback answers: set `VITE_XANO_HOST` in a
  `.env.local` beside `.env.example` at the PROJECT ROOT. The scaffold's vite config sets `envDir`
  there (its `root` is `frontend/`, and Vite resolves `.env` files against `root`); without it the
  var reads as undefined, the host falls back to '', and every call 404s off the dev server.
- It is injected in bracket form — `window["XANO_HOST"]="…"` — so grepping a deploy for
  `window.XANO_HOST` matches nothing. Grep the bare `XANO_HOST` token.

**Frontend without the backend.** `npx @xano/sdk publish <dir> [--to <backend>]` uploads an
already-built directory and nothing else — no compile, no import (scaffold script
`npm run xano:deploy:frontend`). A Xano Engine (`--to local`, or bare after a local
deploy) serves it, server half included, at `http://<prefix>.localhost:<port>`.
The injected `XANO_HOST` is the DESTINATION's URL, so one build published to two
destinations serves two different documents. `--release <name>` checks only that the
release exists; `--branch <label>` (workspace only) refuses unless that label is LIVE —
a label match, not a content comparison. `--json` reports `published` and `verified` separately.

**Server-rendered SvelteKit.** `adapter()` from `@xano/sdk/sveltekit` (needs `esbuild`) writes
the static half at the build's root plus a server half in `.xano-ssr/`. A Xano Engine renders every
path that is not a file through it (`load` reads the engine's own URL as `XANO_HOST` from
`$env/dynamic/private`; a rendered page gets the deploy's `window.XANO_HOST` too). Any other host
is not sent `.xano-ssr/`: it serves the static half and answers other paths with the `404.html`
shell, where a route with a server `load` fails (no `__data.json`). A scaffolded project configures
SvelteKit in `vite.config.ts`'s `sveltekit({ adapter })`, where `svelte.config.js` is ignored.
⚠ `.xano-ssr/server.js` inlines `$env/static/private` values; it is never served (`/.xano-ssr/` answers 404).

**Displaying a stored file.** A file column comes back as `{ path, name, type, size, mime,
meta, access, url }` — `mime` is the exact media type (`image/png`), `type` only the coarse
kind (`image`). Do not use its `url`: on a tenant-scoped environment it addresses the
instance host without the `/tenant/<name>` segment and 404s (a broken `<img>`; API
assertions still pass). Build the URL from `path`: `fileUrl(row.avatar, HOST)` returns `null`
for an absent file and is correct on an ephemeral and an instance workspace alike.

**Consuming a streaming response.** A `responseType: "stream"` query emits Server-Sent Events —
`Content-Type: text/event-stream`, one `data: <json>` frame per `s.api.stream({ value })` call,
each with an `id:` line that is a millisecond timestamp (ids REPEAT within a ms, so do not rely on
`Last-Event-ID` for exactly-once resume). The query's own `response` is not sent. Read it with
`EventSource`:
  const es = new EventSource(`${HOST}/api:<canonical>/stream/basic`);
  es.onmessage = (e) => { const chunk = JSON.parse(e.data); /* … */ };
  es.onerror = () => es.close();  // EventSource is GET-only and reconnects on its own
For POST or auth headers, a `fetch` + `response.body.getReader()` loop instead, splitting the text
on the blank-line (`\n\n`) frame delimiter and stripping the `data: ` prefix. There is no typed
client helper for the stream body, and `InferResponse` does not describe it.
**Error responses.** A failed request answers a JSON envelope `{ code, message, payload }`:
`if (!res.ok) { const { code, message, payload } = await res.json(); … }`. `code` is an
`ERROR_CODE_*` string (`ERROR_FATAL` for an engine error), `message` the human text (⚠ EMPTY
on a `db` NotFound), `payload` a precondition's structured detail (`""`/absent otherwise).
The `error_type` → HTTP status and `code` mapping is in `llms/fields.md`.
