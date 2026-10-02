/**
 * `s.api.request` — issue an external HTTP request.
 *
 * The field worth demonstrating is `params` (query string for GET/HEAD/OPTIONS,
 * body otherwise), because its rule is not visible from the signature: a plain
 * object may carry tagged values (`inp`/`ref`/`c.*`) at the TOP LEVEL, where
 * each is lifted onto a `const:obj` via a `set` filter — but a tagged value
 * NESTED inside an object or array throws at encode, since `const:obj` embeds a
 * plain JSON constant. For a body with any structure, wrap the whole thing in
 * `obj({...})`, which encodes any depth as a single `const:expr2`.
 *
 * `as` binds the `{ request, response }` envelope, so read the payload through
 * `response.result` rather than off the result directly.
 *
 * No `User-Agent` is sent unless `headers` carries one, and a public API that
 * requires one answers 403 with the rejection sitting in `response.result` like
 * any other body — nothing throws, so the visible symptom is every mapped field
 * reading null. Send one, and gate on `response.status` (see the third example)
 * so an upstream refusal cannot pass for empty data.
 */
import { defineFunction, env, input, inp, obj, ref, s } from "@xano/sdk";

/** Flat `params`: each key is lifted onto the constant object by a `set` filter. */
export const apiRequest = defineFunction({
  name: "ex_api_request",
  input: { q: input.text({ required: true }) },
  stack: [
    s.api.request({
      as: "result",
      method: "GET",
      url: "https://example.com/search",
      // Tagged values are fine here — this record is FLAT.
      params: { q: inp("q"), limit: 10 },
    }),
  ],
  response: ref("result.response.result"),
});

/**
 * A STRUCTURED body. The same record written inline would throw, because the
 * tagged `inp("q")` sits inside an array inside an object — `obj()` is what
 * carries a tagged value to any depth.
 */
export const apiRequestNestedBody = defineFunction({
  name: "ex_api_request_nested_body",
  input: { q: input.text({ required: true }) },
  stack: [
    s.api.request({
      as: "result",
      method: "POST",
      url: "https://example.com/messages",
      headers: ["Content-Type: application/json"],
      params: obj({ model: "small", input: [{ type: "text", text: inp("q") }] }),
    }),
  ],
  response: ref("result.response.result"),
});

/**
 * A CREDENTIALED request. `headers` takes a `{ "Name": value }` record whose
 * values may be tagged, so an API key from `env()` is one line — literal pairs
 * join into the base array and each tagged pair appends a push of its rendered
 * `"Name: value"` line.
 *
 * Prefer this over the query-param spelling (`?key=...`) that competes with it,
 * but for the right reason: a URL travels into access logs, proxies and
 * `Referer`, where a header does not.
 *
 * It is NOT envelope safety. The `as` envelope's `request` half mirrors `url`,
 * `params` AND `headers`, so returning it raw publishes the credential wherever
 * it rode — which is why this reads `response.result` rather than `result`.
 */
export const apiRequestApiKeyHeader = defineFunction({
  name: "ex_api_request_api_key_header",
  input: { q: input.text({ required: true }) },
  stack: [
    s.api.request({
      as: "result",
      method: "POST",
      url: "https://example.com/v1/generate",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "xanosdk-example (ops@example.com)",
        "x-api-key": env("PROVIDER_API_KEY"),
      },
      params: obj({ prompt: inp("q") }),
    }),
  ],
  response: ref("result.response.result"),
});
