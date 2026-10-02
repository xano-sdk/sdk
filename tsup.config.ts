import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    codegen: "src/codegen-entry.ts",
    scaffold: "src/scaffold-entry.ts",
    internal: "src/internal.ts",
    bundle: "src/bundle.ts",
    plugin: "src/plugin.ts",
    sveltekit: "src/sveltekit.ts",
    // Not a public entry (no `exports` row): it pins the did-you-mean helper
    // into its own chunk. Shared code lands in a chunk per set of entries that
    // reach it, and this helper's set is the statement catalog's, whose chunk
    // registers statements at load — so `fl`, which needs only the helper, would
    // pull the whole catalog into a browser bundle.
    "near-key": "src/util/near-key.ts",
    cli: "src/emit/cli.ts",
    bin: "src/emit/bin.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  // `tsx` is an optional runtime dependency the CLI loads on demand to read a
  // `.ts` workspace entry. It must stay an external `import("tsx/esm/api")`
  // resolved from the consumer's install — bundling its loader produces a copy
  // that can't register Node's module hooks, so the `.ts` fallback would break.
  //
  // `esbuild` is the SvelteKit adapter's optional peer: it runs in the app that
  // builds, from that app's own install, and is never shipped inside the SDK.
  external: ["tsx", "tsx/esm/api", "esbuild"],
});
