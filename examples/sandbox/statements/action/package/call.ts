/**
 * `s.action.package.call({ traceId, versionId, slug, input?, registry?, as? })`
 * — invoke an action inside an installed package.
 *
 * The three identity parts are one composite the instance assigns at install, so
 * all three are required: a call carrying two of them addresses nothing. All
 * three are opaque guids — read them off an existing call in a pulled workspace
 * rather than constructing one. `registry` holds the installed action's own
 * configured settings, separate from the per-call `input`.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const actionPackageCall = defineFunction({
  name: "ex_action_package_call",
  stack: [
    s.action.package.call({
      traceId: "0f2b1c74-9a3e-4a51-bf40-7c9d2e6a18b3",
      versionId: "d3f8a1e2-5c47-4b90-9e13-6a2f0b8c4d15",
      slug: "acme-utils",
      input: { x: c.int(1) },
      registry: { api_key: c.text("…") },
      as: "out",
    }),
  ],
  response: ref("out"),
});
