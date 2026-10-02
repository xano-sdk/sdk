/**
 * `s.security.create_auth_token({ table, id, extras?, expiration?, as? })` —
 * mint an auth token for a row of an auth table.
 *
 * PARAM GATE: `expiration` (seconds; 0 = never expires).
 */
import { defineFunction, s, c, auth, ref } from "@xano/sdk";
import { users } from "../../_shared.js";

export const createAuthToken = defineFunction({
  name: "ex_security_create_auth_token",
  stack: [
    s.security.create_auth_token({
      table: users,
      id: auth("id"),
      extras: c.obj({ role: "member" }),
      expiration: c.int(86400),
      as: "token",
    }),
  ],
  response: ref("token"),
});
