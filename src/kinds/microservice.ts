/**
 * Microservice (`microservice`) — a container workload deployed alongside the
 * workspace, addressed from a stack by `s.microservice.request`.
 *
 * Two mutually exclusive shapes, selected by {@link MicroserviceDef.kind}:
 *
 *  - **`builtin`** — declarative: `configs`, `volumes`, a `deployment` of one or
 *    more containers, and `ingresses`. This is the default.
 *  - **`helm`** — bring-your-own chart: a `chart` reference and its values. A
 *    helm microservice carries no deployment blocks, and a builtin one carries
 *    no chart; the engine serializes them as mutually exclusive groups.
 *
 * **EARLY, AND EXPECTED TO CHANGE.** This models a young platform surface, and
 * every `export()` of a workspace declaring a microservice says so — the docs
 * are read before writing, which is not where an author is when it matters.
 *
 * Two of the blocks the engine declares (`configs` and `volumes`) cannot be
 * authored at all: an import carrying either is refused, and the deploy fatals
 * after provisioning has begun. They stay typed and round-trip so a pulled
 * workspace holding one still decodes, but they are `@deprecated` and
 * `export()` REFUSES a populated one — a type that compiles and then fatals at
 * deploy is a recommendation this SDK will not make. What deploys instead is
 * container-level: `env` for a value the workload reads,
 * {@link MicroserviceContainer.volumes} for storage.
 *
 * ### Two fields carry secrets, and codegen carries them
 *
 * `registryAuth.dockerconfigjson` is a docker registry credential, and
 * `chart.values` is Helm values documented upstream as possibly holding
 * secrets. A live capture confirmed both ride the workspace export, so
 * `xanosdk codegen` writes both into the generated tree VERBATIM.
 *
 * That is deliberate: dropping them would mean a pulled microservice could not
 * be redeployed, which is worse than the alternative for the thing this surface
 * exists to do. But it means **a bundle or generated tree holding a
 * private-registry microservice contains a live credential.**
 *
 * ### What "out of band" can and cannot mean here
 *
 * A `process.env` read in a def is never the answer — it resolves at EXPORT
 * time, writing the literal credential into the bundle and into git with it:
 *
 * ```ts
 * // WRONG, for either field.
 * microservice({ name: "app", registryAuth: { dockerconfigjson: process.env.REGISTRY_JSON! } });
 * ```
 *
 * What the engine DOES resolve at deploy time, from the workspace environment
 * (`workspaceConfig({ env })`), is a reference — two spellings, because a
 * container env entry is a structured slot and a chart value can live at any
 * path:
 *
 * ```ts
 * // A builtin container: name the variable, and the secret stays out of the bundle.
 * env: [{ name: "API_KEY", fromEnv: "STRIPE_SECRET" }]
 * // A helm chart: the same reference, spelled for a value at any depth.
 * chart: { values: 'auth:\n  token: "${env.STRIPE_SECRET}"\n' }
 * ```
 *
 * Only the variable NAME travels in the bundle; rotating the workspace variable
 * takes effect on the next deploy with no edit here, and a reference the
 * workspace does not define fails the deploy rather than resolving blank.
 *
 * `registryAuth.dockerconfigjson` has NO such form — it is not scanned for
 * references — so for THAT field there are two honest options, both about where
 * the bytes live rather than about hiding them:
 *
 * 1. **Leave `registryAuth` unset** and give the workload a public image, or
 *    attach the pull credential to the microservice outside this workspace
 *    entirely. Nothing then carries a credential.
 * 2. **Accept that the tree is secret-bearing.** Keep the compiled bundle and
 *    any pulled tree out of git, or rotate the credential once it lands there.
 *
 * Export reports every literal it writes, and so does the decoder, so a secret
 * in the bundle can never happen quietly.
 */
import { assertDefShape } from "./def-shape.js";
import { registerKind, type ObjectKind } from "./kind.js";
import { brandDef } from "./def-brand.js";
import { markStatement, statementMark } from "../statements/statement.js";
import type { NoExtraKeys } from "../fields/value-types.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";

/** A container port mapping. Both sides are TEXT, as the engine stores them. */
export interface ContainerPort {
  /** The port the service exposes. */
  servicePort: string;
  /** The port inside the container. Defaults to `servicePort` when omitted. */
  containerPort?: string;
}

/** A container's CPU/RAM request, in Kubernetes units (`"50m"`, `"256Mi"`). */
export interface ContainerResources {
  cpu?: string;
  ram?: string;
}

/**
 * One entry in a container's environment. It carries EITHER a literal
 * {@link value} or a {@link fromEnv} reference — never both.
 */
export interface ContainerEnv {
  name: string;
  /** A literal value, written into the bundle as given. */
  value?: string;
  /**
   * Names a WORKSPACE environment variable (`workspaceConfig({ env })`) to read
   * this value from. The reference resolves at DEPLOY time, so only the variable
   * NAME travels in the bundle and the secret itself never enters it — this is
   * the surface to reach for instead of inlining a credential into `value`.
   *
   * Mutually exclusive with `value`: an entry carrying both is refused, because
   * the engine keeps the reference and drops the literal, and bytes whose
   * meaning depends on which half is read are worse than an error.
   */
  fromEnv?: string;
}

/** A volume mounted into a container. */
export interface ContainerVolume {
  name: string;
  type?: string;
  persistent?: Record<string, unknown>;
  emptyDir?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

/**
 * One container in a {@link MicroserviceDeployment}.
 *
 * The container `name` is FREE-FORM: it does not have to match the
 * microservice's own name, and nothing about addressing depends on it. What a
 * stack reaches with `s.microservice.request` is the MICROSERVICE name (plus a
 * `servicePort`), whichever containers happen to sit behind it — so a
 * multi-container workload names each one for what it is. The name a
 * microservice's `ingresses[].paths[].service` refers to is likewise the
 * microservice, not the container.
 */
export interface MicroserviceContainer {
  /** Free-form — see the note above; it need not match the microservice name. */
  name: string;
  image?: string;
  /** Names a `registryAuth` pull secret when the image is private. */
  pullSecret?: string;
  type?: string;
  /** Entrypoint, one element per argv token. */
  command?: string[];
  /** Arguments to the entrypoint, one element per argv token. */
  args?: string[];
  env?: ContainerEnv[];
  ports?: ContainerPort[];
  resources?: ContainerResources;
  volumes?: ContainerVolume[];
}

/** The `builtin` workload: how many replicas of which containers. */
export interface MicroserviceDeployment {
  /** Defaults to 1. */
  replicas?: number;
  /** Defaults to `"Recreate"`. */
  strategy?: string;
  docker?: string;
  containers?: MicroserviceContainer[];
}

/** One path → service mapping of an {@link MicroserviceIngress}. */
export interface MicroserviceIngressPath {
  service?: string;
  path?: string;
}

/** One route into the microservice. */
export interface MicroserviceIngress {
  name: string;
  domain?: string;
  /** Path → container-service mappings. */
  paths?: MicroserviceIngressPath[];
}

/** A named config value attached to the microservice. */
export interface MicroserviceConfig {
  name: string;
  type?: string;
  value?: string;
}

/** A persistent volume claim owned by the microservice. */
export interface MicroserviceVolume {
  name: string;
  size?: string;
  class?: string;
}

/** A bring-your-own Helm chart (`kind: "helm"`). */
export interface MicroserviceChart {
  /** e.g. `oci://registry/repo/chart`, a `.tgz` URL, or `repo/chart`. */
  ref?: string;
  version?: string;
  /**
   * Chart values, as YAML. Stored and carried VERBATIM, with ONE exception: a
   * `${env.NAME}` reference is substituted at DEPLOY time from the workspace
   * environment (`workspaceConfig({ env })`), so the secret never enters the
   * bundle — only the variable name travels.
   *
   * ```yaml
   * auth:
   *   token: "${env.STRIPE_SECRET}"
   * ```
   *
   * The reference works in a VALUE at any depth, never in a key, and the name
   * matches `[A-Za-z_][A-Za-z0-9_]*`. A reference the workspace does not define
   * FAILS the deploy rather than resolving blank. Anything else in these values
   * is carried literally — see the note on {@link MicroserviceDef}.
   */
  values?: string;
}

/** Private-registry pull credentials. See the note on {@link MicroserviceDef}. */
export interface MicroserviceRegistryAuth {
  /** Registry host, e.g. `index.docker.io`. */
  server?: string;
  /** The credential flow that assembled the pull secret. */
  type?: "userpass" | "gcp_sa" | "aws_ecr" | "";
  /**
   * The assembled docker credential. Stored and carried VERBATIM, and reported
   * at export when non-empty. There is no deploy-time indirection: a
   * `process.env` read here resolves at export and bakes the literal into the
   * bundle. See the out-of-band note on {@link MicroserviceDef}.
   */
  dockerconfigjson?: string;
}

export interface MicroserviceDef {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "microservice";
  name: string;
  /**
   * Pin identity explicitly. Omitted, the guid is derived from the name — set it
   * to adopt an object that already exists in a workspace, or to survive a
   * rename. `xanosdk codegen` always emits the engine's own guid, because
   * re-deriving one would be a silent identity rewrite.
   */
  guid?: string;
  description?: string;
  /**
   * `builtin` (declarative containers) or `helm` (bring-your-own chart).
   * Defaults to `builtin`.
   */
  kind?: "builtin" | "helm";
  /**
   * Whether tenant releases deploy this automatically. `manual` still ships with
   * the release but is not auto-deployed there. Defaults to `auto`.
   */
  tenantDeploy?: "auto" | "manual";
  /** `builtin` only. */
  deployment?: MicroserviceDeployment;
  /** `builtin` only. */
  ingresses?: MicroserviceIngress[];
  /**
   * @deprecated NOT DEPLOYABLE. The engine refuses an import carrying this, so
   * `export()` refuses it too rather than letting a build fatal mid-deploy.
   * Put a value the workload reads in a container's `env` instead
   * (`deployment.containers[].env`). Typed and carried only so a pulled
   * workspace holding one still decodes.
   */
  configs?: MicroserviceConfig[];
  /**
   * @deprecated NOT DEPLOYABLE. The engine refuses an import carrying this, so
   * `export()` refuses it too rather than letting a build fatal mid-deploy.
   * Declare storage on the container itself ({@link MicroserviceContainer.volumes}
   * — `emptyDir`, `persistent`, or `config`). Typed and carried only so a pulled
   * workspace holding one still decodes.
   */
  volumes?: MicroserviceVolume[];
  /** `helm` only. */
  chart?: MicroserviceChart;
  /**
   * Private-registry pull credentials, carried into the bundle VERBATIM. Leave
   * unset unless the bundle is allowed to hold a live credential — see the
   * out-of-band note on {@link MicroserviceDef}.
   */
  registryAuth?: MicroserviceRegistryAuth;
  /**
   * Accepted export warnings for this def — `"stack.env-undeclared"` for a
   * `fromEnv`/`${env.NAME}` set outside this workspace config. Never emitted.
   */
  diagnostics?: DiagnosticsFor<"microservice">;
}

/** Record that `statement`'s host was built from the `microservice()` def named `name` — read by the export's reference check. */
export function noteMicroserviceHandleHost(statement: object, name: string): void {
  markStatement(statement, name);
}

/** The microservice def an encoded `s.microservice.request` named by handle, or `undefined` for a host written as a string. */
export function microserviceHandleName(statement: object): string | undefined {
  return statementMark(statement);
}

/**
 * Every `servicePort` this microservice's containers declare, de-duplicated and
 * in declaration order.
 *
 * This is the same list the Xano dashboard flattens to build the host dropdown
 * on a microservice-request statement (one entry per container port), so it is
 * exactly the set of ports `s.microservice.request` can legitimately address.
 * Returns `[]` for a `helm` microservice and for a builtin whose containers
 * expose nothing — neither declares ports, so neither constrains the caller.
 */
export function declaredServicePorts(def: MicroserviceDef): string[] {
  const seen = new Set<string>();
  for (const container of def.deployment?.containers ?? []) {
    for (const port of container.ports ?? []) {
      if (port.servicePort) seen.add(port.servicePort);
    }
  }
  return [...seen];
}

/** The persisted envelope, exactly as the engine stores it. */
export interface MicroserviceXdo {
  name: string;
  description: string;
  kind: string;
  tenant_deploy: string;
  configs: unknown[];
  volumes: unknown[];
  ingresses: unknown[];
  deployment: Record<string, unknown>;
  chart: Record<string, unknown>;
  registry_auth: Record<string, unknown>;
}

/**
 * An argv list as the engine stores it: a list of `{name}` objects, not strings.
 *
 * The authoring surface takes strings because that is what a command line IS;
 * the `{name}` wrapper is a serialization detail of the engine's schema
 * (`!static:objects { name }`) and confirmed by a live capture.
 */
function argvEntries(argv: readonly string[] | undefined): Array<{ name: string }> {
  return (argv ?? []).map((name) => ({ name }));
}

/**
 * One env entry as the engine stores it: `name`, `value`, `from_env` — all three
 * keys always present, `from_env` defaulting to `""`, which is what the engine
 * persists and therefore what a round trip compares against.
 */
function encodeContainerEnv(container: string, e: ContainerEnv): Record<string, unknown> {
  if (e.value !== undefined && e.fromEnv !== undefined) {
    throw new Error(
      `microservice container "${container}": env "${e.name}" sets both \`value\` and \`fromEnv\`. ` +
        `Use \`fromEnv\` to name a workspace environment variable (the secret stays out of the bundle), ` +
        `or \`value\` for a literal — not both.`,
    );
  }
  return { name: e.name, value: e.value ?? "", from_env: e.fromEnv ?? "" };
}

function encodeContainer(c: MicroserviceContainer): Record<string, unknown> {
  if (!c.name) throw new Error("microservice: every container needs a `name`.");
  return {
    name: c.name,
    type: c.type ?? "standard",
    image: c.image ?? "",
    // `containerPort` defaults to `servicePort`, which is what the engine's own
    // scaffold does when a port omits it.
    ports: (c.ports ?? []).map((p) => ({
      servicePort: p.servicePort,
      containerPort: p.containerPort ?? p.servicePort,
    })),
    resources: { cpu: c.resources?.cpu ?? "", ram: c.resources?.ram ?? "" },
    command: argvEntries(c.command),
    args: argvEntries(c.args),
    envs: (c.env ?? []).map((e) => encodeContainerEnv(c.name, e)),
    volumes: (c.volumes ?? []).map((v) => ({ ...v })),
    ...(c.pullSecret !== undefined ? { pull_secret: c.pullSecret } : {}),
  };
}

export function encodeMicroservice(def: MicroserviceDef): MicroserviceXdo {
  if (!def.name) throw new Error("microservice: `name` is required.");
  assertDefShape("microservice", def as unknown as Record<string, unknown>);
  const kind = def.kind ?? "builtin";

  // The two shapes are mutually exclusive in the engine's serialization: a helm
  // row stores empty deployment blocks and a builtin row an empty chart. Reject
  // the contradiction here rather than writing bytes whose meaning depends on
  // which half the engine happens to read.
  if (kind === "helm" && (def.deployment || def.ingresses?.length || def.configs?.length || def.volumes?.length)) {
    throw new Error(
      "microservice: `kind: \"helm\"` takes a `chart` and no deployment blocks — " +
        "`deployment`/`ingresses`/`configs`/`volumes` belong to `kind: \"builtin\"`.",
    );
  }
  if (kind !== "helm" && def.chart) {
    throw new Error(
      "microservice: `chart` belongs to `kind: \"helm\"`. A builtin microservice declares containers instead.",
    );
  }

  const deployment = def.deployment ?? {};
  return {
    name: def.name,
    description: def.description ?? "",
    kind,
    tenant_deploy: def.tenantDeploy ?? "auto",
    configs: (def.configs ?? []).map((c) => ({
      name: c.name,
      type: c.type ?? "",
      value: c.value ?? "",
    })),
    volumes: (def.volumes ?? []).map((v) => ({
      name: v.name,
      size: v.size ?? "",
      class: v.class ?? "",
    })),
    ingresses: (def.ingresses ?? []).map((i) => ({
      name: i.name,
      domain: i.domain ?? "",
      paths: (i.paths ?? []).map((p) => ({ service: p.service ?? "", path: p.path ?? "" })),
    })),
    deployment: {
      docker: deployment.docker ?? "",
      replicas: deployment.replicas ?? 1,
      strategy: deployment.strategy ?? "Recreate",
      containers: (deployment.containers ?? []).map(encodeContainer),
    },
    chart: {
      ref: def.chart?.ref ?? "",
      values: def.chart?.values ?? "",
      version: def.chart?.version ?? "",
    },
    registry_auth: {
      type: def.registryAuth?.type ?? "",
      server: def.registryAuth?.server ?? "",
      dockerconfigjson: def.registryAuth?.dockerconfigjson ?? "",
    },
  };
}

/** `T` held to `S`'s keys — the literal is const-inferred, so an unknown key would widen it instead of failing. */
type Keys<T, S> = NoExtraKeys<T, S, Exclude<keyof S, "__kind" | symbol> & string>;
/** Each element of a list held to `S`'s keys. */
type EachKeys<L, S> = L extends readonly unknown[] ? { [I in keyof L]: Keys<L[I], S> } : unknown;

type ContainerKeys<C> = Keys<C, MicroserviceContainer> &
  (C extends { env: infer E } ? { env: EachKeys<E, ContainerEnv> } : unknown) &
  (C extends { ports: infer P } ? { ports: EachKeys<P, ContainerPort> } : unknown) &
  (C extends { volumes: infer V } ? { volumes: EachKeys<V, ContainerVolume> } : unknown) &
  (C extends { resources: infer R } ? { resources: Keys<R, ContainerResources> } : unknown);

type EachIngress<L> = L extends readonly unknown[]
  ? {
      [I in keyof L]: Keys<L[I], MicroserviceIngress> &
        (L[I] extends { paths: infer P } ? { paths: EachKeys<P, MicroserviceIngressPath> } : unknown);
    }
  : unknown;

type EachContainer<L> = L extends readonly unknown[] ? { [I in keyof L]: ContainerKeys<L[I]> } : unknown;

/**
 * Every nested block of a microservice literal held to its declared keys: a
 * typo anywhere (`containers` at the top, `containerz` in `deployment`) used to
 * compile and surface only at export.
 */
type MicroserviceKeys<D> = Keys<D, MicroserviceDef> &
  (D extends { deployment: infer Dep }
    ? {
        deployment: Keys<Dep, MicroserviceDeployment> &
          (Dep extends { containers: infer L } ? { containers: EachContainer<L> } : unknown);
      }
    : unknown) &
  (D extends { ingresses: infer L } ? { ingresses: EachIngress<L> } : unknown) &
  (D extends { chart: infer C } ? { chart: Keys<C, MicroserviceChart> } : unknown) &
  (D extends { registryAuth: infer R } ? { registryAuth: Keys<R, MicroserviceRegistryAuth> } : unknown) &
  (D extends { configs: infer L } ? { configs: EachKeys<L, MicroserviceConfig> } : unknown) &
  (D extends { volumes: infer L } ? { volumes: EachKeys<L, MicroserviceVolume> } : unknown);

/**
 * Author a microservice. See the module docstring for the two shapes.
 *
 * The `const` generic preserves the literal `servicePort` strings so
 * `s.microservice.request` can type-check a `port` against the ports this
 * microservice actually exposes. `D extends MicroserviceDef` keeps the result
 * assignable anywhere a `MicroserviceDef` is expected. Same shape `agent()`
 * already uses.
 *
 * One consequence: the returned def is READ-ONLY to the type checker, so
 * mutating it after authoring is an error. That is the right way round —
 * validation runs here, once, and a post-hoc mutation would slip past it.
 */
export function microservice<const D extends MicroserviceDef>(
  def: D & MicroserviceKeys<D>,
): D & { readonly __kind?: "microservice" } {
  encodeMicroservice(def); // validate eagerly, at the authoring site
  // The literal `D` never spells the type-only `__kind`, so it is restated on
  // the return — without it the def fit `registerTasks([…])` and every other
  // register call whose def type it happened to satisfy.
  return brandDef(def, "microservice");
}

export const microserviceKind: ObjectKind<MicroserviceDef, MicroserviceXdo> = {
  name: "microservice",
  payloadKey: "microservice",
  encode: encodeMicroservice,
};
registerKind(microserviceKind);
