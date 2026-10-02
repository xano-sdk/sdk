/**
 * `@xano/sdk/sveltekit`: a SvelteKit adapter whose output a Xano static host
 * publishes, and a local engine also renders on the server.
 *
 * It goes wherever the project configures SvelteKit. A project `npx sv create`
 * makes today has no `svelte.config.js`: the config is the object passed to
 * `sveltekit()` in `vite.config.ts` (so is a `xanosdk init` scaffold's):
 *
 * ```ts
 * // vite.config.ts
 * import { sveltekit } from "@sveltejs/kit/vite";
 * import adapter from "@xano/sdk/sveltekit";
 * export default defineConfig({ plugins: [sveltekit({ adapter: adapter() })] });
 * ```
 *
 * A project that keeps a `svelte.config.js` sets `kit.adapter` there instead:
 *
 * ```js
 * // svelte.config.js
 * import adapter from "@xano/sdk/sveltekit";
 * export default { kit: { adapter: adapter() } };
 * ```
 *
 * `vite build` then writes one directory (`build/` by default), which is what
 * `xanosdk deploy --static build` uploads:
 *
 * - the STATIC half at its root: the client assets (`_app/…`), every prerendered
 *   page, and a `404.html` fallback shell. Any static host serves these files,
 *   and answers a path it holds no file for with `404.html` (status 404): the
 *   shell boots the app, which renders a route it knows and `+error.svelte`
 *   for one it does not. A prerendered `/404` route is kept as `404.html` only
 *   when every page route is prerendered; otherwise the shell replaces it, so
 *   the routes left to the browser still boot.
 * - the SERVER half at `.xano-ssr/server.js`: SvelteKit's server and the app's
 *   routes in one script, which answers every request that is not a file. A
 *   local engine (`xanosdk deploy --local-engine --static build`) runs it, so a
 *   dynamic route arrives as HTML with its own `<title>` and meta tags.
 *
 * ## The server bundle is never public
 *
 * SvelteKit inlines every `$env/static/private` value into the server code at
 * build time, so `.xano-ssr/server.js` can hold secrets. It sits in a dot directory
 * for that reason: `xanosdk deploy` sends it only to a local engine, which keeps
 * it privately and answers `/.xano-ssr/…` with a 404, and a static host that is
 * sent it anyway (an older SDK, another uploader) never publishes a hidden file.
 *
 * ## The contract
 *
 * `.xano-ssr/server.js` is a classic script (no `import`/`export`) that assigns
 * `globalThis.__respond(request, clientAddress) -> Promise<Response>`, taking
 * and returning web `Request`/`Response` objects. The host that runs it
 * supplies, before loading it:
 *
 * - the web platform APIs a fetch handler expects (`fetch`, `URL`, `Headers`,
 *   `TextEncoder`, `crypto`, timers);
 * - `globalThis.__env`, which SvelteKit reads for `$env/dynamic/*`;
 * - optionally `globalThis.__import(specifier) -> Promise<module>`, which
 *   answers the dynamic imports the bundle cannot hold (see
 *   {@link UNBUNDLABLE_IMPORT}). Without one they reject, and SvelteKit falls
 *   back from both.
 *
 * The engine supplies all three. The engine sets `XANO_HOST` there: its own base URL, for
 * a `load` that calls the workspace's API. A rendered page also gets the same
 * `window.XANO_HOST` (and `--static-env`) globals the deploy writes into the
 * prerendered documents.
 *
 * Needs `esbuild` in the app (`npm i -D esbuild`); it bundles the server half.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SERVER_BUNDLE, SERVER_DIR } from "./deploy/server-bundle.js";

/** The directory the server half lives in, and its bundle, relative to the adapter's output. */
export { SERVER_BUNDLE, SERVER_DIR };

export interface XanoAdapterOptions {
  /** The output directory, relative to the project. Default `build`. */
  out?: string;
  /**
   * A fallback page for hosts that serve files only: SvelteKit's app shell,
   * which renders the requested route in the browser. Written as `404.html`
   * by default, which a multipage static host serves (with status 404) for a
   * path it holds no file for. `false` writes none. A local engine that runs
   * the server half never serves it: SvelteKit renders the route itself.
   */
  fallback?: string | false;
  /** The JavaScript version the server bundle is lowered to. Default `es2017`. */
  target?: string;
}

/**
 * The parts of SvelteKit's `Builder` this adapter calls. Declared here so the
 * SDK takes no dependency on `@sveltejs/kit`; SvelteKit 2 passes the real one.
 */
export interface SvelteKitBuilder {
  rimraf(dir: string): void;
  mkdirp(dir: string): void;
  writeClient(dest: string): string[];
  writePrerendered(dest: string): string[];
  writeServer(dest: string): string[];
  generateFallback(dest: string): Promise<void>;
  generateManifest(opts: { relativePath: string }): string;
  getBuildDirectory(name: string): string;
  prerendered: { paths: string[] };
  routes: { id: string; prerender: boolean | "auto"; page: { methods: string[] } }[];
  log: { minor(msg: string): void; warn(msg: string): void };
}

/** The shape SvelteKit expects from `kit.adapter`. */
export interface SvelteKitAdapter {
  name: string;
  adapt(builder: SvelteKitBuilder): Promise<void>;
}

const ADAPTER_NAME = "@xano/sdk/sveltekit";

/**
 * The entry the server bundle is built from. `server.init` runs once, on the
 * first request: a classic script cannot await at its top level.
 */
const ENTRY = `import { Server } from './server/index.js';
import { manifest } from './manifest.js';

const server = new Server(manifest);
let ready;

globalThis.__respond = async (request, clientAddress) => {
	ready = ready || server.init({ env: globalThis.__env || {} });
	await ready;
	return server.respond(request, { getClientAddress: () => clientAddress });
};
`;

/**
 * The `import(` calls the engine cannot run, found in SvelteKit's server
 * runtime. goja compiles no dynamic import, and SvelteKit calls it for two
 * optional Node modules (`node:async_hooks`, and `node:crypto` through a
 * variable), falling back when it fails. So exactly those two shapes (a
 * `node:` literal, a variable argument) go to the host's `globalThis.__import`
 * when it has one, and otherwise to a rejected promise. A relative `import('./nodes/0.js')` is left for esbuild to bundle,
 * and `import(${…})` is left alone: SvelteKit WRITES that into the page's
 * hydration script, which the browser must receive unchanged.
 */
export const UNBUNDLABLE_IMPORT = /\bimport\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(?=["']node:|(?!\$\{)[A-Za-z_$])/g;

/** Rewrite the dynamic imports {@link UNBUNDLABLE_IMPORT} matches. Exported for tests. */
export function rewriteDynamicImports(source: string): string {
  return source.replace(UNBUNDLABLE_IMPORT, HOST_IMPORT);
}

/** What an unbundlable `import(` becomes: the host's `__import`, or a rejection. */
const HOST_IMPORT =
  '(globalThis.__import || (function (s) { return Promise.reject(new Error("cannot import " + s)); }))(';

/** The SvelteKit adapter. See the module comment for what it writes. */
export default function adapter(options: XanoAdapterOptions = {}): SvelteKitAdapter {
  const out = options.out ?? "build";
  const fallback = options.fallback ?? "404.html";
  const target = options.target ?? "es2017";
  return {
    name: ADAPTER_NAME,
    async adapt(builder) {
      let esbuild: typeof import("esbuild");
      try {
        esbuild = await import("esbuild");
      } catch {
        throw new Error(
          `${ADAPTER_NAME} bundles the server half with esbuild, which this project does not have. ` +
            "Install it (`npm i -D esbuild`) and build again.",
        );
      }

      builder.rimraf(out);
      builder.writeClient(out);
      const prerendered = builder.writePrerendered(out);
      if (fallback !== false) {
        // A prerendered page at the fallback's path (a `/404` route) is the
        // better answer for an unknown path — until a page route is left to the
        // browser: then it is the only document a files-only host can give
        // that route, and it would show "not found" instead of booting the app.
        const browserRendered = builder.routes
          .filter((r) => r.prerender !== true && r.page.methods.length > 0)
          .map((r) => r.id);
        if (!prerendered.includes(fallback)) {
          await builder.generateFallback(`${out}/${fallback}`);
        } else if (browserRendered.length > 0) {
          // Removed first: replacing it is deliberate, and said below.
          builder.rimraf(`${out}/${fallback}`);
          await builder.generateFallback(`${out}/${fallback}`);
          builder.log.warn(
            `${ADAPTER_NAME}: wrote the app shell over the prerendered ${fallback}, so a host that serves files ` +
              `only boots the routes that are not prerendered (${browserRendered.join(", ")}). An unknown path ` +
              `still answers 404 there, and renders +error.svelte.`,
          );
        } else {
          builder.log.minor(`${ADAPTER_NAME}: every page route is prerendered, so the prerendered ${fallback} is kept.`);
        }
      }

      const tmp = builder.getBuildDirectory("xanosdk-sveltekit");
      builder.rimraf(tmp);
      builder.mkdirp(tmp);
      builder.writeServer(`${tmp}/server`);
      writeFileSync(
        `${tmp}/manifest.js`,
        `export const manifest = ${builder.generateManifest({ relativePath: "./server" })};\n`,
      );
      writeFileSync(`${tmp}/entry.js`, ENTRY);

      const result = await esbuild.build({
        plugins: [
          {
            name: "xanosdk-no-dynamic-import",
            setup(build) {
              build.onLoad({ filter: /\.js$/ }, (args) => ({
                contents: rewriteDynamicImports(readFileSync(args.path, "utf8")),
                loader: "js",
              }));
            },
          },
        ],
        // Absolute, and with the working directory named: esbuild's service
        // process keeps the one it started in, which a later build in the same
        // process (a second app, a test) does not share.
        entryPoints: [resolve(tmp, "entry.js")],
        absWorkingDir: process.cwd(),
        bundle: true,
        format: "iife",
        platform: "neutral",
        mainFields: ["module", "main"],
        conditions: ["worker", "browser", "import"],
        target,
        outfile: resolve(out, SERVER_BUNDLE),
        metafile: true,
        logLevel: "warning",
      });
      const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
      builder.log.minor(`server bundle: ${out}/${SERVER_BUNDLE} (${bytes} bytes, ${target})`);
    },
  };
}
