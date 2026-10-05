# Toolchain modules

> Read when `package.json` has a `"xanosdk"` block or you run `xanosdk marketplace`.

**Toolchain modules** extend the CLI, not the workspace — nothing to register in
`xano/index.ts`. An installed one runs on `export` and `deploy` (after the compile,
before the upload) and is verified, never rewritten, under `--frozen-lock`. Config
lives in this project's `package.json` `"xanosdk"` block, keyed by package name.
⚠ `marketplace install <pkg>` is not just `npm install`: it asks the module its questions
and writes that block plus the `.gitattributes` lines it contributes. A module that
arrived any other way (a plain `npm install`, a merged PR) is configured by running that
same command on it; until then `export`/`deploy` report it unconfigured and it runs on
shipped defaults. `marketplace reinstall <pkg>` re-asks with the current settings as the
defaults and re-enables a disabled one; `marketplace remove <pkg>` drops block, lines and
dependency together — a plain `npm uninstall` leaves the block, and a package it names
that is no longer installed fails every `--frozen-lock` run.

**A module's section of `xano/routes.gen.ts`.** A module with a `routesManifest` hook (types:
`@xano/sdk/plugin`) writes a block between `// xanosdk:begin <pkg>` and `// xanosdk:end <pkg>`
after the core sections, on every write of the file (`routes --emit`, `xano:routes`, `pull`,
`generate`, `marketplace install|reinstall|remove`). Edits inside the block are overwritten.
Install also adds the module's non-SDK peers (e.g. `zod`) as direct dependencies.
The hook is synchronous and pure: given
the request inputs under the manifest's keys and its config, it returns `{ imports?, source }`,
imports as bare package names (`@xano/sdk*`, relative and `node:` are refused). A module that
fails to load or throws leaves its previous block as it was, with a warning naming it, and the
core sections still refresh; under `routes --emit --strict` it is fatal. `@xano-sdk/zod`
(`xanosdk marketplace install zod`) is one: it adds `ROUTE_SCHEMAS` and its siblings.
