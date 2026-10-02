/**
 * `workspaceConfig({...})` — workspace-level settings (payload key `workspace`),
 * e.g. the canonical domain. Also carries `use_xdo` and the
 * workspace-tier `middleware` and `history` maps — the terminal fallback of the
 * Query → API Group → Workspace chain. Their keys are per object type (no
 * `_customize`/inherit flags); a query with no closer override inherits these.
 */
import { workspaceConfig } from "@xano/sdk";
import { publicRateLimit } from "./middleware.js";

export const wsConfig = workspaceConfig({
  // No `name`: the config inherits the one `workspace("…")` gave the registry
  // in index.ts. Naming it here would RENAME the workspace.
  canonical: "my-app",
  // NOTE: `realtime` and `documentation` are deliberately absent, and the absence
  // MEANS something: neither key is emitted, so a deploy leaves whatever the
  // target holds exactly as it is. That is the right default for both. Writing
  // `documentation: {}` would send the engine's empty block and clear a live doc
  // site's token, whitelist and `require_token` while leaving `swagger` on.
  //
  // To gate this workspace's hosted docs, declare the GATE — never a literal
  // token, which fails the export:
  //
  //   documentation: { require_token: true }
  //
  // The value goes in `xano/.secrets.json`, not in `xano/.env` beside the
  // backend values below. Which file a secret belongs in is decided by how it is
  // addressed: a backend variable is addressed by NAME (`env("NAME")` is how a
  // stack reads it), a documentation token by the OBJECT that holds it. So this
  // one has no name at all, never reaches the workspace's own env, and
  // `env(...)` in a stack cannot read it. `xanosdk pull` writes that file and
  // every build reads it back; a gate declared here has no live value to pull,
  // so `xanosdk secrets fill` mints one for every declared gate the file has none
  // for.
  //
  // (For realtime, author `realtimeServer` / `realtimeChannel` /
  // `realtimeMessage` — see the realtime examples. A workspace-level
  // `realtime.hash` is assigned by the engine, so authoring one is meaningless.)
  middleware: {
    // The workspace tier is inherited by EVERY query with no closer override,
    // most of which are public — so the chain here has to be one that works
    // without a caller identity. `publicRateLimit` keys off `sys.remoteIp()`.
    // The `auth("id")`-keyed `rateLimit` belongs on an authenticated host (see
    // `guardedEndpoint`, which attaches it directly): inherited down to a public
    // query its key does not resolve and every anonymous request 403s.
    // `export()` warns, naming the tier.
    query: { pre: [publicRateLimit] },
  },
  // Workspace-tier request-history defaults (terminal, wholesale — unlisted types
  // fall back to their engine default). A scalar per object type.
  history: {
    query: 100,
    function: true,
    trigger: "all",
    // `message` is the realtime tier; it defaults off because message history is
    // a hot path.
    message: false,
  },
  // Workspace environment variables — read at request time with `env("NAME")`.
  // VALUES ARE SECRETS. The best-practice shape is a NAME here with an empty
  // value and the value in `xano/.env`, which is gitignored, survives a
  // `xanosdk pull`, and is read with no flag by every command that compiles a
  // bundle (`xanosdk env pull` fills it from a running backend). A deploy
  // REPLACES the tenant's env set, so a declared name with no value anywhere
  // refuses the deploy rather than clearing the live value.
  //
  // `process.env.X ?? ""` below is the OTHER supported source — this file is
  // compiled by a repo that has no `xano/` directory of its own, so it reads the
  // shell. An application project should prefer `xano/.env`: it is discoverable,
  // diffable, and visible to the tooling that reports on it.
  //
  // Declare EVERY name the stack reads: `export()` warns
  // (`stack.env-undeclared`) on an `env()` outside this set, because a name that
  // does not exist resolves to null rather than erroring, and `typedEnv(wsConfig)`
  // types exactly these so a misspelling is a compile error.
  env: {
    STRIPE_KEY: process.env.STRIPE_KEY ?? "",
    APP_BASE_URL: "https://my-app.example.com",
    DEFAULT_REGION: "us-east-1",
    // Read by the crypto and integration examples below.
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "",
    JWE_KEY: process.env.JWE_KEY ?? "",
    JWS_KEY: process.env.JWS_KEY ?? "",
    PROVIDER_API_KEY: process.env.PROVIDER_API_KEY ?? "",
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "",
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    ELASTIC_KEY_ID: process.env.ELASTIC_KEY_ID ?? "",
    ELASTIC_API_KEY: process.env.ELASTIC_API_KEY ?? "",
    EXTERNAL_MSSQL_CONNECTION: process.env.EXTERNAL_MSSQL_CONNECTION ?? "",
    EXTERNAL_MYSQL_CONNECTION: process.env.EXTERNAL_MYSQL_CONNECTION ?? "",
    EXTERNAL_ORACLE_CONNECTION: process.env.EXTERNAL_ORACLE_CONNECTION ?? "",
    EXTERNAL_POSTGRES_CONNECTION: process.env.EXTERNAL_POSTGRES_CONNECTION ?? "",
    EXTERNAL_SNOWFLAKE_CONNECTION: process.env.EXTERNAL_SNOWFLAKE_CONNECTION ?? "",
  },
  // Editor preferences. Declare only what departs from the engine's defaults
  // (`allow_push: false`, `track_performance: true`, `use_internal_docs: false`)
  // — a value equal to the default is dropped when a workspace is pulled back.
  preferences: { allow_push: true },
  // Workspace settings, an opaque map merged over the engine's default scaffold:
  // name the members you care about, not the four provider configs you don't.
  settings: { ai_enabled: true },
  // Defaults applied to newly created objects (engine default: `int`).
  defaults: { db_primary_key: "uuid" },
  // Let tables carry SQL names distinct from their workspace names.
  use_custom_names: true,
  // Non-live datasources. WHOLESALE: deploying replaces the tenant's list, so
  // declare every datasource you want to keep.
  datasources: [{ label: "test", color: "#fff3cd" }],
  datasource_live: { color: "#fff3cd", show_banner: true },
});
