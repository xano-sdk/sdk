/**
 * `apiGroup({...})` — an API group (payload key `app`) that endpoints publish
 * under. `canonical` is the URL slug; CORS and auth can be configured here.
 */
import { apiGroup } from "@xano/sdk";

export const publicApi = apiGroup({
  name: "ex_kind_public_api",
  canonical: "public",
  description: "Public, unauthenticated endpoints",
  // Container-tier request-history default: the `query_*` setting queries in this
  // group inherit when they don't set their own `history`.
  history: false,
  // The gate on this group's hosted API documentation.
  //
  // `swagger` is what PUBLISHES the docs and it is off here, so nothing is
  // exposed either way. Turn it on and this block decides who can read every
  // endpoint, input and response shape in the group: `require_token` gates them
  // only alongside a non-empty token, so `require_token: true` on its own is not
  // a gate. `export()` warns once per build naming every group it would leave
  // publicly readable, and `--strict` turns that into a failed build.
  //
  // `require_token: true` is the whole declaration — the token itself is never
  // spelled here, and a literal `token` fails the export, because this file is
  // committed. `xanosdk pull` writes the value to `xano/.secrets.json`, keyed by
  // this group's guid; it is gitignored, and every command that compiles a
  // bundle reads it back with no flag, so pull-then-deploy restores the gate
  // with no step in between. A gate declared HERE has no live value to pull —
  // `xanosdk secrets fill` mints one for every declared gate the file has none
  // for, and never replaces one it holds. CI, which has no such file, passes
  // `--secrets-file <path>` or `--doc-token "Public API=<value>"`.
  //
  // A gate nothing supplies emits no `documentation` block at all, so a build
  // can never clear a live gate by accident — except on a PUBLISHED group,
  // where an absent key IS the clearing, so the export fails outright instead.
  //
  // ⚠ Unlike the workspace's block, this one is ALWAYS sent. Omitting it does
  // NOT leave the target's alone — an absent key on a group is written as the
  // engine default on import, which clears the gate.
  documentation: { require_token: true },
});

/**
 * A CORS policy that answers a browser.
 *
 * `mode` decides whether the rest of the block is read at all: `"default"`
 * serves a fixed permissive policy and IGNORES these fields, `"disabled"` sends
 * no CORS headers, and only `"custom"` applies what is written here.
 *
 * Under `"custom"`, `allowOrigins` is matched as EXACT strings — no wildcard, no
 * subdomain expansion — and an unmatched origin gets no `access-control-*`
 * headers at all, which surfaces only as a browser console error. So name every
 * origin (`"*"` is compared as a literal origin and matches nothing; use
 * `mode: "default"` when any origin is what you mean), and enable every verb the
 * group's endpoints use: `allowMethods` gates the real response too, not just
 * the preflight. `export()` warns on all three mistakes.
 */
export const browserApi = apiGroup({
  name: "ex_kind_browser_api",
  canonical: "browser",
  description: "Endpoints called from a browser app on a known origin",
  cors: {
    mode: "custom",
    allowOrigins: ["https://app.example.com", "http://localhost:5173"],
    allowMethods: { get: true, post: true, patch: true, delete: true },
    allowCredentials: true,
    maxAge: 3600,
  },
});
