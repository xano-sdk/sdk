/**
 * `s.microservice.request` — call a container workload running alongside the
 * workspace.
 *
 * Address it by passing the `microservice()` def itself. The engine resolves
 * this field by NAME (a workspace-scoped lookup on the microservice's name, not
 * a guid), so `host` binds to `.name` — which means a rename in one place fixes
 * every call site at once, and Xano SDK can check the port before you deploy.
 *
 * `port` folds into `host` as the single `"name:port"` string the engine reads;
 * there is no separate port field on the wire. It is optional:
 *
 *  - a microservice exposing exactly ONE `servicePort` resolves to it, so the
 *    common case needs no port at all (Gate 1);
 *  - one exposing SEVERAL requires it, and rejects a port it does not expose
 *    (Gate 2) — the error names the ports it does.
 *
 * A plain string still works and is the only way to reach an INSTANCE-level
 * microservice (those live in instance settings, not the workspace, so there is
 * no def to pass). It carries its own port: `"legacy:80"` (Gate 3).
 *
 * Only `host` and `path` are required — `method`, `params`, `headers`,
 * `timeout`, and `follow_location` default to the engine's own values. They are
 * still WRITTEN, because this statement's schema requires them; omitting them
 * from the call just means you don't have to type them.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";
import { echoService } from "../../kinds/microservice.js";

/**
 * Gate 1 — the whole call: address the def, name a path.
 *
 * `echoService` exposes one `servicePort` ("8080"), so this emits
 * `host: "ex_kind_echo_service:8080"` without naming a port. The five defaulted
 * fields are written for you at the engine's own values.
 */
export const microserviceRequest = defineFunction({
  name: "ex_microservice_request",
  stack: [s.microservice.request({ as: "result", host: echoService, path: c.text("/health") })],
  response: ref("result"),
});

/**
 * Gate 2 — name the port, and override the defaulted fields.
 *
 * An explicit `port` is always valid, and required once a microservice exposes
 * more than one. A number or a string is accepted; both serialize as text,
 * matching how `servicePort` is stored everywhere else.
 */
export const microserviceRequestPort = defineFunction({
  name: "ex_microservice_request_port",
  stack: [
    s.microservice.request({
      as: "result",
      host: echoService,
      port: 8080,
      path: c.text("/ping"),
      method: "POST",
      params: c.obj({ probe: true }),
      headers: ["X-Probe: 1"],
      timeout: c.int(30),
      follow_location: false,
    }),
  ],
  response: ref("result"),
});

/**
 * Gate 3 — a raw `"name:port"` string, for an instance-level microservice.
 *
 * Accepted, but reach for it only when there is no def to pass: nothing checks
 * the name or the port, so a typo here deploys clean and fails at request time.
 */
export const microserviceRequestInstanceHost = defineFunction({
  name: "ex_microservice_request_instance_host",
  stack: [s.microservice.request({ as: "result", host: "legacy:80", path: c.text("/status") })],
  response: ref("result"),
});
