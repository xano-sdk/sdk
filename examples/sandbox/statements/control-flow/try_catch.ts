/**
 * `s.try_catch({ try, catch, finally })` — error handling. The engine maps
 * try→if, catch→else, finally→then.
 */
import { defineFunction, s, c, ref, caught } from "@xano/sdk";

export const tryCatch = defineFunction({
  name: "ex_try_catch",
  stack: [
    s.set_var("result", c.text("")),
    s.try_catch({
      try: [s.update_var("result", c.text("ok"))],
      catch: [s.update_var("result", c.text("failed"))],
      finally: [s.comment("always runs")],
    }),
  ],
  response: ref("result"),
});

/**
 * `caught(...)` reads the error the catch arm caught — the reason to write a
 * catch arm at all. It is valid ONLY inside `catch`: the engine binds the error
 * scope for that arm alone, so the same call reads empty in `try`/`finally` or
 * anywhere outside the statement.
 *
 * The four fields are all the engine sets: `message` (human-readable),
 * `name` (the error name/type), `code` (the mapped error code), and `result`
 * (the attached payload, when there is one). Bare `caught()` is the whole
 * record — useful for logging the error verbatim.
 */
export const tryCatchCaught = defineFunction({
  name: "ex_try_catch_caught",
  stack: [
    s.set_var("message", c.text("")),
    s.try_catch({
      try: [s.throw({ value: c.text("boom") })],
      catch: [
        s.update_var("message", caught("message")),
        s.debug.log({ value: caught() }),
      ],
    }),
  ],
  response: ref("message"),
});
