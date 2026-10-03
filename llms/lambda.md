# Lambda bodies (JavaScript)

> Read when writing a JavaScript body, or weighing whether to reach for one at all — `lam.fn`, `fl.lambda`, `fl.reduce`, `s.lambda`; each surface binds a different set of identifiers.

**A lambda is an escape hatch, not a default.** The body runs outside the request's own
runtime, and a workspace has a BOUNDED pool of lambda workers every lambda in it shares
— so a call both crosses a process boundary and draws on a workspace-wide resource.
Reach for one only when the typed surface cannot express the work: if a native filter,
an `expr(...)`/`obj(...)` expression, or a plain statement can, use that. The crossing
is per CALL, not per element — an iterating filter sends the body ONCE and loops on the
other side, so one body over a whole list beats one called from inside a stack loop.

The lambda statement (`s.lambda({ as, code, timeout? })`) and eight filters run a
JavaScript body. **Write the body as a FUNCTION, not a `c.text` string** — the
bindings are its parameters, so the editor supplies them and a wrong name is a
compile error instead of a wrong value at runtime. Write it inline and the surface
is implied by where it sits; nothing names one:

```ts
fl.map(({ $this }) => $this * 2)                                   // map's bindings, typed from the position
fl.reduce({ initial_value: 0, code: ({ $result, $this }) => $result + $this })
s.lambda({ as: "total", code: ({ $var }) => $var.subtotal * 1.2 })  // ambient only — $this is a compile error
```

The parameters are a fiction — only the BODY is sent, and the engine injects the
bindings as free identifiers — so DESTRUCTURE them as named: `(b) => b.$this`,
`{ $this: x }`, nesting, a default or rest are undefined there (refused).

⚠ An inline `code:` arrow receives BINDINGS ONLY. `capture` is an option of
`lam.fn`, not a field of `s.lambda` or a filter, so `capture:` beside `code:` is a type
error — the fix is to relocate the body, not to drop the field: `lam.fn(fn, { capture })` (below).

For a body built away from its call site:

- `lam.fn(({ $result, $this }) => $result + $this, { surface?, capture? })` — name a `surface` to check it here, or omit it and the call site checks it.
- `lam.raw("return 1", { surface })` — text, same validation.
- `lam.raw(code, { surface, unchecked: true })` — sends a body that does not parse or declares a top-level `import`/`export` (a fixture pinning the engine's syntax-error answer, or a pulled body); skips those syntax checks only, here and at the `s.lambda` / `fl.*` site.
- `lam.file("./lambdas/total.ts")` — a default-exported function in its own module (path relative to the caller), read as text at build time. NODE ONLY: `import { lam } from "@xano/sdk/node"` (isomorphic `lam` has no `file`). Only the default export's BODY is sent, so a value import, a second export or a top-level helper is refused — move helpers inside; `import type` / `import { type X }` are free. `@xano/sdk/lambda-globals` types the globals below program-wide: keep modules in `xano/lambdas/` (its scaffold tsconfig loads it) or `import type {} from` it under their own tsconfig.

Nothing from the enclosing scope crosses: the body is sent as TEXT, so a closed-over
`const rate` is undefined there (a wrong VALUE at HTTP 200, not an error). Put what the
body needs in `capture`; it arrives as the SECOND parameter, emitted as a `const` prelude:

```ts
lam.fn(({ $this }, { capturedRate }) => $this * capturedRate, { surface: "map", capture: { capturedRate: rate } })
```

⚠ A capture key must NOT share its name with a module-scope binding: a `.ts` loader
renames one of two same-named bindings, so the body reads `rate2` while the prelude
declares `rate` (refused at build time). `capture: { capturedRate: rate }` is the safe form.

Capture JSON data only: a function, `NaN`, a sparse/typed array or class instance (`Date`, `Map`…)
is refused at build time, at any depth. Capture the plain form and rebuild in
the body (`d.getTime()` → `new Date(d)`). The captured type flows into the second parameter.

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

Four hazards and the dependency route, all live-verified:

- ⚠ A body that THROWS does not fail the request: the engine returns its diagnostic
  TEXT as the value with HTTP 200, so the failure reads as bad data. Validate before
  consuming a lambda result numerically, and prefer a `lam.*` body, which cannot fail
  this way for a binding reason.
- ⚠ `timeout` is COOPERATIVE — observed only at an `await` — so it bounds WAITING (a slow
  `fetch`), not compute: a 1s `timeout` over a 3s busy-loop runs all 3s and returns
  normally. Bound a loop that could run away inside the body.
- ⚠ A top-level `import`/`export` is a syntax error — the body is a function body. Reach
  a dependency through the PRELOADED globals below. A dynamic `import("…")`/`require("…")`
  with a LITERAL specifier is not portable: an instance that bundles the body first
  returns the TEXT `Could not resolve "node:crypto"` with HTTP 200.
- Preloaded globals, live-probed — no specifier, so these work everywhere:
  `_` · `aws4` · `axios` · `cryptojs` · `DateTime` · `ethers` · `fastXmlParser` ·
  `jose` · `luxon` · `mailparser` · `math` · `moment` · `nodemailer` · `socks` ·
  `uuid` · `utils`
  …plus `fetch`, `Buffer`, `TextEncoder`/`TextDecoder`, and the `crypto` above
  (`randomUUID`, `createHmac`, `createHash`, `subtle`). `Object.keys(globalThis)`
  inside a body lists whatever else a given instance carries.
- ⚠ `console` output goes to the request LOG, not stdout. `log` · `error` · `warn` ·
  `info` · `debug` · `trace` all route there; any other `console` method is undefined,
  and CALLING it throws (error text as the value, HTTP 200).

TypeScript annotations survive in the body, and top-level `await` works.
