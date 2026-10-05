/**
 * Route-manifest emission (`xanosdk routes <entry> --emit <path>`; `paths` is an
 * accepted alias).
 *
 * "Derive paths from the defs, never hardcode them" is the SDK's central
 * frontend rule, and following it costs the whole core runtime: importing one
 * query def for its `getPath()` pulls the statement factories in with it,
 * because the `s.*`/`c.*` CALLS that build the def run at module load and cannot
 * be tree-shaken. Measured on a Vite lib build against the published package,
 * that is ~267 kB of minified JS (~65 kB gzipped) for a single path string. The
 * figure is a floor rather than a function of the def: a realistic def with
 * tables, inputs and a `db.query` measures ~2 kB more, because what is being
 * pulled in is the runtime.
 *
 * The documented escape hatch is a hand-typed `ROUTES` table, which is the exact
 * thing the rule exists to prevent: the strings rot silently when a def's `name`
 * changes, and the compile-time key checking is lost.
 *
 * This module removes the trade-off. Everything a frontend needs — the verb, the
 * resolved `/api:<canonical>/<name>` path, and the `{param}` names — is already
 * known at export time. Writing it out as plain data yields the same typed,
 * rename-safe contract at near-zero bundle cost.
 *
 * The core sections of the emitted file import NOTHING. They are generated
 * TypeScript with an inline interpolator, so the guarantee is structural rather
 * than a tree-shaking hope: there is no `@xano/sdk` specifier in it for a
 * bundler to follow. Only a block an installed module contributes may import,
 * and only the packages it declares — never `@xano/sdk`.
 *
 * The file also types every route's, channel's and message's request inputs
 * (`RouteInputs`, `ChannelInputs`, `MessageInputs`; see `route-input-types.ts`),
 * read off the same payload under the same keys, as types only.
 *
 * Keyed by `"<VERB> <name>"` — the verb and the query's real `name`, both
 * strings the def already carries — so no identifier is invented from either,
 * and a backend rename surfaces as a compile error at every call site rather
 * than a 404 at runtime.
 *
 * The verb is IN the key because the engine's own uniqueness rule is
 * `(api group, verb, name)`: `GET listings` and `POST listings` are two
 * different endpoints, and keying on the name alone refused conventional REST
 * outright. Prefixing rather than suffixing keeps the key stable — adding
 * a `POST` sibling never renames the `GET` that was already there — and reads in
 * the order a route is spoken.
 *
 * The api group is in the key only when it has to be. Two groups CAN hold the
 * same verb+name (a `v1` and a `v2` both serving `GET vehicles`), and then each
 * of those endpoints is keyed `"<group>:<VERB> <name>"` — `"v1:GET vehicles"` —
 * while every unambiguous endpoint keeps its short key. The bare ambiguous key is
 * a compile error whose parameter names the qualified keys to use. The group's
 * NAME qualifies, never its canonical: a canonical is mintable, and qualifying by
 * it would rewrite call sites the day it changes.
 *
 * The realtime half is the same trade for sockets. `getUrl()` and
 * `getChannel()` carry the same derive-don't-hardcode rule and the same import
 * cost, and the socket's tenant form (`/ws/<tenant>:<canonical>`) is the one
 * address a frontend genuinely cannot reconstruct — the tenant is glued to the
 * canonical inside a single path segment, unlike the HTTP half's
 * `/tenant/<name>/api:<canonical>`. So the manifest carries the servers'
 * canonicals and the channels' paths too, and emits `socketUrl`/`channelPath`
 * over the same inlined interpolator `routePath` uses.
 */
import { parsePathParams } from "../kinds/path-params.js";
import { pathSegment, type HttpVerb } from "../kinds/query.js";
import type { MessageInputSet, RouteInputSet, RouteInputs } from "../plugin.js";
import { describeInputs, tableColumns } from "./route-inputs.js";
import { NO_ROUTE_INPUTS, renderRouteInputTypes } from "./route-input-types.js";
import { byCodeUnit } from "../util/code-unit.js";

/** One endpoint, as the emitter needs it. */
export interface RouteEntry {
  /** The query's `name`, `{param}` markers intact — the key's second half. */
  name: string;
  /** The HTTP verb — the key's first half, because `(verb, name)` is the identity. */
  verb: HttpVerb;
  /** The api group's resolved canonical URL token. */
  canonical: string;
  /**
   * The api group's name — the qualifier of a key whose `"<VERB> <name>"` is in
   * more than one group. Falls back to the canonical when absent.
   */
  group?: string;
}

/** One realtime server, as the emitter needs it. */
export interface RealtimeServerEntry {
  /** The server's `name` — the manifest's key, and what `socketUrl` selects on. */
  name: string;
  /** The server's resolved canonical URL token (the socket's connection hash). */
  canonical: string;
}

/** One realtime channel, as the emitter needs it. */
export interface RealtimeChannelEntry {
  /** The channel path, `{param}` markers intact — the manifest's key. */
  name: string;
  /** The owning server's `name` (a key of {@link RealtimeServerEntry}). */
  server: string;
}

/** The realtime half of a manifest. Omitted entirely when a workspace has none. */
export interface RealtimeManifest {
  servers: readonly RealtimeServerEntry[];
  channels: readonly RealtimeChannelEntry[];
}

/** Emit-time failure: a route the manifest cannot describe. */
export class RouteManifestError extends Error {}

/**
 * The manifest key for one route: `"GET listings"`.
 *
 * One space, verb first, name verbatim — including its `{param}` markers, so the
 * key is the endpoint as it is written down rather than an identifier invented
 * from it. Exported because the CLI's `--strict` drift check and the tests both
 * have to name the same key this file emits.
 */
export function routeKey(route: { verb: HttpVerb; name: string }): string {
  return `${route.verb} ${route.name}`;
}

/**
 * The key of an endpoint whose {@link routeKey} is in more than one api group:
 * `"v1:GET vehicles"` — the group's name, a colon, then the short key.
 */
export function qualifiedRouteKey(route: { verb: HttpVerb; name: string; group: string }): string {
  return `${route.group}:${routeKey(route)}`;
}

/**
 * Every route's FINAL manifest key, in manifest order (canonical, then name,
 * then verb).
 *
 * A short key held by more than one endpoint is ambiguous: each of those is
 * keyed by its group instead. One function, read by the `ROUTES` renderer and
 * by the planner's input description alike, because a section keyed by one
 * reading and a `ROUTES` keyed by another would name different endpoints under
 * the same key.
 *
 * It never throws. Two endpoints that land on the SAME final key (one verb+name
 * in two groups of one name) are the renderer's to refuse; here both keep that
 * key, so planning a workspace the manifest cannot describe still succeeds —
 * `xanosdk routes` lists such a workspace without writing anything.
 */
export function keyRoutes<R extends RouteEntry>(
  routes: readonly R[],
): Array<{ route: R; key: string; short: string; group: string }> {
  const sorted = [...routes].sort(
    (a, b) =>
      a.canonical.localeCompare(b.canonical) ||
      a.name.localeCompare(b.name) ||
      a.verb.localeCompare(b.verb),
  );
  const holders = new Map<string, number>();
  for (const route of sorted) holders.set(routeKey(route), (holders.get(routeKey(route)) ?? 0) + 1);
  return sorted.map((route) => {
    const short = routeKey(route);
    const group = route.group ?? route.canonical;
    return { route, key: holders.get(short)! > 1 ? qualifiedRouteKey({ ...route, group }) : short, short, group };
  });
}

/**
 * Every channel's FINAL manifest key, in manifest order (path, then server): the
 * path alone when one server owns it, `"<server>:<path>"` on each when two do.
 * Shared by the `CHANNELS` renderer and the planner for the reason given on
 * {@link keyRoutes}, and like it never throws.
 */
export function keyChannels<C extends RealtimeChannelEntry>(channels: readonly C[]): Array<{ channel: C; key: string }> {
  const holders = new Map<string, number>();
  for (const channel of channels) holders.set(channel.name, (holders.get(channel.name) ?? 0) + 1);
  return [...channels]
    .sort((a, b) => a.name.localeCompare(b.name) || a.server.localeCompare(b.server))
    .map((channel) => ({
      channel,
      key: holders.get(channel.name)! > 1 ? `${channel.server}:${channel.name}` : channel.name,
    }));
}

/** A TypeScript string literal for `value`, safe in single quotes. */
function literal(value: string): string {
  return JSON.stringify(value);
}

/**
 * An object literal body from already-rendered `  "key": …,` rows. Empty renders
 * as `{}` rather than a pair of braces around a blank line — reachable now that
 * a realtime-only workspace emits a manifest with no routes in it.
 */
function objectLiteral(rows: readonly string[]): string {
  return rows.length === 0 ? "{}" : `{\n${rows.join("\n")}\n}`;
}

/**
 * One `routePath`/`channelPath` overload per entry, so the params argument is
 * typed exactly — a missing key, a wrong key, or params on a static path are all
 * compile errors rather than runtime throws at request time.
 */
function overloadsFor(fn: string, rows: readonly { name: string; params: string[] }[]): string {
  return rows
    .map((r) =>
      r.params.length === 0
        ? `export function ${fn}(name: ${literal(r.name)}): string;`
        : `export function ${fn}(name: ${literal(r.name)}, params: { ${r.params
            .map((p) => `${literal(p)}: string | number`)
            .join("; ")} }): string;`,
    )
    .join("\n");
}

/**
 * The realtime section's source text — the servers' canonicals, the channels and
 * their owning server, and the typed `channelPath` overloads.
 *
 * Channels key on their path alone when one server owns it. A path two servers
 * both own is keyed `"<server>:<path>"` on each, as a query shared across api
 * groups is keyed by group: every unambiguous key stays short, and the bare
 * ambiguous key is a compile error (and a runtime throw) naming the keys to use.
 */
function renderRealtime(realtime: RealtimeManifest): string {
  const servers = [...realtime.servers].sort((a, b) => a.name.localeCompare(b.name));
  const known = new Map(servers.map((s) => [s.name, s]));

  const seenServer = new Set<string>();
  for (const server of servers) {
    if (seenServer.has(server.name)) {
      throw new RouteManifestError(
        `Two realtime servers are both named "${server.name}". The manifest keys on the server ` +
          `name, so the names must be unique. Rename one.`,
      );
    }
    seenServer.add(server.name);
  }

  const ambiguous = new Map<string, string[]>();
  const seenChannel = new Set<string>();
  const channels = keyChannels(realtime.channels)
    .map(({ channel, key }) => {
      if (!known.has(channel.server)) {
        throw new RouteManifestError(
          `The channel "${channel.name}" names the realtime server "${channel.server}", which is not in ` +
            `this workspace. A channel's socket URL comes from its server's canonical, so the server must ` +
            `be registered too.`,
        );
      }
      if (seenChannel.has(key)) {
        throw new RouteManifestError(
          `The realtime server "${channel.server}" has two channels both named "${channel.name}". Rename one.`,
        );
      }
      seenChannel.add(key);
      if (key !== channel.name) ambiguous.set(channel.name, [...(ambiguous.get(channel.name) ?? []), key]);
      return { ...channel, key, params: parsePathParams(`channel "${key}"`, channel.name) };
    });

  const serverRows = servers.map(
    (s) => `  ${literal(s.name)}: { canonical: ${literal(s.canonical)} },`,
  );
  // A qualified key carries its path: the key is no longer the template.
  const channelRows = channels.map(
    (c) =>
      `  ${literal(c.key)}: { server: ${literal(c.server)}${c.key === c.name ? "" : `, path: ${literal(c.name)}`} },`,
  );
  const ambiguousKeys = [...ambiguous.keys()].sort();
  const ambiguousOverloads = ambiguousKeys
    .map((path) => {
      const fix = `${path} is on more than one realtime server - use ${ambiguous.get(path)!.join(" or ")}`;
      return `export function channelPath(name: ${literal(path)} & { readonly ${literal(fix)}: never }, params?: never): never;\n`;
    })
    .join("");
  const ambiguousSection =
    ambiguousKeys.length === 0
      ? ""
      : `
/** Channel paths on more than one realtime server. Each is keyed "<server>:<path>" in CHANNELS instead. */
const AMBIGUOUS_CHANNELS: Record<string, readonly string[]> = ${objectLiteral(
          ambiguousKeys.map((path) => `  ${literal(path)}: [${ambiguous.get(path)!.map(literal).join(", ")}],`),
        )};
`;

  return `
/** Every realtime server in this workspace, by name, with its resolved canonical. */
export const REALTIME_SERVERS = ${objectLiteral(serverRows)} as const;

/** Every realtime server name in this workspace. */
export type RealtimeServerName = keyof typeof REALTIME_SERVERS;
${ambiguousSection}
/** Every realtime channel in this workspace, by path, with its owning server. */
export const CHANNELS = ${objectLiteral(channelRows)} as const;

/** Every realtime channel path in this workspace. */
export type ChannelName = keyof typeof CHANNELS;

${ambiguousOverloads}${overloadsFor("channelPath", channels.map((c) => ({ name: c.key, params: c.params })))}
${realtimeImplementation(ambiguousKeys.length > 0)}`;
}

/**
 * The generated module's source text.
 *
 * `routes` and `realtime` are expected pre-resolved (canonicals already looked
 * up) and are sorted here so the output is deterministic — the file is committed
 * and diffed, and a re-run that reorders it would show as spurious churn.
 *
 * The realtime section is emitted only for a workspace that has one, so a
 * query-only manifest carries no empty realtime block.
 *
 * `inputs` is the planner's description (`RoutePlan.inputs`), already keyed
 * and ordered like the sections above; omitted, every input map is empty. Its
 * types are the LAST core section: they sit after every overload set and its
 * implementation, and a module's block (when one is installed) follows them.
 */
export function renderRouteManifest(
  routes: readonly RouteEntry[],
  realtime?: RealtimeManifest,
  inputs: RouteInputs = NO_ROUTE_INPUTS,
): string {
  // A short key held by more than one endpoint is ambiguous: each of those is
  // keyed by its group instead (`keyRoutes`), and the short key is left out.
  const ambiguous = new Map<string, string[]>();

  const seen = new Map<string, string>();
  const rows = keyRoutes(routes).map(({ route, key, short, group }) => {
    const clash = seen.get(key);
    if (clash !== undefined) {
      throw new RouteManifestError(
        `Two endpoints are both "${short}" in api groups named "${group}" — one whose canonical is ` +
          `"${clash}", one "${route.canonical}". The route manifest keys such an endpoint ` +
          `"<group>:<VERB> <name>", so the group names must differ. Rename one group or endpoint, ` +
          `or give it a different verb.`,
      );
    }
    seen.set(key, route.canonical);
    if (key !== short) ambiguous.set(short, [...(ambiguous.get(short) ?? []), key]);
    const params = parsePathParams(`route "${key}"`, route.name);
    const path = `/api:${route.canonical}/${route.name.replace(/^\/+/, "")}`;
    return { ...route, key, params, path };
  });

  const entries = rows.map(
    (r) => `  ${literal(r.key)}: { verb: ${literal(r.verb)}, path: ${literal(r.path)} },`,
  );
  const ambiguousKeys = [...ambiguous.keys()].sort();
  // The bare key of an ambiguous endpoint matches an overload of its own, listed
  // FIRST so the compiler reports it, whose parameter type spells out the fix: a
  // string literal can never satisfy the branded half, so the call fails naming
  // the keys to use instead.
  const ambiguousOverloads = ambiguousKeys
    .map((short) => {
      const fix = `${short} is in more than one api group - use ${ambiguous.get(short)!.join(" or ")}`;
      return `export function routePath(name: ${literal(short)} & { readonly ${literal(fix)}: never }, params?: never): never;`;
    })
    .join("\n");
  const ambiguousSection =
    ambiguousKeys.length === 0
      ? ""
      : `
/**
 * Endpoints whose "<VERB> <name>" is in more than one api group. Each is keyed
 * "<group>:<VERB> <name>" in ROUTES instead — e.g. ${literal(ambiguous.get(ambiguousKeys[0]!)![0]!)}.
 */
const AMBIGUOUS: Record<string, readonly string[]> = ${objectLiteral(
          ambiguousKeys.map((short) => `  ${literal(short)}: [${ambiguous.get(short)!.map(literal).join(", ")}],`),
        )};
`;

  const realtimeSection =
    realtime && (realtime.servers.length > 0 || realtime.channels.length > 0)
      ? renderRealtime(realtime)
      : "";

  return `${MANIFEST_HEADER}${FILL_PARAMS}${ambiguousSection}
export const ROUTES = ${objectLiteral(entries)} as const;

/**
 * Every endpoint in this workspace, keyed \`"<VERB> <name>"\` (e.g. \`"GET listings"\`),
 * or \`"<group>:<VERB> <name>"\` when that pair is in more than one api group.
 */
export type RouteName = keyof typeof ROUTES;
${rows.length > 1 ? MANY_ROUTES : ""}
${rows.length > 1 ? UNION_OVERLOAD : ""}${ambiguousOverloads ? `${ambiguousOverloads}\n` : ""}${overloadsFor("routePath", rows.map((r) => ({ name: r.key, params: r.params })))}
${implementation(ambiguousKeys.length > 0)}${realtimeSection}${renderRouteInputTypes(inputs)}`;
}

/**
 * The overload a `RouteName` UNION takes — `call(key: RouteName) → routePath(key)`.
 * A single literal never matches it (`ManyRoutes` of one name is `never`), so a
 * literal call keeps its exact per-route params; a union's params are checked
 * at runtime, since no one params type fits every member.
 */
const UNION_OVERLOAD = `/** A union of route names (e.g. a \`key: RouteName\` parameter): params checked at runtime. */
export function routePath<N extends RouteName>(name: ManyRoutes<N>, params?: Record<string, string | number>): string;
`;

/** Emitted before the overloads: nothing may sit between an overload set and its body. */
const MANY_ROUTES = `
/** \`N\` when it is a union of two or more route names, else \`never\`. */
type ManyRoutes<N> = [(N extends unknown ? (x: N) => void : never) extends (x: infer I) => void ? I : never] extends [never] ? N : never;
`;

export const MANIFEST_HEADER = `/**
 * GENERATED by \`xanosdk routes --emit\`. Do not edit.
 *
 * Plain data plus one interpolator, and the request input types of every
 * endpoint, channel and message. The core sections import nothing; the only
 * imports are the packages an installed module's block declares, never the
 * SDK itself. So a frontend gets the typed path/verb (and socket) contract
 * without pulling the SDK runtime into its bundle. Regenerate after changing an
 * endpoint's name, verb, api group or inputs, or a realtime server's, channel's
 * or message's name or inputs.
 */
`;

/**
 * The emitted interpolator — ONE copy, shared by `routePath` and `channelPath`.
 *
 * Mirrors \`fillPathParams\` rule for rule — unknown key, missing or empty value,
 * non-finite number, a value containing \`/\`, and a channel value outside
 * letters, digits, \`_\` and \`-\` all throw. Inlined rather than
 * imported because importing it is the bundle cost this file exists to avoid;
 * the round-trip tests pin the emitted implementation to \`getPath()\` and
 * \`getChannel()\` alike. \`noun\` only names the thing in the error text.
 *
 * \`encode\` is the one place the two callers genuinely differ, and it mirrors
 * \`fillPathParams\` for the same reason: a route value is
 * percent-encoded so \`..\`/\`?\`/\`#\` stay inside their segment instead of
 * addressing a different endpoint, while a channel address is a literal string
 * in a JSON frame that nothing decodes on arrival.
 *
 * Emitted BEFORE the data, because an overload set must be immediately followed
 * by its own implementation.
 */
const FILL_PARAMS = `
/**
 * An own key only. Every lookup here is keyed by a caller's string, and a plain
 * object answers \`toString\`, \`constructor\` or \`hasOwnProperty\` from its
 * prototype — a name no route, channel or param carries would read as one.
 */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function fillParams(
  label: string,
  noun: string,
  template: string,
  params?: Record<string, string | number>,
  encode = false,
): string {
  const declared = [...template.matchAll(/\\{([^/{}]+)\\}/g)].map((m) => m[1]!);
  for (const key of Object.keys(params ?? {})) {
    if (!declared.includes(key)) {
      throw new Error(
        \`\${label}: \\\`\${key}\\\` is not a {param} of this \${noun}.\` +
          (declared.length ? \` Expected: \${declared.join(", ")}.\` : \` This \${noun} is static.\`),
      );
    }
  }
  const raw: Record<string, string> = {};
  const filled = template.replace(/\\{([^/{}]+)\\}/g, (_all, key: string) => {
    const value = own(params ?? {}, key);
    if (value === undefined || value === null || value === "") {
      throw new Error(\`\${label}: missing a value for the path param \\\`\${key}\\\`.\`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(\`\${label}: the path param \\\`\${key}\\\` is \${value}.\`);
    }
    const text = String(value);
    if (text.includes("/")) {
      throw new Error(
        \`\${label}: the path param \\\`\${key}\\\` cannot contain "/" — \` +
          \`it would address a different \${noun}.\`,
      );
    }
    if (!encode) {
      if (!/^[A-Za-z0-9_-]+$/.test(text)) {
        throw new Error(
          \`\${label}: the path param \\\`\${key}\\\` is "\${text}" — a \${noun} segment holds only \` +
            \`letters, digits, "_" and "-".\`,
        );
      }
      return text;
    }
    raw[key] = encodeURIComponent(text);
    return raw[key];
  });
  // A "." or ".." SEGMENT is REMOVED before routing (and takes the segment
  // before it), and the URL standard reads "%2e" as a dot for that check too.
  // Judged on the segment as sent, values encoded.
  if (encode) {
    for (const segment of template.split("/")) {
      if (!segment.includes("{")) continue;
      const assembled = segment.replace(/\\{([^/{}]+)\\}/g, (_all, key: string) => raw[key] ?? "");
      if (/^(\\.|%2e){1,2}$/i.test(assembled)) {
        throw new Error(
          \`\${label}: the path segment "\${segment}" cannot be "\${assembled}" — \` +
            \`a "." or ".." segment addresses a different \${noun}.\`,
        );
      }
    }
  }
  return filled;
}
`;

/**
 * The emitted `routePath`, which must directly follow its overload signatures.
 * With `ambiguous`, an unknown key that is an ambiguous short key names the
 * group-qualified keys to use instead.
 */
function implementation(ambiguous: boolean): string {
  const params = ambiguous ? "params?: Record<string, string | number> | string" : "params?: Record<string, string | number>";
  const hint = ambiguous
    ? `
  const qualified = own(AMBIGUOUS, name);
  if (qualified) {
    throw new Error(
      \`routePath: "\${String(name)}" is in more than one api group — use \${qualified.map((k) => \`"\${k}"\`).join(" or ")}.\`,
    );
  }`
    : "";
  return `
export function routePath(name: ${ambiguous ? "string" : "RouteName"}, ${params}): string {${hint}
  // Read through a widened view: a workspace with no endpoints at all makes
  // \`RouteName\` \`never\`, which cannot index the literal type.
  const route = own(ROUTES as Record<string, { verb: string; path: string }>, name);
  if (!route) {
    throw new Error(
      \`routePath: unknown route "\${String(name)}". Routes are keyed "<VERB> <name>", \` +
        'e.g. "GET listings" — regenerate the manifest if the endpoint is new.',
    );
  }
  return fillParams(\`routePath("\${String(name)}")\`, "route", route.path, params${ambiguous ? " as Record<string, string | number> | undefined" : ""}, true);
}
`;
}

/**
 * The emitted realtime accessors.
 *
 * \`channelPath\` reuses the same \`fillParams\` the routes use — one interpolator
 * in the file, so the two addressing rules cannot drift apart.
 *
 * \`socketPath\`/\`socketUrl\` mirror \`realtimeServer().getPath()\`/\`getUrl()\` rule
 * for rule: the scheme is normalized to \`ws\`/\`wss\` (a scheme-less host is
 * assumed secure), a \`/tenant/<name>\` prefix on the base URL is LIFTED into the
 * socket's \`<tenant>:<canonical>\` form rather than concatenated, and an explicit
 * \`tenant\` that disagrees with the one the base URL names throws instead of
 * picking a winner, and a base URL that already carries a \`/ws/<…>\` socket path
 * (an earlier \`socketUrl()\`/\`getUrl()\` result) throws rather than resolve twice.
 * That lift is the whole reason the realtime half is in the
 * manifest — the socket's colon form is not derivable from the HTTP URL a
 * frontend already holds.
 */
function realtimeImplementation(ambiguous: boolean): string {
  // An unambiguous manifest keys every channel by its own path, so it keeps the
  // shorter body — and committed manifests do not churn.
  if (!ambiguous) {
    return `
export function channelPath(name: ChannelName, params?: Record<string, string | number>): string {
  if (!own(CHANNELS as Record<string, unknown>, name)) {
    throw new Error(\`channelPath: unknown channel "\${String(name)}".\`);
  }
  return fillParams(\`channelPath("\${String(name)}")\`, "channel", String(name), params);
}
${REALTIME_IMPLEMENTATION}`;
  }
  return `
export function channelPath(name: string, params?: Record<string, string | number>): string {
  const qualified = own(AMBIGUOUS_CHANNELS, name);
  if (qualified) {
    throw new Error(
      \`channelPath: "\${String(name)}" is on more than one realtime server — use \${qualified.map((k) => \`"\${k}"\`).join(" or ")}.\`,
    );
  }
  const channel = own(CHANNELS as Record<string, { server: string; path?: string }>, name);
  if (!channel) {
    throw new Error(\`channelPath: unknown channel "\${String(name)}".\`);
  }
  return fillParams(\`channelPath("\${String(name)}")\`, "channel", channel.path ?? String(name), params);
}
${REALTIME_IMPLEMENTATION}`;
}

const REALTIME_IMPLEMENTATION = `
/** Reject a tenant name that would break the \\\`<tenant>:<canonical>\\\` split. */
function assertTenant(tenant: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(tenant)) {
    throw new Error(
      \`socketUrl: invalid \\\`tenant\\\` \${JSON.stringify(tenant)} — a tenant name is alphanumeric with \` +
        \`dashes (e.g. "xxxx-xxxx-xxxx"). It rides as a "<tenant>:<canonical>" prefix, so ":" and "/" \` +
        "cannot appear in it.",
    );
  }
  return tenant;
}

/** The websocket PATH — \\\`/ws/<canonical>\\\`, or \\\`/ws/<tenant>:<canonical>\\\`. */
export function socketPath(server: RealtimeServerName, opts?: { tenant?: string | undefined }): string {
  const entry = own(REALTIME_SERVERS as Record<string, { canonical: string }>, server);
  if (!entry) throw new Error(\`socketPath: unknown realtime server "\${String(server)}".\`);
  const prefix = opts?.tenant ? \`\${assertTenant(opts.tenant)}:\` : "";
  return \`/ws/\${prefix}\${entry.canonical}\`;
}

/** The absolute websocket URL — \\\`baseUrl\\\` + {@link socketPath}, scheme normalized to ws/wss. */
export function socketUrl(
  server: RealtimeServerName,
  baseUrl: string,
  opts?: { tenant?: string | undefined },
): string {
  if (!own(REALTIME_SERVERS as Record<string, unknown>, server)) {
    throw new Error(\`socketUrl: unknown realtime server "\${String(server)}".\`);
  }
  const base = (baseUrl ?? "").trim().replace(/\\/+$/, "");
  if (!base) throw new Error('socketUrl: needs a base URL (e.g. "https://x.dev.xano.io").');
  const socketBase = /^wss?:\\/\\//i.test(base)
    ? base
    : /^https?:\\/\\//i.test(base)
      ? base.replace(/^http/i, "ws")
      : \`wss://\${base}\`;
  // A base URL ending in \\\`/ws/<something>\\\` is this function's own output fed back
  // in. Appending a second \\\`/ws/<canonical>\\\` is wrong twice: the extra segments
  // join the connection hash, and the tenant is dropped (the first call already
  // consumed the \\\`/tenant/<name>\\\` prefix). Refuse rather than dial a bad URL.
  if (/\\/ws\\/[^/]+$/i.test(socketBase)) {
    throw new Error(
      \`socketUrl: \\\`baseUrl\\\` already carries a socket path (\${base}). Pass the http(s) \` +
        "INSTANCE base URL, not the result of a previous socketUrl()/getUrl() — resolving twice " +
        'appends a second "/ws/<canonical>" and drops the tenant.',
    );
  }
  // A query, a fragment or an API group's \\\`/api:<…>\\\` path is not an instance
  // base: the socket path appended after it never reaches the server.
  if (/[?#]/.test(base) || /\\/api:/i.test(base)) {
    throw new Error(
      \`socketUrl: \\\`baseUrl\\\` is not an instance base URL (\${base}). Pass "https://<host>" or \` +
        '"https://<host>/tenant/<name>" — no query, fragment or /api:<…> path.',
    );
  }
  // A tenant base URL names its tenant as its own path segment; the socket glues
  // it to the canonical inside one segment. Translate rather than concatenate —
  // the concatenated form never upgrades at all.
  const lifted = /^(wss?:\\/\\/[^/]+)\\/tenant\\/([^/]+)(\\/.*)?$/i.exec(socketBase);
  let origin = socketBase;
  let tenant = opts?.tenant;
  if (lifted) {
    const fromBase = lifted[2]!;
    if (tenant !== undefined && tenant !== fromBase) {
      throw new Error(
        \`socketUrl: given tenant \${JSON.stringify(tenant)} but the base URL names \` +
          \`\${JSON.stringify(fromBase)} (".../tenant/\${fromBase}"). Refusing to guess which one you \` +
          "meant — pass the matching tenant, or a base URL without the \\"/tenant/<name>\\" prefix.",
      );
    }
    origin = \`\${lifted[1]!}\${lifted[3] ?? ""}\`;
    tenant = assertTenant(fromBase);
  }
  return \`\${origin}\${socketPath(server, { tenant })}\`;
}
`;

/**
 * The manifest's file name, beside the backend's entry. The scaffold's
 * `xano:routes` script writes `xano/routes.gen.ts`, and a decode (`init --from`,
 * `pull`, `generate`) writes the same file into the tree it produces — so a
 * project fresh from a decode passes its own `routes --emit --strict` check
 * without a first `npm run xano:routes`, and a `pull` refreshes the file rather
 * than deleting it.
 */
export const ROUTES_MANIFEST_BASENAME = "routes.gen.ts";

/** One endpoint with its canonical, if one could be resolved. */
export interface PlannedRoute {
  verb: HttpVerb;
  name: string;
  canonical: string | undefined;
  /** The api group's name, which qualifies a key two groups share. */
  group?: string;
}

/**
 * What a manifest would carry for one exported payload, split into what
 * resolves and what does not.
 *
 * ONE reading of a payload, shared by `xanosdk routes --emit` (over a compiled
 * export) and the decode paths (over the source bundle a tree was generated
 * from). They must agree byte for byte: the decode writes the file that the
 * scaffold's `--strict` check later compares a fresh compile against, and two
 * readings is how a freshly pulled project goes red on its first CI run.
 */
export interface RoutePlan {
  /** Every endpoint, sorted by canonical then name. */
  rows: PlannedRoute[];
  resolved: RouteEntry[];
  unresolved: PlannedRoute[];
  /** Realtime servers with a resolvable canonical. */
  servers: RealtimeServerEntry[];
  /** Realtime servers whose canonical resolves nowhere — left out, with their channels. */
  unresolvedServers: string[];
  /** Channels of the servers in {@link RoutePlan.servers}. */
  channels: RealtimeChannelEntry[];
  /**
   * The request inputs of every route in {@link RoutePlan.resolved}, every
   * channel in {@link RoutePlan.channels}, and every message on one of those
   * channels, under the keys the rendered manifest uses. Planned here, beside
   * the keys, so every writer of the manifest reads inputs the one way it reads
   * routes.
   */
  inputs: RouteInputs;
}

/**
 * Plan the manifest for one payload. `locked` answers the lock's frozen
 * canonical for a name, for an object whose canonical is not in the payload
 * itself; an in-code canonical wins over it. Nothing is minted.
 */
export function planRouteManifest(
  payload: Readonly<Record<string, unknown>>,
  locked: (kind: "app" | "realtime_server", name: string) => string | undefined = () => undefined,
): RoutePlan {
  const list = (key: string): Array<Record<string, unknown>> =>
    Array.isArray(payload[key])
      ? (payload[key] as unknown[]).filter(
          (r): r is Record<string, unknown> => r !== null && typeof r === "object",
        )
      : [];
  const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const ref = (v: unknown): string | undefined =>
    v !== null && typeof v === "object" ? text((v as { id?: unknown }).id) : undefined;

  const canonicalByGuid = new Map<string, string>();
  const groupByGuid = new Map<string, string>();
  for (const a of list("app")) {
    const guid = text(a.guid);
    if (guid === undefined) continue;
    const name = text(a.name);
    if (name !== undefined) groupByGuid.set(guid, name);
    const resolved = text(a.canonical) ?? (name !== undefined ? locked("app", name) : undefined);
    if (resolved) canonicalByGuid.set(guid, resolved);
  }

  // Each planned row's stored `input[]`, by identity: the rows are the plan's
  // public shape, and the input rows are only read on the way to `inputs`.
  const storedInputs = new Map<object, unknown>();
  const rows: PlannedRoute[] = list("query").map((q) => {
    const group = ref(q.app);
    const row: PlannedRoute = {
      verb: q.verb as HttpVerb, // already an uppercase HttpVerb in the bundle
      // Match getPath(): the path segment drops any leading slash on the name.
      name: pathSegment(typeof q.name === "string" ? q.name : ""),
      canonical: group !== undefined ? canonicalByGuid.get(group) : undefined,
      ...(group !== undefined && groupByGuid.has(group) ? { group: groupByGuid.get(group)! } : {}),
    };
    storedInputs.set(row, q.input);
    return row;
  });
  rows.sort((a, b) => (a.canonical ?? "").localeCompare(b.canonical ?? "") || a.name.localeCompare(b.name));

  const serverNameByGuid = new Map<string, string>();
  const serverRows = list("realtime_server").flatMap((s) => {
    const name = text(s.name);
    if (name === undefined) return [];
    const guid = text(s.guid);
    if (guid !== undefined) serverNameByGuid.set(guid, name);
    return [{ name, canonical: text(s.canonical) ?? locked("realtime_server", name) }];
  });
  const servers = serverRows.flatMap((s) => (s.canonical ? [{ name: s.name, canonical: s.canonical }] : []));
  const describable = new Set(servers.map((s) => s.name));
  const channelGuids = new Map<object, string | undefined>();
  const channels = list("channel").flatMap((c) => {
    const name = text(c.name);
    if (name === undefined) return [];
    const serverGuid = ref(c.server);
    const server = serverGuid !== undefined ? serverNameByGuid.get(serverGuid) : undefined;
    // Drop the channels of a server that was left out — their socket address is
    // exactly what could not be resolved. (A channel pointing at a server this
    // workspace never registered cannot reach here: `export()` refuses it.)
    if (server === undefined || !describable.has(server)) return [];
    const channel: RealtimeChannelEntry = { name, server };
    channelGuids.set(channel, text(c.guid));
    storedInputs.set(channel, c.input);
    return [channel];
  });

  const resolved: RouteEntry[] = rows.flatMap((r) => {
    if (!r.canonical) return [];
    const entry: RouteEntry = { name: r.name, verb: r.verb, canonical: r.canonical, ...(r.group !== undefined ? { group: r.group } : {}) };
    storedInputs.set(entry, storedInputs.get(r));
    return [entry];
  });

  // Inputs, under the keys the renderer will give their routes and channels. A
  // message joins its channel by guid and takes that channel's key, so it is
  // dropped exactly when its channel is: an unresolved server, or a channel the
  // payload does not carry.
  const tables = tableColumns(payload);
  const routeInputs: RouteInputSet[] = keyRoutes(resolved).map(({ route, key }) => ({
    key,
    inputs: describeInputs(storedInputs.get(route), tables),
  }));
  const channelKeyByGuid = new Map<string, string>();
  const channelInputs: RouteInputSet[] = keyChannels(channels).map(({ channel, key }) => {
    const guid = channelGuids.get(channel);
    if (guid !== undefined) channelKeyByGuid.set(guid, key);
    return { key, inputs: describeInputs(storedInputs.get(channel), tables) };
  });
  const messageInputs: MessageInputSet[] = list("message").flatMap((m) => {
    const name = text(m.name);
    const guid = ref(m.channel);
    const channel = guid !== undefined ? channelKeyByGuid.get(guid) : undefined;
    if (name === undefined || channel === undefined) return [];
    return [{ key: `${channel} ${name}`, channel, name, inputs: describeInputs(m.input, tables) }];
  });
  // Code-unit order, unlike the ROUTES/CHANNELS sorts above (kept as committed
  // output has them): a module renders from this order, and a locale-dependent
  // one would make two machines write different bytes for one workspace.
  messageInputs.sort((a, b) => byCodeUnit(a.key, b.key));

  return {
    rows,
    resolved,
    unresolved: rows.filter((r) => !r.canonical),
    servers,
    unresolvedServers: serverRows.filter((s) => !s.canonical).map((s) => s.name),
    channels,
    inputs: { routes: routeInputs, channels: channelInputs, messages: messageInputs },
  };
}

/**
 * Why a plan with an unresolved api group writes no manifest, and the fix —
 * one wording for `routes`, `routes --emit` and the decode paths. `entry` is
 * the workspace entry the remedy's export runs on.
 */
export function unresolvedCanonicalMessage(unresolved: readonly { name: string }[], entry: string): string {
  const names = unresolved.map((r) => `"${r.name}"`).join(", ");
  const nul = process.platform === "win32" ? "NUL" : "/dev/null";
  return (
    `cannot resolve the api group's canonical URL token for ` +
    `${unresolved.length === 1 ? "the query" : `${unresolved.length} queries`} ${names}. Set an explicit ` +
    `\`apiGroup({ canonical })\`, or run \`xanosdk export ${entry} --out ${nul}\` once (it ` +
    `mints a unique canonical and freezes it in xano.lock, and writes the bundle nowhere), then re-run \`xanosdk routes\`.`
  );
}

/**
 * The manifest a plan renders to, or `undefined` when `routes --emit` would
 * write nothing for it: no endpoint and no resolvable realtime server. An
 * endpoint whose api group's canonical resolves nowhere is a
 * {@link RouteManifestError}: a manifest missing a route is worse than none,
 * and a silent skip leaves `--strict` failing with nothing saying why.
 */
export function renderPlannedManifest(plan: RoutePlan, entry = "<entry>"): string | undefined {
  if (plan.unresolved.length > 0) throw new RouteManifestError(unresolvedCanonicalMessage(plan.unresolved, entry));
  if (plan.resolved.length === 0 && plan.servers.length === 0) return undefined;
  return renderRouteManifest(
    plan.resolved,
    plan.servers.length > 0 ? { servers: plan.servers, channels: plan.channels } : undefined,
    plan.inputs,
  );
}
