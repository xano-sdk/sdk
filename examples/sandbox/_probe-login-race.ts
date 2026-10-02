/**
 * Probe for the post-seed login race. NOT a shipped example, NOT
 * auto-indexed.
 *
 * The report: after a seed truncates and re-adds auth rows, the FIRST login
 * within roughly two seconds can 401 or return a null token; the next attempt
 * succeeds. Three separate builds each added a one-time client-side retry.
 *
 * This deploys a seeded auth table plus a login endpoint, so the driver script
 * can call login as fast as possible after the deploy returns and record what
 * comes back.
 *
 * Run:
 *   npx tsx src/emit/bin.ts deploy examples/sandbox/_probe-login-race.ts
 *   then hammer /auth/login immediately — see scripts note at the bottom.
 */
import {
  workspace,
  table,
  apiGroup,
  query,
  input,
  s,
  f,
  c,
  ref,
  inp,
  auth,
  expr,
} from "@xano/sdk";

const api = apiGroup({ name: "probe", canonical: "probe" });

/** A seeded auth table: the seed truncates and re-adds on every deploy. */
const users = table({
  name: "probe_users",
  auth: true,
  schema: {
    email: f.email({ required: true }),
    password: f.password(),
  },
  index: [{ type: "unique", fields: [{ name: "email" }] }],
  seed: [{ email: "demo@example.com", password: "demo-password" }],
});

/** The login the report says can 401 or mint a null token right after a seed. */
const login = query({
  name: "login",
  verb: "POST",
  apiGroup: api,
  input: { email: input.email({ required: true }), password: input.text({ required: true }) },
  stack: [
    s.db.get({
      table: users,
      fieldName: "email",
      fieldValue: inp("email"),
      output: ["id", "password"],
      as: "user",
    }),
    s.precondition({
      expr: expr(ref("user", { safe: true }), "!=", c.null()),
      error: c.text("No such user."),
      error_type: "notfound",
    }),
    s.security.check_password({
      text_password: inp("password"),
      hash_password: ref("user.password"),
      as: "ok",
    }),
    s.precondition({ expr: expr(ref("ok"), "=", c.bool(true)), error: c.text("Bad password."), error_type: "accessdenied" }),
    s.security.create_auth_token({ table: users, id: ref("user.id"), expiration: c.int(86400), as: "token" }),
  ],
  response: { token: ref("token") },
});

/** Proves a minted token actually authenticates — a NON-null token that does not work is the other half of the report. */
const me = query({
  name: "me",
  verb: "GET",
  apiGroup: api,
  auth: users,
  stack: [],
  response: { id: auth("id") },
});

export default workspace("probe243")
  .registerTables([users])
  .registerApiGroups([api])
  .registerQueries([login, me]);

/* ───────────────────────── MEASURED OUTPUT, 2026-08-23 ─────────────────────
 * DID NOT REPRODUCE.
 *
 * Six back-to-back logins issued as fast as the shell could send them after one
 * seeding deploy returned:
 *   attempt 1..6  → HTTP 200, a real 403-char token every time
 *
 * Three separate deploy-then-immediately-login cycles:
 *   cycle 1..3    → login 200, token non-null, GET me with it → 200 {"id":1}
 *
 * So the first post-seed login minted a WORKING token, not a 401 and not a null.
 *
 * Caveats, because "did not reproduce" is weak evidence here: the first call
 * lands ~300ms after the deploy command returns, and the command does its own
 * work after the import commits — so this may not be the tightest possible
 * moment. A timing race four builds hit and one probe misses is exactly the
 * shape a faster client or a loaded instance would surface.
 *
 * NOTE: the first version of this probe took the login password through
 * `input.password()` and got a flat 403 on every attempt — the documented
 * double-hash gotcha, not a race. `input.text()` is the correct spelling on a
 * login, and the grounding docs already say so.
 * ─────────────────────────────────────────────────────────────────────── */
