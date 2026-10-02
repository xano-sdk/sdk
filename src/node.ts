/**
 * `@xano/sdk/node` — the Node entry.
 *
 * Re-exports the entire browser-safe authoring surface (`@xano/sdk`) plus the
 * `node:fs`-backed helpers that don't belong in a frontend bundle: artifact/
 * bundle writers, lock-file read/write, and the programmatic CLI (`run`,
 * `parseArgs`, `loadDefault`). Build scripts, the `xanosdk` bin, and tooling
 * import from here; workspace defs consumed by a frontend import from
 * `@xano/sdk`.
 */
export * from "./index.js";

// `lam` with the filesystem form attached (`lam.file`). This deliberately
// SHADOWS the isomorphic `lam` re-exported above: a body read off disk cannot
// resolve in a frontend bundle, so `lam.file` exists only on this entry.
export { lam } from "./values/lambda-file.js";

// node:fs artifact + bundle writers
export { writeArtifact, writeBundle } from "./emit/write.js";
export type { WriteBundleOptions } from "./emit/write.js";

// node:fs lock-file I/O
export { readLockFile, writeLockFile } from "./lock/io.js";

// Programmatic CLI surface
export { run, parseArgs, loadDefault, exportBundleJson } from "./emit/cli.js";
