/**
 * `toolset(path)` — read a toolset-scoped binding inside a tool (`{tag:"toolset"}`).
 * The engine binds two: the calling URL's `token`, and its `params` object; a
 * dotted `params.<key>` reads one parameter out of that object.
 */
import { tool, s, toolset, ref } from "@xano/sdk";

export const valueToolset = tool({
  name: "ex_value_toolset",
  description: "Read the token and one URL parameter off the calling toolset",
  stack: [
    s.set_var("callerToken", toolset("token")),
    s.set_var("tenant", toolset("params.tenant")),
  ],
  response: ref("tenant"),
});
