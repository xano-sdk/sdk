# Reading a compiled bundle

`@xano/sdk` writes a bundle; `@xano/sdk/bundle` reads one back. It is the surface for
tools that take compiled JSON as input — a graph view, a diff, a linter, a docs generator —
so none of them has to reverse-engineer the storage shape and then go quietly wrong when the
engine grows a new one.

A bundle is what `export` writes:

```bash
npx xanosdk export ./xano/index.ts --out workspace.json
```

```ts
import { readFile } from "node:fs/promises";
import { statementCatalog, walk } from "@xano/sdk/bundle";

const bundle = JSON.parse(await readFile("bundle.json", "utf8"));
const catalog = statementCatalog();

for (const { raw, path, depth } of walk(bundle.payload.query[0].run)) {
  console.log(`${"  ".repeat(depth)}${path}  ${catalog.get(raw.name)?.sPath ?? raw.name}`);
}
// 0       db.query
// 1       conditional
// 1.if.0  db.add
```

- **`walk(run)`** → every statement in the tree, each with a `path` and a `depth`. The path
  format (`2.if.0`) is the shared address: a lint finding, a review comment and a runtime
  error written by three different tools all name the same node.
- **`subStacks(raw)`** → the nested stacks a statement carries, keyed by where they are
  stored and labelled by what they mean — a try/catch and a conditional share the same three
  storage keys. Found by shape, so a nesting form added later is still walked.
- **`statementCatalog()`** → the stored `mvp:*` name to its authoring path, minus the
  namespace (`mvp:dbo_view` → `db.query`, the `sPath` you write after `s.`) — which is
  the point: the stored name is often not the one you'd guess.
- **`structuralHash(raw)`** → a diff key for a statement and everything under it, with
  engine-filled operands excluded — so adding a column to a table leaves `db.edit` /
  `db.add_or_edit` unchanged. A `db.add` writes every column, so its hash does change.
- **`tableRefOf(column)` / `linkedTableOf(column)`** → the table a column points at.
- **`normalize(value)`** → the normalizer `xanosdk preflight` compares with, for diffing a
  stored workspace against a compiled one.

Everything on the entry is pure — no filesystem, network, or Node built-ins — so it runs anywhere.
