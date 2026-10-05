/**
 * The server half of a static build: a directory a server-rendering build
 * carries beside its static files (`@xano/sdk/sveltekit` writes it), which a
 * Xano Engine runs and every other host leaves out.
 *
 * It is a DOT directory on purpose. The server bundle can hold the app's
 * private build-time env (SvelteKit inlines `$env/static/private` into it), and
 * a Xano static-host build never publishes a hidden file, so a host that
 * serves files only drops it even when it is uploaded.
 *
 * Not `.xano/`: that is the CLI's own state directory, which every scaffolded
 * project's `.gitignore` ignores at any depth, so a committed build would lose
 * its server bundle without a word.
 */

/** The directory, relative to the build's root. */
export const SERVER_DIR = ".xano-ssr";
/** The server bundle, relative to the build's root. */
export const SERVER_BUNDLE = `${SERVER_DIR}/server.js`;
/**
 * The public config a deploy injects into the static half's documents
 * (`window.<KEY>` globals), uploaded beside the bundle so a Xano Engine gives a
 * rendered page the same globals. Written by the deploy, never by the adapter.
 */
export const SERVER_ENV = `${SERVER_DIR}/env.json`;

/** Whether a POSIX-relative build path is inside the server half. */
export function isServerPath(path: string): boolean {
  return path === SERVER_DIR || path.startsWith(`${SERVER_DIR}/`);
}
