/**
 * Aggregate `packageExport` bundle assembly. Mirrors the Xano engine's
 * package-migration format:
 *
 *   { app:"xano", version:"1.03", type, payload:{ partial, <kind keys...>, workspace }, sig }
 *
 * The `sig` is computed exactly as the engine's signature routine: sort the
 * top-level keys ({app,payload,type,version}), PHP-`json_encode` them, SHA1 the
 * bytes, and websafe-base64 the digest (`+/=` -> `-_.`, padding kept as `.`).
 * PHP `json_encode` escapes `/` and non-ASCII; we replicate that so the
 * signature bytes match. Byte-exact import compatibility verified against a
 * live engine import.
 */
import { sha1Bytes } from "../util/hash.js";
import { rawDeriveGuid } from "../refs/guid.js";
import { sdkKindName } from "../util/sdk-kind.js";
import { appNamesByGuid, displayLockKey, lockNameForObject } from "../lock/lock.js";
import type { LockFile } from "../lock/lock.js";
import { resolveDocumentationTokens } from "./documentation-token.js";
import { findNonJson, nonJsonMessage } from "./non-json.js";

export const BUNDLE_APP = "xano";
export const BUNDLE_VERSION_JSON = "1.03";

/** Bundle `type` (workspace | schema | content | share). */
export type BundleType = "workspace" | "schema" | "content" | "share";

/**
 * Canonical payload key order, matching the engine's partial-export order. Each kind's
 * encoded objects land under its key; unsupported sections stay empty arrays so
 * the bundle shape matches the engine's full export.
 */
export const PAYLOAD_ARRAY_KEYS = [
  "dbo",
  "addon",
  "function",
  "middleware",
  "trigger",
  "task",
  "query",
  "tool",
  // MCP prompts and resources: after `tool` and before `toolset`, because an MCP
  // server resolves its `prompts`/`resources` references by guid on import.
  "prompt",
  "resource",
  "toolset",
  "app",
  // Prose an agent reads, not an object anything resolves — it references
  // nothing and nothing references it, so its position is arbitrary.
  "knowledge",
  // A knowledge item's reference files. A CHILD section, not a kind of its own:
  // each row names its parent by guid, so knowledge must precede it.
  "knowledge_file",
  // Realtime, in dependency order: a channel resolves its server, and a message
  // resolves both. They sit after `app` so every object they can reference
  // (tables for auth, api groups) is already in place.
  "realtime_server",
  "channel",
  "message",
  // A container workload. Independent of every other object — nothing
  // references it and it references nothing — so its position is arbitrary.
  "microservice",
  "vault",
  "market_item",
  "run_install",
  "action_package_install",
  "env",
  "workflow_test",
  "service",
  "branch",
] as const;

export type PayloadArrayKey = (typeof PAYLOAD_ARRAY_KEYS)[number];

export interface BundlePayload {
  partial: boolean;
  workspace: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Bundle {
  app: string;
  version: string;
  type: BundleType;
  payload: BundlePayload;
  /** The compile read every knowledge body and found it empty — see `BuildBundleArgs.knowledgeRead`. */
  knowledge_read?: true;
  sig: string;
}

/**
 * Replicates the engine's canonical JSON encoding, which is what the
 * signature routine hashes. Its flags are
 * `JSON_HEX_QUOT | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS |
 *  JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE`, i.e.:
 *
 *   - `"` → `"`, `<` → `<`, `>` → `>`, `&` → `&`,
 *     `'` → `'` (the HEX_* flags — note PHP emits UPPERCASE hex here),
 *   - `/` and non-ASCII are left RAW (UNESCAPED_SLASHES/UNICODE),
 *   - other control chars (`< 0x20`) use the standard short escapes or
 *     lowercase `\u00xx`, exactly like PHP's default.
 *
 * The previous implementation post-processed `JSON.stringify` and instead
 * escaped `/` and non-ASCII (the inverse of the engine) and never applied the
 * HEX_* substitutions, so any bundle containing `'`, `"`, `<`, `>`, `&`, a
 * slash, or non-ASCII produced a signature the engine rejected with
 * "Invalid workspace signature". A structural encoder (rather than a regex over
 * `JSON.stringify` output) is used so the `"` → `"` substitution stays
 * correct around backslashes. Byte-verified against a live engine import.
 */
function phpEncodeString(str: string): string {
  let out = '"';
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '"': out += "\\u0022"; break; // JSON_HEX_QUOT
      case "\\": out += "\\\\"; break;
      case "<": out += "\\u003C"; break; // JSON_HEX_TAG
      case ">": out += "\\u003E"; break; // JSON_HEX_TAG
      case "&": out += "\\u0026"; break; // JSON_HEX_AMP
      case "'": out += "\\u0027"; break; // JSON_HEX_APOS
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      // PHP escapes the two line terminators even under JSON_UNESCAPED_UNICODE
      // — that flag is not JSON_UNESCAPED_LINE_TERMINATORS, which the engine
      // does not pass.
      case "\u2028": out += "\\u2028"; break;
      case "\u2029": out += "\\u2029"; break;
      default:
        // Control chars escape as lowercase `\u00xx`; everything else
        // (including `/` and multibyte unicode) is emitted raw.
        out += code < 0x20 ? "\\u" + code.toString(16).padStart(4, "0") : ch;
    }
  }
  return out + '"';
}

/**
 * The largest integer PHP holds as an int. Past it, `json_decode` under
 * `JSON_BIGINT_AS_STRING` hands back the digits as a STRING, which re-encodes
 * quoted.
 */
const PHP_INT_MAX = 9223372036854775807n;

/**
 * Format a number as the engine will RE-ENCODE it — that is, as
 * `json_encode(json_decode(<the bytes we wrote>, ..., JSON_BIGINT_AS_STRING))`.
 *
 * The signature is a byte comparison across two different serializers: we sign
 * the in-memory value, and the engine signs its own re-encoding of the bytes we
 * shipped. That holds only where the two agree, and for numbers they do not.
 * `JSON.stringify` is not PHP's float formatter:
 *
 *   - PHP goes exponential at decimal exponent `< -4`; JS waits until `1e-6`.
 *     So `0.0001` agrees and `0.00009` does not — the whole failure is that
 *     narrow, which is why most workspaces never see it and a sub-cent price,
 *     a basis-point rate or a probability breaks the deploy outright.
 *   - PHP's mantissa always carries a fraction (`1.0e-7`, never `1e-7`).
 *   - An integer past `PHP_INT_MAX` comes back quoted.
 *
 * The DIGITS are the same in both — both emit the shortest representation that
 * round-trips — so only the placement of the point and the mantissa's fraction
 * have to be modelled here.
 */
function phpEncodeNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = JSON.stringify(value);

  // Integer syntax. PHP parses it as an int, unless it overflows.
  if (!/[.eE]/.test(text)) {
    const n = BigInt(text);
    return n > PHP_INT_MAX || n < -PHP_INT_MAX - 1n ? `"${text}"` : text;
  }

  // Float syntax: same digits, PHP's shape. PHP prints a float plainly for a
  // decimal exponent in [-4, 17) and exponentially outside it; JS's own window
  // is [-6, 21), so the two disagree at both ends.
  const [mantissaText, exponentText] = Math.abs(value).toExponential().split("e") as [string, string];
  const exponent = Number(exponentText);
  if (exponent >= -4 && exponent < 17) return text;

  // The mantissa always carries a fraction: `1.0e-7`, never `1e-7`.
  const digits = mantissaText.replace(".", "").replace(/0+$/, "") || "0";
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : `${digits}.0`;
  const sign = exponent < 0 ? "-" : "+";
  return `${value < 0 ? "-" : ""}${mantissa}e${sign}${Math.abs(exponent)}`;
}

/** One unit of work: a value still to encode, or a literal already decided. */
type EncodeFrame = { readonly lit: string } | { readonly value: unknown };

/**
 * Iterative, like the guards' walkers, and for the same reason: what
 * is being crossed here is the author's own structure — a deep expression tree,
 * or a `raw()` envelope carrying whatever the engine handed back on a pull — and
 * a recursive encoder turns that into a bare `RangeError` at `export()`. Depth
 * belongs to the heap, not to whatever stack the platform happened to give the
 * main thread (Linux's default is roughly half of macOS's, which is why this
 * only ever failed in CI).
 *
 * Output is assembled by pushing frames back-to-front so they pop in document
 * order — a signature is a byte-for-byte comparison against what the engine
 * recomputes, so the emitted order is not free to change.
 */
export function phpJsonEncode(value: unknown): string {
  const out: string[] = [];
  const stack: EncodeFrame[] = [{ value }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if ("lit" in frame) {
      out.push(frame.lit);
      continue;
    }
    const current = frame.value;
    if (current === null || current === undefined) {
      out.push("null");
      continue;
    }
    switch (typeof current) {
      case "string":
        out.push(phpEncodeString(current));
        continue;
      case "number":
        out.push(phpEncodeNumber(current));
        continue;
      case "boolean":
        out.push(current ? "true" : "false");
        continue;
      case "object":
        break;
      default:
        out.push("null");
        continue;
    }
    if (Array.isArray(current)) {
      stack.push({ lit: "]" });
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push({ value: current[i] });
        if (i > 0) stack.push({ lit: "," });
      }
      stack.push({ lit: "[" });
      continue;
    }
    const obj = current as Record<string, unknown>;
    // Mirror JSON.stringify: object properties set to `undefined` are dropped.
    const keys = Object.keys(obj).filter((key) => obj[key] !== undefined);

    // An object whose keys are exactly "0".."n-1" IN ORDER comes back as a JSON
    // ARRAY, not an object. The engine decodes our bytes into PHP arrays, where
    // a decimal-integer key is an int key — and a PHP array holding 0..n-1 in
    // order re-encodes as a list. `{"0":"a"}` is therefore signed as `["a"]`.
    //
    // Reachable through any `json`/`object` column, whose seed cells pass
    // through as authored — an array-like object is exactly what a PHP-side
    // structure round-trips into. JS's own key ordering puts integer-like keys
    // first and ascending, and `JSON.stringify` writes the archive in that same
    // order, so what this tests is what the engine will read.
    if (keys.length > 0 && keys.every((key, i) => key === String(i))) {
      stack.push({ lit: "]" });
      for (let i = keys.length - 1; i >= 0; i--) {
        stack.push({ value: obj[keys[i]!] });
        if (i > 0) stack.push({ lit: "," });
      }
      stack.push({ lit: "[" });
      continue;
    }

    stack.push({ lit: "}" });
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      stack.push({ value: obj[key] });
      stack.push({ lit: phpEncodeString(key) + ":" });
      if (i > 0) stack.push({ lit: "," });
    }
    stack.push({ lit: "{" });
  }
  return out.join("");
}

// Xano's websafe base64 maps `+/=` to `-_.` — note it
// maps the padding `=` to `.` rather than stripping it (so it is NOT standard
// base64url). The engine recomputes and compares byte-for-byte, so the `.` must
// be preserved or the import fails with "Invalid workspace signature".
function base64websafe(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ".");
}

/** Replicates the engine's signature routine: sort top-level keys, encode, sha1, websafe base64. */
export function calcSignatureJson(exportObj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(exportObj).sort()) {
    sorted[key] = exportObj[key];
  }
  return base64websafe(sha1Bytes(phpJsonEncode(sorted)));
}

/**
 * Whether a signed envelope's `sig` matches its content, asked of the TEXT as
 * stored — before anything changes it, so a change is only re-signed over
 * content that was sound. An envelope with no `sig` is `undefined`: there was
 * nothing to hold.
 *
 * Checked twice, and either match holds. Over the parsed value, which is how
 * the SDK signs what it compiles. Then over the stored members' own text in
 * the engine's key order, because a parse loses what the engine hashed: a
 * decimal written `1.0` reads back as the number 1, and would fail a sound
 * export.
 */
export function signatureHolds(text: string): boolean | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const { sig, ...unsigned } = parsed;
  if (sig === undefined) return undefined;
  if (sig === calcSignatureJson(unsigned)) return true;
  const members = topLevelMembers(text);
  if (members === undefined) return false;
  const body = members
    .filter((m) => m.key !== "sig")
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((m) => `${m.rawKey}:${m.rawValue}`)
    .join(",");
  return sig === base64websafe(sha1Bytes(`{${body}}`));
}

/** An object's top-level members as their own source text; `undefined` when the text is not one. */
function topLevelMembers(text: string): { key: string; rawKey: string; rawValue: string }[] | undefined {
  const out: { key: string; rawKey: string; rawValue: string }[] = [];
  let i = text.indexOf("{");
  if (i === -1 || text.slice(0, i).trim() !== "") return undefined;
  i++;
  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const endOfString = (from: number): number => {
    let j = from + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return j;
  };
  skipWs();
  if (text[i] === "}") return out;
  while (i < text.length) {
    skipWs();
    if (text[i] !== '"') return undefined;
    const keyEnd = endOfString(i);
    const rawKey = text.slice(i, keyEnd + 1);
    i = keyEnd + 1;
    skipWs();
    if (text[i] !== ":") return undefined;
    i++;
    skipWs();
    const start = i;
    let depth = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"') i = endOfString(i);
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
      i++;
    }
    out.push({ key: JSON.parse(rawKey) as string, rawKey, rawValue: text.slice(start, i).trimEnd() });
    if (text[i] === "}") return out;
    i++;
  }
  return undefined;
}

export interface BuildBundleArgs {
  type?: BundleType;
  workspace?: Record<string, unknown>;
  /** Encoded objects keyed by their payload key (e.g. function, dbo, query). */
  sections: Partial<Record<PayloadArrayKey, unknown[]>>;
  /** When exporting under a lock: lets guid-collision errors name the lock entry. */
  lock?: LockFile;
  /**
   * Deploy-time workspace environment variables, merged OVER the authored
   * `workspaceConfig({ env })` before the bundle is signed.
   *
   * Merged here rather than patched into a finished bundle for two reasons that
   * both bite: the bundle is SIGNED, so a later mutation invalidates the
   * signature and the import fails; and the env the import actually reads is the
   * top-level `payload.env` the lift below produces, not `workspace.env`.
   *
   * The point is that a value need never be in the repo: declare the NAME in the
   * config with an empty value (so `env("NAME")` reads stay checkable) and
   * supply the value at deploy.
   */
  envOverrides?: Readonly<Record<string, string>>;
  /**
   * The Node compile read the knowledge bodies off disk. Stamped as the
   * top-level `knowledge_read` only when every body came out empty, so a file
   * whose bodies really are empty is not taken for one built without the read.
   * The engine signs top-level keys and reads nothing else from them.
   */
  knowledgeRead?: boolean;
}

/**
 * Guard against two objects sharing a guid. The guid is the engine's identity
 * anchor — it upserts by guid on import — so a collision silently makes one
 * object clobber the other. Identity derives from `(type, name)` (a query's
 * from `(group, verb, name)`, a realtime object's from its owner chain), so
 * the usual cause is two objects of the same kind composing the same identity.
 * Surface it loudly instead of shipping a lossy bundle.
 */
function assertUniqueGuids(payload: BundlePayload, lock?: LockFile): void {
  const seen = new Map<string, { label: string; key: string; obj: object }>();
  const appNames = appNamesByGuid((payload as Record<string, unknown>).app);
  for (const key of PAYLOAD_ARRAY_KEYS) {
    const arr = payload[key];
    if (!Array.isArray(arr)) continue;
    for (const obj of arr) {
      if (!obj || typeof obj !== "object") continue;
      const guid = (obj as { guid?: unknown }).guid;
      if (typeof guid !== "string") continue;
      const name = (obj as { name?: unknown }).name;
      const shown = typeof name === "string" ? name : "<unnamed>";
      // Named by the factory, not the storage key: an agent and an MCP server
      // are both stored as a `toolset`, and a pair read `"toolset/same"` twice.
      const label = `${sdkKindName(key, obj as { type?: unknown })} "${shown}"`;
      const held = seen.get(guid);
      const prev = held?.label;
      if (held !== undefined) {
        // With a lock in play the usual cause shifts: after a rename fix-up the
        // moved entry still pins the old name's derivation, so a NEW object
        // taking the old name re-derives the pinned guid. Point at the entry
        // rather than the misleading "two objects share a name."
        const pinnedBy = lock
          ? Object.entries(lock.objects).find(([, e]) => e.guid === guid)?.[0]
          : undefined;
        // The upgrade path this feature exists for: a lock written before query
        // identity was composed keys the endpoint `query:<name>`, and once a
        // SECOND query takes that name — the verb pair the user just added, the
        // whole point of the change — both fall through the legacy lookup onto
        // the one pinned guid. The generic rename-fix-up note is wrong here and
        // sends the reader looking for a rename nobody performed, so name the
        // migration instead: move the entry onto the composed identity of the
        // endpoint that already existed, and the newcomer derives its own.
        // Only a `query:` entry is that legacy shape — a table's `dbo:` entry
        // pinning a guid a query also sets is a cross-kind conflict (E2E pass 23).
        const legacyQueryKey =
          key === "query" &&
          held.key === key &&
          pinnedBy !== undefined &&
          pinnedBy.startsWith("query:") &&
          !pinnedBy.includes("|")
            ? pinnedBy
            : undefined;
        const lockNote = legacyQueryKey
          ? legacyQueryNote(legacyQueryKey, guid, [held.obj, obj], appNames, lock)
          : held.key !== key
            ? // Two kinds never derive one guid: one of them pins it (`guid:`) — a
              // lock entry holding it too is not a rename re-deriving a name's
              // guid, which only ever collides within a kind (E2E pass 22).
              ` Two different kinds cannot share one identity, and no name derives another kind's guid — ` +
              `an explicit \`guid\` set on one of them is the other's` +
              (pinnedBy ? ` — lock entry ${shownEntry(pinnedBy)} pins it` : "") +
              `. Remove the explicit guid, or set the one the object really has.`
            : pinnedBy
              ? sameKindPinnedNote(key, guid, pinnedBy, [held, { label, obj }], appNames)
              : // No guid-pin advice: a lock entry is keyed by name and holds ONE
              // guid, so two pinned guids under one name refuse at `export --lock`.
              key === "toolset"
              ? ` Agents and MCP servers share ONE name space (identity is derived from ` +
                `the name alone, across both kinds). Rename one.`
              : ` Object identity is derived from (type, name) — for a query, (api group, verb, ` +
                `name) — so two objects of the same kind compose the same identity. Rename one.`;
        const err = new Error(`Duplicate object guid (${guid}) shared by ${prev} and ${label}.` + lockNote);
        // Across kinds, the refusal `deploy --to` gives the same collision live:
        // tagged by shape, as this layer does not import the CLI's error types.
        if (held.key !== key) Object.assign(err, { code: "SDK_KIND_CONFLICT", exitCode: 2 });
        // Within a kind, a LOCK ENTRY pinning the guid is a conflict between the
        // lock and the source — re-running changes nothing until the lock entry
        // moves — so it exits 2 like every other "ran and disagreed". `lockEntry`
        // names the entry, so `lock rename` can tell that the source it evaluates
        // is broken by exactly the entry it was asked to move. A plain name clash
        // with no lock in play is an authoring mistake, and keeps exit 1.
        else if (pinnedBy !== undefined) {
          Object.assign(err, { code: "SDK_IDENTITY_CONFLICT", exitCode: 2, lockEntry: pinnedBy });
        }
        throw err;
      }
      seen.set(guid, { label, key, obj });
    }
  }
}

/**
 * Two objects of one kind on a guid a lock entry pins, told apart by how the
 * second one got it. A `lock rename` leaves the moved entry pinning the OLD
 * name's derivation, so a new object taking the old name re-derives it: one of
 * the pair derives the guid from its own name, under a key the entry is not.
 * Otherwise nothing derived it — an explicit `guid` set on one object is the
 * entry's (E2E pass 25 blamed a rename nobody performed).
 */
function sameKindPinnedNote(
  payloadKey: string,
  guid: string,
  pinnedBy: string,
  pair: readonly { label: string; obj: object }[],
  appNames: ReadonlyMap<string, string>,
): string {
  const keyOf = (obj: object): string | undefined => {
    const name = (obj as { name?: unknown }).name;
    return typeof name === "string" ? `${payloadKey}:${lockNameForObject(payloadKey, obj as { name: string }, appNames)}` : undefined;
  };
  const rederives = pair.find(({ obj }) => {
    const k = keyOf(obj);
    return k !== undefined && k !== pinnedBy && rawDeriveGuid(k) === guid;
  });
  if (rederives !== undefined) {
    return (
      ` This guid is pinned by lock entry ${shownEntry(pinnedBy)} — that entry was moved by ` +
      `\`xanosdk lock rename\`, and ${rederives.label} now re-derives the old name's guid. Pin a ` +
      `distinct explicit \`guid\` on ${rederives.label}, or update the lock entry.`
    );
  }
  const other = pair.find(({ obj }) => keyOf(obj) !== pinnedBy);
  return (
    ` This guid is pinned by lock entry ${shownEntry(pinnedBy)}, and no name derives it for ` +
    `${other?.label ?? "the other object"} — an explicit \`guid\` set on it is that entry's. Remove the explicit ` +
    `guid, or set the one the object really has.`
  );
}

/**
 * A lock key in a message: the SDK's spelling every command prints and
 * accepts, and — when the file stores it differently (`dbo:`, `app:`) — the
 * spelling to search xano.lock for (E2E pass 24).
 */
function shownEntry(key: string): string {
  const shown = displayLockKey(key);
  return shown === key ? `"${key}"` : `"${shown}" (stored as "${key}" in xano.lock)`;
}

/**
 * The remedy for a legacy name-only `query:<name>` lock entry that two queries
 * (a verb pair, or one name in two groups) now both claim.
 *
 * The entry belongs to the endpoint that existed when the lock was written, and
 * the one place that says which is the landing record: a deploy or release
 * records each landed query under its COMPOSED key with the guid it landed as.
 * Registration order says nothing — the newcomer is wherever the author put it
 * — so without a record both commands are printed with how to choose.
 */
function legacyQueryNote(
  legacyKey: string,
  guid: string,
  claimants: readonly object[],
  appNames: ReadonlyMap<string, string>,
  lock: LockFile | undefined,
): string {
  const oldName = legacyKey.slice("query:".length);
  const names = claimants.map((o) => lockNameForObject("query", o as { name: string }, appNames));
  const landed = new Set<string>();
  for (const record of Object.values(lock?.landed ?? {})) {
    for (const [k, e] of Object.entries(record)) if (e.guid === guid) landed.add(k);
  }
  const existing = names.filter((n) => landed.has(`query:${n}`));
  const command = (n: string): string => `\`xanosdk lock rename query ${oldName} "${n}"\``;
  const which =
    existing.length === 1
      ? `"${existing[0]}", which this guid landed as: ${command(existing[0]!)}`
      : `the endpoint deployed before the other was added (no landing record says which): ` +
        names.map(command).join(" or ");
  return (
    ` Lock entry "${legacyKey}" pins it by NAME ALONE — a lock written before a ` +
    `query's identity included its api group and verb. Both of these queries claim it. ` +
    `Move it onto the one that already existed — ${which} (from the project root or the lock's ` +
    `directory; elsewhere add \`--lock=<path>\`), then re-export: that endpoint keeps its identity ` +
    `and the newcomer derives its own.`
  );
}

/**
 * A signed `type:"content"` envelope — the shape each `content/<guid>-<page>.json`
 * archive entry holds. Unlike a workspace {@link Bundle} (whose `payload` is the
 * keyed object), a content payload is a plain array of table rows the engine
 * inserts on import. Signed by the identical routine, so the engine accepts it.
 */
export interface ContentEnvelope {
  app: string;
  version: string;
  type: "content";
  payload: unknown[];
  sig: string;
}

/**
 * Wrap one page of seed rows as a signed `type:"content"` envelope. The rows are
 * emitted verbatim (already coerced to their wire shape by the caller); the sig
 * is computed over `{app,payload,type,version}` exactly as {@link buildBundle}
 * signs a workspace bundle, so both ride the same byte-exact signature routine.
 */
export function buildContentEnvelope(rows: unknown[]): ContentEnvelope {
  const unsigned = {
    app: BUNDLE_APP,
    version: BUNDLE_VERSION_JSON,
    type: "content" as const,
    payload: rows,
  };
  return { ...unsigned, sig: calcSignatureJson(unsigned) };
}

/**
 * Fold deploy-time overrides into the authored env list.
 *
 * A declared name keeps its position and takes the new value; an undeclared one
 * is appended. Returns the input untouched when there is nothing to merge, so an
 * unconfigured workspace does not gain an `env` key it never had.
 */
function mergeEnvOverrides(
  authored: unknown,
  overrides: Readonly<Record<string, string>> | undefined,
): unknown {
  if (!overrides || Object.keys(overrides).length === 0) return authored;
  const list = Array.isArray(authored)
    ? (authored as Array<Record<string, unknown>>).map((e) => ({ ...e }))
    : [];
  const byName = new Map(list.map((e) => [String(e.name), e]));
  for (const [name, value] of Object.entries(overrides)) {
    const prior = byName.get(name);
    if (prior) prior.value = value;
    else list.push({ name, value, market_item: [] });
  }
  return list;
}

/** Assemble a signed `packageExport` bundle from encoded sections. */
/**
 * The backstop behind `checkNonJsonValues` for a `buildBundle` reached directly:
 * a function in a signed bundle is a value JSON silently writes as `null`, a
 * Date one it rewrites as a string, a Map one it empties.
 */
function assertNoFunctions(payload: BundlePayload): void {
  for (const [key, section] of Object.entries(payload)) {
    for (const obj of Array.isArray(section) ? section : [section]) {
      const found = findNonJson(obj);
      if (found === undefined) continue;
      const name = (obj as { name?: unknown } | null)?.name;
      const owner = `${key} "${typeof name === "string" ? name : "?"}"`;
      // The export guard's spelling: the object, then the field path under it.
      throw new Error(nonJsonMessage(owner, found.path === "" ? owner : `${owner}, at ${found.path}`, found.value));
    }
  }
}

export function buildBundle(args: BuildBundleArgs): Bundle {
  // The import applies workspace env vars from the TOP-LEVEL `payload.env` array,
  // not from the workspace object's own `env` field (which the import ignores).
  // Lift any authored env off the workspace object so it lands where the import
  // reads it; leave `workspace.env` empty to avoid duplicating values in the bundle.
  // (Verified against a live engine round-trip — the offline shape check can't see this.)
  // No bundle escapes carrying a documentation-token REFERENCE. `Xano.export`
  // resolves them from `xano/.env` before the guards run, but `buildBundle` is
  // also reachable directly — and an unresolved marker written into a signed
  // artifact is a key the engine would store and serve as the real gate. Any
  // reference still standing here means nothing supplied it, so the block is
  // dropped rather than sent with an empty token: a `deploy --bundle` on
  // such an artifact has no source left to classify, so an empty token there
  // would clear a live gate with no refusal able to fire.
  const swept = resolveDocumentationTokens({
    workspace: (args.workspace ?? {}) as Record<string, unknown>,
    apiGroups: args.sections.app,
    values: {},
  });
  const sections =
    swept.apiGroups === undefined ? args.sections : { ...args.sections, app: swept.apiGroups };
  const workspace: Record<string, unknown> = swept.workspace;
  const wsEnv = mergeEnvOverrides(workspace.env, args.envOverrides);
  // Always a WHOLE-workspace bundle. The engine's format carries the flag and
  // its import path reads it, but this SDK's flow is all-or-nothing in both
  // directions — pull the workspace, deploy the workspace — so there is no
  // scoped export to build and no option to ask for one.
  const payload: BundlePayload = { partial: false, workspace };
  for (const key of PAYLOAD_ARRAY_KEYS) {
    payload[key] = sections[key] ?? [];
  }
  // Only relocate when there are actual env vars — leave an unconfigured/empty
  // workspace object untouched (don't inject an `env` key it never had).
  if (Array.isArray(wsEnv) && wsEnv.length > 0) {
    payload.env = wsEnv;
    workspace.env = [];
  }
  assertUniqueGuids(payload, args.lock);
  assertNoFunctions(payload);
  const unsigned = {
    app: BUNDLE_APP,
    version: BUNDLE_VERSION_JSON,
    type: args.type ?? ("workspace" as BundleType),
    payload,
    ...(args.knowledgeRead === true && knowledgeBodiesAllEmpty(payload) ? { knowledge_read: true as const } : {}),
  };
  return { ...unsigned, sig: calcSignatureJson(unsigned) };
}

/**
 * Knowledge items that all carry an empty body and no reference files — what a
 * bundle built without the Node compile holds, and what `knowledge_read` tells
 * apart from an authored empty body.
 */
export function knowledgeBodiesAllEmpty(payload: Record<string, unknown>): boolean {
  const knowledge = Array.isArray(payload.knowledge) ? (payload.knowledge as Array<Record<string, unknown> | null>) : [];
  const files = Array.isArray(payload.knowledge_file) ? payload.knowledge_file.length : 0;
  return knowledge.length > 0 && files === 0 && knowledge.every((k) => k?.content === "");
}
