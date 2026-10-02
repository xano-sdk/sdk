# Object kinds

Every object kind Xano SDK can author, and how to split a workspace across microservices.

## Object kinds

Every top-level Xano object is a registered kind with a factory and a `Xano.register*`
method: `defineFunction`, `table`, `query`, `apiGroup`, `tool`, `prompt`, `resource`,
`mcpServer`, `agent`,
`task`, `workflowTest`, `middleware`, `addon`, `realtimeServer`, `realtimeChannel`,
`realtimeMessage`, `knowledge`, `microservice` (its own section below), `workspaceConfig`,
and the seven trigger factories below. Signatures and payload keys are in
`llms/object-kinds.md` and `llms/triggers.md`; what follows is what
the types don't tell you.

**A knowledge item's body is a file, and `mode` is a running cost.** `knowledge()` is the
markdown a workspace's AI agents read before they act, and it is the one kind whose payload
is prose — so the body is named by path (`knowledgeFile("./runbook.md", import.meta.url)`)
rather than written as a string, and `refs: knowledgeDir(...)` ships a whole folder the
agent searches on demand — UTF-8 text files only (other content is refused), and a
symlink is not followed. What the agent actually receives is decided by `type` and `mode`,
and nothing in the types warns you: an `agents.md` item is injected in full on every turn
whatever `mode` says, `mode: "always"` spends the body's whole length on every request, and
the default `mode: "auto"` sends only the name and `description` until a request matches.
Write that `description` to be matched against a request rather than as a title. Full shape
in `llms/kinds-knowledge.md`.

**Triggers take a callback stack.** `stack: (t) => [...]` whenever the stack reads a trigger
input (a plain `stack: [...]`, as every other kind uses, is accepted when it reads none) —
because a trigger's inputs are **implied by its type** (fixed by Xano, not
editable) and injected automatically. So triggers take no `input` field, and the typed
handle `t` is the only way to read them (`response: (t) => ...` on response-bearing types).
The seven types are `tableTrigger`, `realtimeServerTrigger`, `realtimeChannelTrigger`,
`mcpServerTrigger`, `agentTrigger`, `workspaceTrigger`, and `errorTrigger`; they share one
stored envelope discriminated by `obj_type`.

```ts
tableTrigger({
  name: "on-user-insert",
  table: users,
  actions: { insert: true },
  // Optional row filter, evaluated by the DATABASE before the stack runs — so it
  // names the SQL pseudo-tables with col(), NOT the t handle. Rejected with
  // `truncate`; insert cannot read OLD.*, delete cannot read NEW.*.
  search: cmp(col("NEW.email"), "!=", c.text("")),
  stack: (t) => [
    // t.new("email") is typed to the row; t.action is the op; t.old is null (insert-only).
    s.db.add({ table: auditLog, row: { email: t.new("email"), event: t.action } }),
  ],
});
```

**A workflow test is an end-to-end test, and its `datasource` decides what it can see.**
`workflowTest` takes no `input` and no `response` — it calls other objects and asserts on
what they bind. Leave `datasource` off by default: `""` runs against an **empty**
datasource. Naming one makes the engine **clone** that datasource before every run, so
pointing a test at production-sized data is slow enough to fail the run outright. `"live"`
warns at compile time; every other name is your call. On an **ephemeral**, `"live"` holds
only the seed fixtures, so it is how you read `table({ seed })` rows — a small clone,
dropped after the run. ⚠ The value is **stored on the object**, not a per-run flag: clear
it before you promote, or the same test clones the real database.

Empty means empty: **no `table({ seed })` rows exist while the test runs** by default, so
every `db` read misses unless the test specifies `datasource: "live"` (for seed data in
ephemerals) or creates what it needs first — typically a `defineFunction` fixture the stack
calls before anything else. A test written against a seeded row fails with your own
precondition message, which reads as a wrong id rather than an empty database. A failing
`s.api.call` is the other surprise: it **binds the error envelope** (`{code, message}`) to
its `as` and carries on rather than raising, so a later assertion gets blamed for a call
that failed several statements earlier — assert on `ref("r.code")` when a call may fail.
`llms/tests.md` carries the rest, including what `s.api.call` can and cannot do about
authentication.

```ts
workflowTest({
  name: "signup_works",
  tags: ["smoke"],
  // datasource omitted on purpose — "" is an EMPTY datasource, not "no datasource".
  stack: [
    s.function.call({ fn: createUser, input: { email: "a@b.c" }, as: "created" }),
    s.expect.to_be_defined({ expr: ref("created") }),
    s.expect.to_equal({ expr: ref("created.status"), value: c.text("ok") }),
    // A regex assertion takes a PATTERN, so build it with `c.regex(...)`.
    s.expect.to_match({ expr: ref("created.id"), value: c.regex("^usr_[a-z0-9]+$") }),
  ],
});
```

**Saved unit tests are a different thing, and they hang off the object.** A `query`,
`defineFunction` or `middleware` takes a `tests` array — the tests the Xano editor shows.
Each is a named set of inputs run against *that* object, asserted with the top-level
`expect.*` helpers. (`s.expect.*` — see [Authoring reference](authoring.md) — builds a
*statement* for a workflow-test stack;
`expect.*` builds a record stored on a test. They are not interchangeable, and the types
enforce it.) Any statement in the stack can return a **mock** instead of doing its work,
keyed by test name — and only while that named test runs, so a mock changes nothing about
a normal request.

A unit test's `datasource` works exactly as a workflow test's, with the same default:
`""` is an **empty** datasource, so **no `table({ seed })` rows are visible while a unit
test runs** either. Every `db` read misses, and an assertion on the first row fails against
a deployment whose endpoint returns those rows over HTTP a second later. The same
ephemeral-only `datasource: "live"` rule applies here, including clearing it before
promoting. Otherwise, create what the test needs inside the run — a `defineFunction`
fixture the stack calls first — or `mock` the read.

```ts
query({
  name: "score",
  verb: "POST",
  input: { score: input.int({ required: true }) },
  tests: [
    {
      name: "adds one",
      input: { score: c.int(1) },
      // Subject first — argument order is the assertion.
      expect: [expect.to_equal(resp(), c.int(2))],
    },
  ],
  stack: [
    // Returns 2 while "adds one" runs; does nothing on a real request. A name
    // no test declares throws at compile time.
    s.set_var("total", c.expression("$input.score + 1"), {
      mock: { "adds one": c.int(2) },
    }),
  ],
  response: ref("total"),
});
```

A pull brings tests back, along with a query's saved request/response `example`. The one
thing it withholds is a test's auth `token` — that is an expiring credential rather than
authored configuration, so `xanosdk init --from` reports it as a deliberate omission instead of
writing it into a committed tree.

**Four of the `Run …` statements only run inside a workflow test.** `s.api.call`,
`s.task.call`, `s.trigger.call` and `s.workflow_test.call` are resolved by the engine at
run time, and outside a `workflowTest` stack it cannot reach the target — so one of them in
a query, function or task type-checks, exports, imports and **deploys clean**, then answers
the first real request
with `ERROR_FATAL: <Type> does not exist`. It is not per host kind: the same call fails
identically from a function that a query runs. `xanosdk export` refuses them outside a
workflow test. `s.function.call`, `s.tool.call`, `s.middleware.call` and `s.addon.call` run
from any stack, as does `s.function.run` — the ordinary way to invoke a function. To share
logic between two endpoints, put it in a `defineFunction` and `s.function.run` it from both.

**`s.expect.to_match` takes a regex PATTERN, not text.** The engine runs it through PHP
`preg_*`, which reads the first character as the delimiter — so a `c.text("^usr_.*$")` there
is a pattern the engine cannot run, and the assertion fails against the very string it was
written for. `c.regex("^usr_.*$")` (or `c.regex(/^usr_.*$/)`) wraps and escapes it; a bare
`c.text` pattern is refused at compile time and pointed here. A `ref`/`inp` pattern, whose
text isn't visible to the check, is passed through untouched.

**Realtime** — the only three-level containment chain in the SDK: `realtimeServer` owns
`realtimeChannel`s, which own `realtimeMessage` handlers (a message is the realtime
analogue of a query — its own typed payload and stack). Pass the **handle**, not a name: a
channel path is unique only within its server. A channel's `input` types its **path** params
(`rooms/{room_id}`); a message's `input` types the message **payload**. A server is off
until `enabled: true`.

```ts
const chat = realtimeServer({ name: "chat", enabled: true });

const room = realtimeChannel({
  name: "rooms/{room_id}",           // `input` types the PATH params
  server: chat,
  input: { room_id: input.int() },
  publish: { who: "authenticated" },
  conversation: { enabled: true, limit: 50 },   // client-visible transcript
});

realtimeMessage({
  name: "send",                      // `input` types the message PAYLOAD
  channel: room,                     // the handle carries the server too
  input: { body: input.text({ required: true }) },
  deliverTo: "channel",              // or "sender" (request/response) / "others"
  stack: [s.debug.log({ value: inp("body") })],
});
```

The client side is derived too, the same way `query().getPath()` works — `chat.getUrl(BASE)`
builds the socket URL (`wss://…/ws/<canonical>`, with a tenant base URL translated into the
socket's `/ws/<tenant>:<canonical>` form) and `room.getChannel({ room_id: 42 })` builds the
path a client joins. Both throw rather than guess. In a **browser bundle**, reach for the
generated manifest's `socketUrl`/`channelPath` instead — same addresses, same checks, without
importing the defs (see
[A type-safe frontend, for free](../README.md#a-type-safe-frontend-for-free)).

Five traps account for most realtime bugs. The full wire protocol — every server frame,
the presence roster shape, the at-least-once client contract — is in `llms/kinds-realtime.md`.

- **An empty return denies, and so does a crash.** `connect` and `join` are gates: return
  `{ allowed: c.bool(true) }` or any truthy value to admit. A stack that falls through, or a gating
  trigger with no `response`, refuses everyone — and a raise refuses too, because the gate is
  seeded with a deny it keeps when the stack throws. Both failure modes lock the door, so the
  risk to plan for is a self-inflicted lockout, not a breach: guard every drill inside a gate
  with `ref(path, { safe: true })`, since `db.get` binds `null` on a miss. `export()` warns on
  the missing `response`; nothing can warn about the raise. Gating is opt-in — a server with
  no `connect` trigger admits everyone.
- **Only `null` drops a message.** In a `deliver` trigger (per recipient) and in a message
  handler, `false`/`0`/`""` all deliver the message unchanged, and a crash broadcasts the
  sender's original unvalidated payload. Return `null` to suppress. So a redaction check
  written as a boolean sends the very message it was meant to hide. Per-viewer redaction
  also takes **two objects**: the `deliver` trigger *and* `delivery: { perRecipient: true }`
  on its channel. Either half alone delivers the payload unchanged to everyone, so a gate
  whose return semantics are perfect still ships unredacted if the flag is missing — and the
  flag costs a stack per recipient per message, so it is opt-in. `export()` warns on both
  halves.
- **`conversation: { enabled: true }` alone stores nothing.** `limit` defaults to `0`, and
  `0` means retain none. Always pass a `limit`. What a handler broadcasts *is* the stored
  row, so broadcast everything a future joiner needs to render it.
- **An idle socket is reaped after ~10 minutes.** A listen-only client (feed, dashboard,
  presence sidebar) must send `{ action: "ping" }` or any frame periodically, or it silently
  drops and reconnects forever.
- **`s.realtime.publish` is the push direction, and it is fail-soft.** It bypasses the
  channel's `publish.who` (authorization belongs in your stack), does not invoke the named
  message's handler, and swallows a missing or disabled server — a mis-targeted publish is
  silent. Pass the server handle and a filled-in path (`room.getChannel({ room_id: 42 })`),
  never the template — a constant channel still carrying `{param}` throws at author time, and
  a constant server or channel naming nothing this workspace registers warns at export.

**The superseded realtime layer.** Xano has had two realtime generations and they reuse the
same words. `realtimeTrigger(...)` and `s.api.realtime_event(...)` belong to the old
workspace-global layer; they are supported only so `codegen` can bring back a workspace that
holds them, and they are named in `llms/legacy.md` rather than in the authoring catalogs.
Aiming `s.api.realtime_event` at a current-layer channel publishes into the void — use
`s.realtime.publish({ server, channel, data })`, which names the owning server and so can
resolve the channel.

**MCP servers & agents** — both persist under the `toolset` payload key, so an `mcpServer`
and an `agent` **sharing a name collide**. A `tool({...})` is its own kind, referenced by
handle from either.

```ts
// Auth is PER-TOOL and works like a query's: name an auth table({ auth: true }).
mcpServer({ name: "books", tools: [{ tool: searchTool, auth: users }] });

const assistant = agent({
  name: "assistant",
  llm: { type: "xano-free", systemPrompt: "Be helpful.", prompt: "Answer the question." },
  // Pass the handles directly; the `{ tool, enabled?, auth? }` wrapper (above)
  // is only for per-tool auth or `enabled: false`.
  tools: [searchTool],
});

// Agents have NO public endpoint — invoke them in-stack from any host with a stack.
query({
  name: "ask", verb: "POST", apiGroup: api,
  input: { question: input.text({ required: true }) },
  stack: [s.ai.agent.run({ agent: assistant, args: obj({ question: inp("question") }), as: "answer" })],
  response: { text: ref("answer.result") },
});
```

- **The run result is an envelope, not the completion.** The model's text is at **`.result`**
  — `ref("answer")` is the whole metadata object (`finishReason`, `steps`, …). Both are
  typed, so `InferResponse` reflects either.
- **`llm` is a provider-discriminated union** — `anthropic` / `openai` / `google-genai` /
  `xano-free` (which needs no API key) — each with its provider's typed fields.
- **Structured output types the call site.** Author `output: { schema: { … } }` on the agent
  with the `input.*` catalog and `.result` is typed from it wherever the handle is passed —
  no second witness. The type-only `resultShape` is only for overriding that, or for an
  agent referenced by bare name.
- **String settings are Twig-templated at run time.** The `args` you pass to
  `s.ai.agent.run` become `{{ $args }}` (env vars are `{{ $env.NAME }}`), which is how an
  endpoint's inputs reach the prompt. Numeric and boolean fields are not templated. Build a
  dynamic arg with `obj({...})`, not `c.obj`.
- **`mcpServer().getUrl(HOST)`** derives the Streamable-HTTP endpoint from the def, the same
  contract as `query.getPath()`. Resolve once — handing the result back in as a `HOST` throws
  rather than append a second endpoint path. Agents expose only `getCanonical()`.

**MCP prompts and resources** are their own kinds (`registerPrompts` /
`registerResources`), exposed by listing them on an `mcpServer` — agents take tools only.
A tool, prompt or resource can also carry the metadata MCP clients show: a `title`,
`icons`, and on a tool, behavior `annotations` and an `output` schema.

```ts
const summarize = prompt({
  name: "summarize",
  input: { post_id: input.int({ required: true }) },
  stack: [s.db.get({ table: posts, fieldValue: inp("post_id"), as: "post" })],
  response: ref("post.title"), // a string is one user message
});

const post = resource({
  name: "post",
  uri: "posts://{post_id}", // each {variable} is exactly one input field
  mimeType: "application/json",
  input: { post_id: input.int({ required: true }) },
  stack: [s.db.get({ table: posts, fieldValue: inp("post_id"), as: "post" })],
  response: ref("post"),
});

mcpServer({ name: "posts", tools: [searchTool], prompts: [summarize], resources: [post] });
```

- **`s.mcp.elicit` re-runs the stack.** It asks the client's user mid-call; when they
  answer, the whole stack runs again from the top. Ask first, then act — `export()` warns
  when a write comes before an elicit. Clients older than MCP `2026-07-28` get
  `{ action: "cancel" }`, so handle it. `s.mcp.progress` reports progress to a client that
  asked for it.

**Background execution.** `s.function.run` and `s.ai.agent.run` take a `runtime` block
(`{ mode: "async-shared" }`, or `"async-dedicated"` with `cpu`/`memory`/`timeout`/`maxRetry`)
that moves the call off the request path. This is **not** a performance knob: Xano rewrites
an async call to a statement that dispatches and continues, so it does not return the
function's result — don't bind `as` expecting a value. Collect results later with
`s.await({ ids })`.

## Microservices

A microservice is a container workload deployed alongside the workspace and called from a
stack with `s.microservice.request`. Two mutually exclusive shapes chosen by `kind`: `builtin`
declares containers (image/ports/resources/env/command/args) plus optional `ingresses`, and
`helm` points at a chart and its `values`; passing both throws.

```ts
export const echo = microservice({
  name: "echo",
  deployment: {
    replicas: 2,
    containers: [{
      name: "echo",
      image: "ealen/echo-server:latest",
      ports: [{ servicePort: "8080", containerPort: "80" }],
      resources: { cpu: "50m", ram: "256Mi" },
    }],
  },
});
```

Call it by passing the def itself. `port` folds into the single `"name:port"` host string
the engine reads, and is optional — a microservice exposing exactly one `servicePort`
resolves to it, and one exposing several requires it. A port the microservice doesn't expose
is a type error where the def's ports are known, and a build-time throw otherwise:

```ts
s.microservice.request({ as: "res", host: echo, path: "/health" });
```

Only `host` and `path` are required. `method`, `params`, `headers`, `timeout`, and
`follow_location` default to the engine's own values (`GET`, `{}`, `[]`, `10`, `true`) and are
always written — this statement's schema requires them, so they can't be left off the wire;
you just don't have to type them.

`host` binds by name, not by guid, because that is how the engine resolves it — so renaming
a microservice fixes every call site at once. A plain `"name:port"` string is also accepted
and is the only way to reach an instance-level microservice, which isn't a workspace object;
nothing checks that spelling, so prefer the def wherever there is one.

A container takes time to come up, so `xanosdk deploy` waits for it: after the import it
reads each microservice and reports whether it is ready, still starting, or failed, then
lists them. Skip the wait with `--skip-liveness`. The same report is available any time from
`xanosdk status`, `xanosdk ephemeral get <name>`, and `xanosdk workspace details`.

Two outcomes, and only one of them is a warning:

- **The engine reports the microservice broken** (an image that won't pull, a container that
  won't start) — the deploy **exits 4**. Waiting longer cannot change that answer, and a URL
  and a ✓ printed over a dead workload is not a successful deploy. This is the default; there
  is no flag to turn it off.
- **It simply hasn't reported ready by the end of the wait** — a warning, exit `0`. The
  backend is live and a slow container usually follows moments later. Pass
  **`--require-microservices`** to make that exit 4 too, which is what CI wants: nobody is
  there to find out whether "should come up shortly" happened.

Exit 4 is the microservice sibling of exit 3 (a `--static` upload that failed while the
backend deploy stood): the import committed, and something it deployed is not serving. The
URL and the JSON summary still print either way — the exit code is what carries the
difference.

`tenantDeploy: "manual"` rows are reported but never waited on — nothing starts them for you.
Reach for it when the row should exist without a workload behind it; `examples/sandbox` uses
it so deploying the examples doesn't wait on containers.

Container names are free-form: they need not match the microservice's own name, and nothing
about addressing depends on them. A stack reaches the **microservice** name (plus a
`servicePort`), whichever containers sit behind it, so a multi-container workload names each
one for what it is.

**This surface is early and expected to change**, and every export of a workspace declaring a
microservice prints a notice saying so — the docs are read before writing, which is not where
you are when it matters. `configs` and `volumes` are typed and `@deprecated` but **not
deployable**: the engine rejects an import carrying either, so `export()` fails the build
rather than letting the deploy fatal minutes in, after provisioning has begun. Declare a value
the workload reads as a container `env` entry, and storage as a container `volumes` entry
(`emptyDir`, `persistent`, or `config`). Both fields stay typed so a pulled workspace holding
one still decodes.

Two fields carry secrets into the bundle — and into a pulled tree — verbatim:
`chart.values` and `registryAuth.dockerconfigjson`, because otherwise a pulled microservice
could not be redeployed.

**What "out of band" can and cannot mean here.** Reading `process.env` in a def is never it —
that resolves at EXPORT time, writing the literal into the bundle and into git with it:

```ts
// WRONG, for either field.
microservice({ name: "app", registryAuth: { dockerconfigjson: process.env.REGISTRY_JSON! } });
```

What the engine *does* resolve at deploy time is a **reference** to a workspace environment
variable (`workspaceConfig({ env })`). Two spellings, because a container env entry is a
structured slot and a chart value can sit at any path:

```ts
// A builtin container: name the variable, and the secret stays out of the bundle.
env: [{ name: "API_KEY", fromEnv: "STRIPE_SECRET" }]

// A helm chart: the same reference, for a value at any depth.
chart: { values: 'auth:\n  token: "${env.STRIPE_SECRET}"\n' }
```

Only the variable *name* travels in the bundle, rotating the workspace variable takes effect
on the next deploy with no edit here, and a reference the workspace does not define **fails
the deploy** rather than resolving blank. `value` and `fromEnv` are mutually exclusive on one
entry; setting both is a build error.

`registryAuth.dockerconfigjson` has **no** such form — it is not scanned for references — so
for that field there are two honest options, both about where the bytes live rather than about
hiding them:

1. **Leave `registryAuth` unset** — a public image, or a pull credential attached to the
   microservice outside this workspace. Nothing then carries a credential.
2. **Accept that the tree is secret-bearing** — keep `workspace.json` and any pulled tree out
   of git, or rotate the credential once it lands there.

Export prints a notice naming every microservice whose bundle bytes carry a literal (chart
values built entirely of `${env.NAME}` references carry nothing and are not reported), so
this can't happen quietly; `--strict` does **not** promote it, since shipping a
private-registry workload is a legitimate end state. When what you actually need is a secret
your *stack* reads, the mapped surface is `workspaceConfig({ env })` + `env("NAME")` — see
[Middleware, request history and env vars](authoring.md#middleware-request-history-and-env-vars).
