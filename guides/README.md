# Xano SDK guides

The written reference for people. Every kind, statement, filter, and field type is also
typed, so your editor's autocomplete is usually the faster lookup — tab-complete `s.`,
`f.`, `c.`, `fl.`, `input.`.

| Guide | What's in it |
|---|---|
| [The scaffolded project](scaffold.md) | What `xanosdk init` writes, the two frontend presets, no frontend, existing apps, add-ons, SvelteKit rules |
| [Project structure](project-structure.md) | How a `xano/` project is laid out, and why registration is explicit |
| [The marketplace](marketplace.md) | Finding add-ons, the two kinds of module, and the install/reinstall/remove lifecycle |
| [The module contract](module-contract.md) | Building an add-on: the manifest fields, the plugin types, every hook, and what is refused |
| [Object kinds](object-kinds.md) | Every authorable kind, and splitting a workspace across microservices |
| [Authoring reference](authoring.md) | Tables and fields, statements, values, inputs, middleware, request history |
| [CLI](cli.md) | Every command, the agent skill, shell completion, and what failures look like |
| [Warning and error codes](codes.md) | Every code the CLI and the build emit, with what it means (generated) |
| [Signing in & deploying](deploying.md) | Auth, ephemerals, `--static`, releasing to production, `xanosdk preflight` |
| [Environment & identity](environment.md) | Every environment variable, and how `xano.lock` pins identity |
| [The typed frontend surface](typed-frontend.md) | Path resolution, input/response inference, bundle cost, the route manifest |
| [Pulling an existing workspace](codegen.md) | What `xanosdk init --from` writes, how faithful it is, and how to read its report |
| [Reading a compiled bundle](bundle.md) | `@xano/sdk/bundle`: walking, hashing and diffing compiled JSON from your own tools |
| [Coverage & agent grounding](coverage.md) | What's covered, what's out of scope, and the files agents read |

## The agent-facing surface

These guides are for humans. Agents read a different set, generated from the SDK's own
sources so it cannot drift from what the code does:

- **`llms.txt`** — a small always-read router: the mental model, the deploy contract, and
  every cross-cutting gotcha, ending in a map of the topic files.
- **`llms/*.md`** — one file per surface, opened only when that surface is in play.
- **`manifest.json`** — the exhaustive per-entry catalog, reached by targeted lookup.

See [Coverage & agent grounding](coverage.md) for what each one carries.
