# Lambda bodies (JavaScript)

> Read when writing a JavaScript body, or weighing whether to reach for one at all — `lam.fn`, `fl.lambda`, `fl.reduce`, `s.lambda`; each surface binds a different set of identifiers.

**A lambda is an escape hatch, not a default.** Use one only when a native filter,
an `expr(...)`/`obj(...)` expression, or a statement can't do the work: each call crosses a
process boundary into a BOUNDED pool of lambda workers every lambda in the workspace shares.
The crossing is per CALL, not per element — an iterating filter sends the body ONCE and loops on the
other side, so one iterating filter over a list beats a lambda inside a stack loop.

The lambda statement (`s.lambda({ as, code, timeout? })`) and eight filters run a
JavaScript body. **Write the body as a FUNCTION, not a `c.text` string** (bindings are
typed parameters; a wrong name is a compile error). Inline, the surface is implied by where it sits:

```ts
fl.map(({ $this }) => $this * 2)                                   // map's bindings, typed from the position
fl.reduce({ initial_value: 0, code: ({ $result, $this }) => $result + $this })
s.lambda({ as: "total", code: ({ $var }) => $var.subtotal * 1.2 })  // ambient only — $this is a compile error
```

Destructure bindings by their exact names (`({ $this })`). Refused: `(b) => b.$this`,
renaming (`{ $this: x }`), nesting, defaults, rest.

⚠ An inline `code:` arrow receives BINDINGS ONLY. `capture` is an option of
`lam.fn`, not a field of `s.lambda` or a filter, so `capture:` beside `code:` is a type
error — move the body into `lam.fn(fn, { capture })` (below).

For a body built away from its call site:

- `lam.fn(({ $result, $this }) => $result + $this, { surface?, capture? })` — name a `surface` to check it here, or omit it and the call site checks it.
- `lam.raw("return 1", { surface })` — text, same validation.
- `lam.raw(code, { surface, unchecked: true })` — sends a body that does not parse or declares a top-level `import`/`export`; skips those syntax checks only, here and at the `s.lambda` / `fl.*` site.
- `lam.file("./lambdas/total.ts")` — a default-exported function in its own module (path relative to the caller), read as text at build time. NODE ONLY: `import { lam } from "@xano/sdk/node"` (isomorphic `lam` has no `file`). Only the default export's BODY is sent, so a value import, a second export or a top-level helper is refused — move helpers inside; `import type` / `import { type X }` are free. `@xano/sdk/lambda-globals` types the globals below program-wide: keep modules in `xano/lambdas/` (its scaffold tsconfig loads it) or `import type {} from` it under their own tsconfig.

Nothing from the enclosing scope crosses: the body is sent as TEXT, so a closed-over
`const rate` is undefined there (a wrong VALUE at HTTP 200, not an error). Put what the
body needs in `capture`; it arrives as the SECOND parameter, emitted as a `const` prelude:

```ts
lam.fn(({ $this }, { capturedRate }) => $this * capturedRate, { surface: "map", capture: { capturedRate: rate } })
```

⚠ A capture key must NOT share a module-scope binding's name (a `.ts` loader renames one;
refused at build time) — `capture: { capturedRate: rate }`, not `{ rate }`.

Capture JSON data only: a function, `NaN`, a sparse/typed array or class instance (`Date`, `Map`…)
is refused at build time, at any depth. Capture the plain form and rebuild in
the body (`d.getTime()` → `new Date(d)`).

A body is a FUNCTION BODY: it must `return` its value. Bindings by surface — an
identifier outside its surface's set is undefined at runtime, and the SDK refuses
it at build time whichever spelling you use:

- every surface: `$env` · `$input` · `$var` · `$auth` (+ the `console` / `crypto` globals)
- `fl.lambda`: + `$this`
- `fl.map` · `fl.filter` · `fl.some` · `fl.every` · `fl.find` · `fl.findIndex`: + `$this` · `$index` · `$parent`
- `fl.reduce`: + `$this` · `$index` · `$parent` · `$result`
- `s.lambda`: ambient only — no `$this`, no `$parent`, no `$result`.

`$result` is `reduce`'s ACCUMULATOR (there is no `$acc`). `$this` is the element in
an iterating filter and the piped value in `fl.lambda`; `$parent` is the whole array
and exists only on the iterating filters. A stack variable is reached as
`$var.name` — it is NOT also injected as a bare `$name`.

`$auth` with no authenticated caller (a public surface, or an authed one reached without a
token) is `{ id: 0, dbo: "" }`, not null. Test `$auth.id > 0`, not truthiness.

Hazards:

- ⚠ A body that THROWS or times out does not fail the request (nor reach `s.try_catch`): the
  engine returns its diagnostic TEXT as the value with HTTP 200 (`"[Line 1:Char 7] boom"`,
  `"Lambda timed out after 1 seconds"`; a thrown non-Error is `" Unknown error"` on the cloud).
  Validate before consuming it. To FAIL the request: wrap the body in `try { return { ok: true,
  v } } catch { return { ok: false } }`, then `s.precondition` `ref("r.ok", { safe: true })` = `true`.
- ⚠ An `s.lambda` whose body returns a STRING that parses as a JSON object or array binds
  the DECODED value, not the string (the statement's output is cast as `json`);
  scalar-looking strings (`"123"`, `"true"`) stay text, and `fl.map`/`fl.lambda` keep
  the string. A body that `JSON.stringify`s a payload to sign/hash/store gets an object
  back. To keep text, return it WRAPPED (`{ text }`) and read `.text`.
- ⚠ `timeout` is COOPERATIVE — observed only at an `await` — so it bounds WAITING (a slow
  `fetch`), not compute: a 1s `timeout` over a 3s busy-loop runs all 3s and returns
  normally. Bound a loop that could run away inside the body.
- ⚠ A top-level `import`/`export` is a syntax error — the body is a function body. Reach
  a dependency through the PRELOADED globals below. A dynamic `import("…")`/`require("…")`
  with a LITERAL specifier is not portable: an instance that bundles the body first
  returns the TEXT `Could not resolve "node:crypto"` with HTTP 200.
- Preloaded globals — no specifier, so these work everywhere:
  `_` · `aws4` · `axios` · `cryptojs` · `DateTime` · `ethers` · `fastXmlParser` ·
  `jose` · `luxon` · `mailparser` · `math` · `moment` · `nodemailer` · `socks` ·
  `uuid` · `utils`
  …plus `fetch`, `Buffer`, `TextEncoder`/`TextDecoder`, and the `crypto` above
  (`randomUUID`, `createHmac`, `createHash`, `subtle`). `Object.keys(globalThis)`
  inside a body lists whatever else a given instance carries.
- An INLINE body in `xano/` that uses one of these globals does not type-check until that
  file has `import type {} from "@xano/sdk/lambda-globals"` at the top (safe in the defs
  program — it is not the frontend); or move the body to a `lam.file` module under
  `xano/lambdas/`, whose scaffold tsconfig loads the types already.
- ⚠ `console` output goes to the request LOG, not stdout. The logging methods (`log` ·
  `error` · `warn` · `info` · `debug` · `trace`), plus `table` and `dir`, all route there;
  `group`/`count`/`time`/`assert` are undefined, and CALLING one throws (error text as the
  value, HTTP 200).

TypeScript annotations survive in the body, and top-level `await` works.

Inline and `lam.fn` bodies are stored WHITESPACE-MINIFIED on one line, so an error position
(`[Line 1:Char 59]`) always says Line 1. Use `lam.file` when you want the body readable or
line-accurate errors; its module text is stored as written.
