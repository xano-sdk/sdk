/**
 * `env(name)` — read a workspace environment variable.
 *
 * Two spellings, and the second is the one to reach for. `env("NAME")` takes a
 * bare string checked against nothing, so a misspelling deploys clean and then
 * resolves to NULL at request time — no error, just a missing value that fails
 * somewhere downstream. `typedEnv(config)` turns the names THIS workspace's
 * config declares into properties, so the same typo is a compile error.
 *
 * `export()` also warns (`stack.env-undeclared`) on any `env()` naming something
 * the config does not declare, which is the safety net for the string form and
 * for a name that really does live only in the dashboard.
 */
import { defineFunction, s, env, ref, typedEnv, obj } from "@xano/sdk";
import { wsConfig } from "../kinds/workspaceConfig.js";

/** The declared env names, as properties. `E.STRIP_KEY` does not compile. */
const E = typedEnv(wsConfig);

export const valueEnv = defineFunction({
  name: "ex_value_env",
  stack: [
    s.set_var("apiKey", E.STRIPE_KEY),
    // The string form still works — for a variable set in the dashboard rather
    // than declared here, it is the only form there is.
    s.set_var("baseUrl", env("APP_BASE_URL")),
  ],
  response: obj({ apiKey: ref("apiKey"), baseUrl: ref("baseUrl") }),
});
