/**
 * `setting(name)` — reference a workspace setting by its raw stored name.
 *
 * A workspace env var and a built-in request variable are the SAME tag; only the
 * name tells them apart. A `$`-prefixed name is a built-in (`$remote_ip`,
 * `$datasource`) — prefer the typed `sys.*` accessors, which spell the `$` for
 * you. A bare name is a user-defined workspace variable, i.e. exactly what
 * `env("NAME")` reads, so it is declared in `workspaceConfig({ env })` like any
 * other and `export()` checks it the same way.
 */
import { defineFunction, s, setting, sys, ref, obj } from "@xano/sdk";

export const valueSetting = defineFunction({
  name: "ex_value_setting",
  stack: [
    // A bare name: a workspace env var, declared in `wsConfig.env`.
    s.set_var("region", setting("DEFAULT_REGION")),
    // A `$`-prefixed name: a built-in. This is `setting("$datasource")` with the
    // prefix handled for you — reach for `sys.*` first.
    s.set_var("datasource", sys.datasource()),
  ],
  response: obj({ region: ref("region"), datasource: ref("datasource") }),
});
