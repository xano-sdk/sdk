/**
 * `sys.*` — the built-in system / request-context variables (client IP, HTTP
 * method, data source, …). In XanoScript these read as `$env.$remote_ip`, but
 * they are *settings* under the hood, not user env vars — so `env("remote_ip")`
 * would read the wrong thing. `sys.remoteIp()` emits the correct form for you.
 *
 * The most useful one is `sys.remoteIp()`: on a **public** endpoint `auth("id")`
 * is null, so it is the key to reach for when rate-limiting anonymous callers.
 */
import { defineFunction, s, sys, ref } from "@xano/sdk";

export const valueSys = defineFunction({
  name: "ex_value_sys",
  stack: [
    s.set_var("ip", sys.remoteIp()),
    s.set_var("method", sys.requestMethod()),
    s.set_var("datasource", sys.datasource()),
  ],
  response: ref("ip"),
});
