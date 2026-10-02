/**
 * `s.expect.to_throw({ body, exception? })` — assert a sub-stack raises (test).
 *
 * Hosted by a `workflowTest`, like every `s.expect.*`: assertions belong there,
 * and a failure raises rather than being collected, so one left in a
 * query/function 500s the request.
 *
 * Two rules the signature does not show:
 *
 * ⚠ It sees only an error carrying a MESSAGE. A failure whose message is empty
 * — an endpoint answering `ERROR_CODE_ACCESS_DENIED` is the common one —
 * reports "response is ok" as though nothing failed. Assert on a throw whose
 * message you control, as here.
 *
 * ⚠ `body` runs in an ISOLATED var stack, so a variable bound earlier in the
 * test is not visible inside it. Bind what the body needs inside the body.
 */
import { workflowTest, s, c } from "@xano/sdk";

/** Gate 1 — any error passes when `exception` is omitted. */
export const expectToThrow = workflowTest({
  name: "ex_expect_to_throw",
  stack: [
    s.expect.to_throw({
      body: [s.throw({ value: c.text("boom") })],
    }),
  ],
});

/** Gate 2 — `exception` pins the message (case-insensitive substring). */
export const expectToThrowMessage = workflowTest({
  name: "ex_expect_to_throw_message",
  stack: [
    s.expect.to_throw({
      exception: c.text("boom"),
      body: [s.throw({ value: c.text("boom: the widget exploded") })],
    }),
  ],
});
