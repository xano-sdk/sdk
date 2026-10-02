/**
 * Node-side liveness check for a static-host deploy: poll the deployed URL until
 * the static server reports it is serving *this* build, i.e. its
 * `X-Xano-Canonical` response header equals the canonical returned by the build
 * call. Answers "is the build I just pushed the one live right now" rather than
 * the weaker "the build endpoint accepted my upload" — a first-ever deploy
 * provisions a cold pod that 503s for tens of seconds, and a redeploy can route
 * the previous build for a short window.
 *
 * Mirrors the reference frontend's `verifyRollout` control flow, minus the
 * browser concerns: from Node there is no origin and no CORS gate, so a cold 503
 * is simply a response with no canonical header (a miss) and a refused/hung
 * connection throws (also a miss) — both just keep the loop going.
 *
 * Two-phase cadence (tuned for the common case): poll every second for the first
 * 30s so a warm redeploy confirms almost instantly, then back off to every two
 * seconds out to a 120s hard stop so a cold pod is still caught without hanging
 * the terminal for minutes. Past the deadline the caller decides what an
 * unconfirmed rollout means (today: a soft warning, not a failure).
 */

/** Header the static server stamps with the canonical of the build it served. */
const CANONICAL_HEADER = "X-Xano-Canonical";

/** Fast-phase poll interval — snappy so a warm redeploy confirms almost instantly. */
const FAST_POLL_MS = 1_000;
/** How long the fast phase lasts before backing off. */
const FAST_PHASE_MS = 30_000;
/** Slow-phase poll interval after the fast phase — enough to still catch a cold pod. */
const SLOW_POLL_MS = 2_000;
/** Per-request timeout so a hung socket can't outlast the schedule. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface VerifyRolloutResult {
  /** True once the served `X-Xano-Canonical` matched the expected canonical. */
  live: boolean;
}

/** Injected clock/fetch (tests supply fakes) plus the one timing knob a test overrides. */
export interface VerifyRolloutOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Hard stop for the whole poll (default 120s). */
  totalDeadlineMs?: number;
}

/** Append a cache-busting param without breaking an existing query string. */
function cacheBust(url: string, nonce: number): string {
  try {
    const u = new URL(url);
    u.searchParams.set("_xc", String(nonce));
    return u.toString();
  } catch {
    return `${url}${url.includes("?") ? "&" : "?"}_xc=${nonce}`;
  }
}

/**
 * Poll `url` until the static server serves the build identified by `canonical`.
 * Resolves `{ live: true }` on the first header match, or `{ live: false }` once
 * the total deadline passes without one. Never rejects: transport errors and
 * not-yet-ready responses are misses that keep the loop running.
 */
export async function verifyRollout(
  url: string,
  canonical: string,
  opts: VerifyRolloutOptions = {},
): Promise<VerifyRolloutResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const totalDeadlineMs = opts.totalDeadlineMs ?? 120_000;

  // An empty expected canonical could spuriously match a header-less response's
  // `null` — guard so a misconfigured call fails closed rather than open.
  if (url === "" || canonical === "") return { live: false };

  const start = now();
  for (;;) {
    try {
      // Cache-busting is done with the `_xc` query param (above) rather than a
      // `cache` init option — Node's fetch doesn't model an HTTP cache, and the
      // unique URL already defeats any intermediary caching.
      const res = await fetchFn(cacheBust(url, now()), {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.headers.get(CANONICAL_HEADER) === canonical) return { live: true };
    } catch {
      // Network error, cold 503 (no header), or per-request timeout — a miss.
    }
    const elapsed = now() - start;
    if (elapsed >= totalDeadlineMs) return { live: false };
    await sleep(elapsed < FAST_PHASE_MS ? FAST_POLL_MS : SLOW_POLL_MS);
  }
}

/** What requests to a frontend's URL say about it. */
export type FrontendProbe = "serving" | "down" | "unknown";

/**
 * Ask a frontend's URL, after a clear may have run, whether it still serves.
 *
 * The static-host listing cannot answer that: a refused replace rolls the host
 * ROW back while the content its clear deleted stays deleted, so the row lists
 * a URL that answers 404. Only the URL itself knows. A success is `serving`;
 * any other HTTP answer is `down` (a 5xx is asked again first — the edge can
 * blip); requests that never got an answer are `unknown`, and the caller then
 * claims neither way.
 */
export async function probeFrontend(
  url: string,
  opts: Pick<VerifyRolloutOptions, "fetchFn" | "sleep"> & { attempts?: number } = {},
): Promise<FrontendProbe> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 3;
  let last: FrontendProbe = "unknown";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(FAST_POLL_MS);
    try {
      const res = await fetchFn(cacheBust(url, Date.now()), { method: "GET", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      // The status is the answer; the body is not read.
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return "serving";
      last = "down";
      if (res.status < 500) return "down";
    } catch {
      // No answer at all: this attempt says nothing. An earlier 5xx still stands.
    }
  }
  return last;
}
