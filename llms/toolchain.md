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
