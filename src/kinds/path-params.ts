/**
 * Shared `{param}` path handling for the two kinds whose `name` IS a path: an
 * API `query` (`"blog/{slug}"`) and a `realtimeChannel` (`"rooms/{room_id}"`).
 *
 * A path param is two declarations that must agree — the `{param}` marker in the
 * name, and an input of the same name that the engine binds the URL segment to.
 * Nothing in the persisted object links them, so an orphan marker deploys as a
 * permanently-broken route. These helpers make the pair a checked contract and
 * give both kinds one interpolation routine, so their rules cannot drift.
 *
 * Grammar, taken from the engine's router rather than invented here:
 *   path   := any literal text with `{name}` markers embedded anywhere
 *   name   := any run of characters other than `/` `{` `}` — unique within one path
 *
 * The router scans the whole action string for `{...}` markers, substitutes a
 * capture group for each (`[^/]+`, narrowed to `\d+` for an `int` input and
 * `\d+\.?\d*` for a `decimal`), then matches the request path against the
 * result. So a marker does NOT have to be a whole segment — `"blog/post-{slug}"`
 * routes fine — and a name is not restricted to an identifier.
 *
 * A stricter rule ("a whole segment naming `[A-Za-z_]\w*`") would reject routes
 * XANO ITSELF generates: a table named `1table` gets the CRUD route
 * `"1table/{1table_id}"`, whose param starts with a digit.
 */
import type { InputDescriptor } from "../inputs/input.js";

/**
 * One `{param}` marker, anywhere in the path. The name excludes `/` (the engine's
 * own `[^/]+`) and the braces themselves, so adjacent markers cannot be swallowed
 * by a single greedy match the way the engine's own pattern would.
 */
const PARAM_MARKER = /\{([^/{}]+)\}/g;

/**
 * Stored field types a URL/channel segment cannot carry. A segment is one
 * string, so anything structured (`obj`, `json`, a list), binary (`blob*`), or
 * multi-valued (`geo_*`, `vector`) is rejected.
 *
 * Deliberately a DENY-list: a scalar type added to the field catalog later keeps
 * working, and only the structurally impossible is refused. Note a `tableRef`
 * input is absent — it stores as an `int`/`uuid` scalar, so `"posts/{author_id}"`
 * against a table reference is a legitimate route.
 */
const NON_SEGMENT_TYPES = new Set(["obj", "json", "blob", "blob_img", "blob_video", "blob_audio", "vector"]);

/** Whether a stored field type can occupy one path segment. */
function isSegmentType(type: string): boolean {
  return !NON_SEGMENT_TYPES.has(type) && !type.startsWith("geo_");
}

/**
 * The `{param}` names in a path, in order (`[]` for a static path). Throws on a
 * malformed marker rather than silently treating it as a literal segment — a
 * route that looks parameterized but isn't is the failure this whole module
 * exists to prevent.
 */
export function parsePathParams(context: string, path: string): string[] {
  const params: string[] = [];
  const cleaned = path.replace(/^\/+/, "");
  // Consume every well-formed marker, keeping what falls between them. A brace
  // surviving in that residue is a marker that never closed (or never opened) —
  // still worth refusing, because a route that LOOKS parameterized and is not is
  // the silent breakage this module exists to prevent. Everything else the
  // engine's router accepts is accepted here.
  let residue = "";
  let cursor = 0;
  for (const match of cleaned.matchAll(PARAM_MARKER)) {
    residue += cleaned.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const name = match[1]!;
    if (params.includes(name)) {
      throw new Error(
        `${context}: the path param \`${name}\` appears twice. Each {param} must be unique within one path — ` +
          `two segments cannot bind the same input.`,
      );
    }
    params.push(name);
  }
  residue += cleaned.slice(cursor);
  if (residue.includes("{") || residue.includes("}")) {
    throw new Error(
      `${context}: "${path}" has an unmatched brace. A path param is written \`{name}\`, where the ` +
        `name holds no "/", "{" or "}" — it may sit anywhere in the path ("blog/{slug}", ` +
        `"blog/post-{slug}"), and each name must have an input of the same name to bind to.`,
    );
  }
  return params;
}

/**
 * Enforce the path↔input contract: every `{param}` has an input of that name,
 * and that input's type fits in one path segment.
 *
 * This is Xano SDK's opinion, not an engine rule. Xano treats a `{param}` as a
 * plain route string and will happily serve an endpoint whose marker binds to
 * nothing — which is precisely the silent breakage worth refusing at authoring
 * time. What is NOT enforced is `required: true`: the engine's own editor
 * creates path-param inputs unmarked, so demanding it here would put every
 * Xano SDK-authored object out of step with every UI-authored one.
 *
 * One-directional by design — an input that is NOT in the path is a normal
 * query-string or body param and is left alone.
 */
export function assertPathParamInputs(
  context: string,
  params: readonly string[],
  inputs: Record<string, InputDescriptor> | undefined,
): void {
  for (const name of params) {
    const descriptor = inputs?.[name];
    if (!descriptor) {
      throw new Error(
        `${context}: the path declares {${name}} but there is no \`${name}\` input to bind it to, ` +
          `so the segment would be an inert part of the route string. Add it: ` +
          `input: { ${name}: input.text() }.`,
      );
    }
    if (descriptor.options?.array === true) {
      throw new Error(
        `${context}: the path param \`${name}\` cannot be a list — one path segment holds one value. ` +
          `Use a scalar input, or take the list as a query-string/body param under a different name.`,
      );
    }
    const type = descriptor.type;
    if (!isSegmentType(type)) {
      const article = /^[aeiou]/i.test(type) ? "an" : "a";
      throw new Error(
        `${context}: the path param \`${name}\` cannot be ${article} \`${type}\` — a path segment is a single ` +
          `string, so structured, binary, and multi-valued types have no URL form. Use a scalar input ` +
          `(text/int/uuid/…), or move this value to a query-string or body param.`,
      );
    }
  }
}

/**
 * The `{param}` names in a stored object's path that bind to NO stored input —
 * the segments codegen synthesizes an `input.text()` for, and therefore the only
 * inputs a regenerated bundle is expected to hold that its source did not.
 *
 * Exported so the decoder that adds them and the verifier that forgives them
 * read one rule (invariant 4): two copies would drift, and the drift would show
 * up as a round-trip failure nobody could act on. A path whose markers do not
 * parse yields `[]` — nothing is synthesized for it either, so nothing is
 * expected.
 */
export function unboundPathParams(path: string, storedInput: unknown): string[] {
  let params: string[];
  try {
    params = parsePathParams("path", path);
  } catch {
    return [];
  }
  const bound = new Set(
    (Array.isArray(storedInput) ? storedInput : []).map((entry) =>
      entry !== null && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined,
    ),
  );
  return params.filter((param) => !bound.has(param));
}

/**
 * A segment that is exactly `.` or `..` — the two a URL parser REMOVES
 * before the request is routed, taking a parent segment with it
 * (`/api:ig/blog/../r/1` resolves to `/api:ig/r/1`, the `blog` segment simply
 * gone). Encoding does not help: the URL standard's path parser treats `%2e` as
 * a dot for exactly this check, so `blog/%2E%2E/r/1` collapses the same way.
 * Rejection is the only answer, and it is not a real loss — a `.`/`..` slug
 * addresses nothing. Judged on the SEGMENT a value fills, as sent (values
 * encoded), so `post-{slug}` with `slug: "."` (the segment `post-.`) and a
 * value `"%2e"` (sent as `%252e`) are not refused.
 */
const DOT_SEGMENT = /^(\.|%2e){1,2}$/i;

/** One segment of a joinable channel address. */
const CHANNEL_VALUE = /^[A-Za-z0-9_-]+$/;


/**
 * Substitute `{param}` segments with real values, yielding the concrete path a
 * client addresses. Throws rather than emitting a path that would silently hit
 * the wrong route: an unknown key, a missing/empty value, a non-finite number,
 * a value containing `/` (which fabricates a segment), and — for a channel —
 * a value outside the joinable alphabet.
 *
 * `accessor` names the caller in the error text (`getPath()` / `getChannel()`).
 *
 * `encode` percent-encodes each interpolated value, and is the difference
 * between the two callers rather than a preference. A URL path is
 * parsed before it is routed, so `..`, `?` and `#` each address a DIFFERENT
 * endpoint if they ride raw — `blog/../r/1` resolves to `r/1`, `blog/a?b=c/r/1`
 * splits into a shorter path plus attacker-chosen query params. Encoding keeps
 * every value inside its own segment, and the server decodes it back on arrival,
 * so the endpoint sees exactly what was passed. A CHANNEL address is NOT a URL:
 * it travels as a literal string in a JSON frame and is matched literally, and
 * nothing decodes it on the far side — so encoding there would corrupt the value
 * a channel trigger reads rather than protect a route. Hence off for
 * `getChannel()`, on for `getPath()`.
 */
export function fillPathParams(
  context: string,
  accessor: string,
  path: string,
  params?: Record<string, string | number>,
  encode = false,
): string {
  const declared = parsePathParams(context, path);
  const given = params ?? {};
  for (const key of Object.keys(given)) {
    if (!declared.includes(key)) {
      throw new Error(
        `${context}: ${accessor} was given \`${key}\`, which is not a {param} segment of the path. ` +
          (declared.length
            ? `Expected: ${declared.map((p) => `\`${p}\``).join(", ")}.`
            : `This path is static — call ${accessor} with no arguments.`),
      );
    }
  }
  return path.replace(PARAM_MARKER, (_all, key: string, at: number) => {
    const value = given[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `${context}: ${accessor} needs a value for the path param \`${key}\` — ` +
          `pass { ${declared.map((p) => `${p}: … `).join(", ")}}.`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(
        `${context}: the path param \`${key}\` is ${value} — not a finite value to put in a path.`,
      );
    }
    const text = String(value);
    // Kept ahead of the encoding: a `/` in a slug is nearly always the author
    // splitting a path by hand, and an early, named error serves them better
    // than a silently-working `%2F` — which some servers decode back to `/`
    // anyway, re-opening the very hole this check closes.
    if (text.includes("/")) {
      throw new Error(
        `${context}: the path param \`${key}\` cannot contain "/" (got ${JSON.stringify(text)}) — ` +
          `it would fabricate a path segment and address a different route.`,
      );
    }
    // A channel address is joined only when every character is a letter, digit,
    // `_`, `-` or `/`; anything else is refused at join time.
    if (!encode) {
      if (!CHANNEL_VALUE.test(text)) {
        throw new Error(
          `${context}: the path param \`${key}\` is ${JSON.stringify(text)} — a channel segment holds only ` +
            `letters, digits, "_" and "-", so a join with it is refused.`,
        );
      }
      return text;
    }
    // Judged on the segment as sent, values encoded: `post-{slug}` with "." is
    // `post-.`, and "%2e" goes out as "%252e", which is no dot.
    const segment = path
      .slice(path.lastIndexOf("/", at) + 1)
      .split("/")[0]!
      .replace(PARAM_MARKER, (_m, k: string) => encodeURIComponent(String(given[k])));
    if (DOT_SEGMENT.test(segment)) {
      throw new Error(`${context}: the path param \`${key}\` makes the segment ${JSON.stringify(segment)} — URL parsers drop a "." or ".." segment, addressing another endpoint.`);
    }
    // Everything else rides encoded, so `?`, `#`, spaces, control characters and
    // `%` stay inside the segment they were passed for instead of restructuring
    // the URL. The server decodes it back, so the endpoint sees the exact value.
    return encodeURIComponent(text);
  });
}

/**
 * The `{param}` names in a path literal, as a union of string literal types —
 * `PathParams<"blog/{slug}/review/{review_id}">` is `"slug" | "review_id"`, and
 * a static path yields `never`. Lets an accessor type its params argument from
 * the authored `name`, so a wrong or missing key is a compile error rather than
 * a runtime throw at request time.
 */
export type PathParams<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | PathParams<Rest>
  : never;

/** Whether a path literal `S` carries no `{param}` segments. */
export type IsStaticPath<S extends string> = [PathParams<S>] extends [never] ? true : false;

/** The exactly-keyed params record for a path literal `S`. */
export type PathParamValues<S extends string> = Record<PathParams<S>, string | number>;
