/**
 * Addon-authoring encoder — the one place that turns an authored {@link AddonSpec}
 * into the stored `addon[]` block a db statement carries (the shape the engine's
 * addon import/export walk reads).
 *
 * Xano addons graft related-table data onto the rows a `db.query`/`db.get` (and
 * the other row-returning db ops) return. Each attached addon references a
 * reusable addon object, maps some of its inputs, optionally restricts its
 * output columns, and lands its result on the row under a dotted destination
 * (`offset` + `as`). Addons nest recursively.
 *
 * The authoring surface mirrors XanoScript's `addon = [{ name, as, input, output,
 * addon }]`, with two deliberate divergences:
 *
 * - the reference field is named `addon` (an {@link ObjectRef}), so the nesting
 *   field is named `children` to avoid the collision — which also matches the
 *   stored/export key;
 * - the target is a guid-native `ObjectRef`, resolved to a guid and emitted under
 *   the stored `id` key. In a packageExport bundle the engine matches addons by
 *   guid on import, so emitting the guid as `id` is correct
 *   — the same precedent `s.addon.call` uses.
 */
import type { Value } from "../../values/value.js";
import { resolveRef } from "../../refs/guid.js";
import type { ObjectRef } from "../../refs/guid.js";
import type { AddonDef } from "../../kinds/addon.js";
import { leanInput } from "../lean-input.js";
import type { LeanInput } from "../lean-input.js";
import { encodeOutputItems } from "./output-select.js";
import type { OutputItem } from "./output-select.js";

/**
 * One addon attached to a db statement.
 *
 * `as` is the dotted destination on the row (e.g. `"items._book"`); it splits at
 * the last dot into the stored `offset` (path prefix) + `as` (final segment).
 * `input` maps addon input names to values — bind parent-row columns with
 * {@link out} (`{ user_id: out("id") }`). `output` restricts the addon's returned
 * columns. `children` nests further addons (recursive).
 */
export interface AddonSpec<Graft = unknown> {
  /**
   * The target addon. A typed {@link AddonDef} handle (from {@link addon}) carries
   * its graft shape into the parent row's response type; a bare name/`ObjectRef`
   * resolves to a guid but grafts `unknown`.
   *
   * `null` is the UNBOUND attachment the engine stores as `id: ""` — an addon
   * that was deleted or never bound. It exists so `codegen` can reproduce such a
   * query faithfully instead of throwing and degrading the whole statement to
   * `raw()`; it grafts `unknown`, which is what an unbound target knows.
   */
  addon: ObjectRef | AddonDef<Graft> | null;
  /**
   * Dotted destination **relative to a returned row**, e.g. `"_book"` (a bare
   * alias) or `"obj._book"` (offset + alias). Splits at the last dot into the
   * stored `offset` (path prefix) + `as` (final segment). Do **not** hand-write
   * the `items[]` paging-envelope prefix — a `db.query` that returns a metadata
   * paging envelope adds it automatically (writing it explicitly is tolerated and
   * not double-prefixed).
   */
  as: string;
  /** Addon input bindings, name → value (use {@link out} for parent-row columns). */
  input?: Record<string, Value>;
  /** Restrict the addon's returned columns. Narrows the graft at runtime and in
   * the grafted type (to `output ∩ the addon's columns`). A dotted entry
   * (`"img.url"`) selects sub-keys of an object column; the graft narrows by the
   * root segment, since an object column's sub-keys are not declared. */
  output?: readonly string[];
  /** Nested addons (recursive). */
  children?: AddonSpec[];
  /**
   * Graft onto the paging ENVELOPE (beside `items`, once per response) instead
   * of onto each row. Only for a top-level addon on a `db.query` that returns
   * the paging envelope; `as` is then relative to the envelope and gets no
   * `items[]` prefix. For an addon that reads no row column — e.g. the caller's
   * own record via `auth("id")`.
   */
  envelope?: boolean;
}

/** The stored/export form of one attached addon. */
interface StoredAddon {
  id: string;
  as: string;
  offset?: string;
  input: LeanInput[];
  output?: { customize: true; items: OutputItem[] };
  children?: StoredAddon[];
}

/** Map an addon `input` object into the lean `{name,tag,value,filters}[]` form. */
function encodeInput(input?: Record<string, Value>): LeanInput[] {
  if (!input) return [];
  return Object.entries(input).map(([name, v]) => leanInput(name, v));
}

/**
 * Map an addon `output` column list into the customized-output block. Note this
 * omits the `filters:[]` key the parent statement's column-restriction envelope
 * carries — the engine's stored addon output has no `filters`.
 */
function encodeOutput(cols?: readonly string[]): StoredAddon["output"] {
  if (!cols?.length) return undefined;
  return { customize: true, items: encodeOutputItems(cols) };
}

/**
 * Split a dotted `as` at the last dot → `{ offset, as }` (offset omitted with no
 * dot). Rejects degenerate destinations — an empty string, a leading dot
 * (`.book`, empty offset), or a trailing dot (`book.`, empty alias) — since the
 * engine accepts them into the bundle but cannot graft the addon onto the row.
 */
function splitAs(as: string): { offset?: string; as: string } {
  if (!as) {
    throw new Error('addon: `as` must be a non-empty destination, e.g. "items._book" or "_book".');
  }
  const dot = as.lastIndexOf(".");
  if (dot === -1) return { as };
  const offset = as.slice(0, dot);
  const alias = as.slice(dot + 1);
  if (!offset || !alias) {
    throw new Error(
      `addon: \`as\` "${as}" has an empty offset or alias segment — use "offset.alias" (e.g. "items._book") or a bare alias ("_book").`,
    );
  }
  return { offset, as: alias };
}

/**
 * Prefix a paging-envelope offset (e.g. `"items[]"`) onto an addon's own offset.
 * When a `db.query` returns a metadata paging envelope, the rows live under
 * `items[]`, so a top-level addon must graft at `items[].<offset>` rather than at
 * the envelope root — the editor applies exactly this rule when it opens the
 * return-type picker. Idempotent: an offset that already starts with the prefix
 * (an author who wrote `items[]` explicitly) is left untouched, matching the
 * editor's own "already prefixed?" guard. A leading `items.` (the envelope key
 * spelled as a response path) is folded into the prefix, so `"items._x"` and
 * `"items[]._x"` store the same `offset:"items[]"`.
 */
function withEnvelopeOffset(offset: string | undefined, envelopeOffset: string): string {
  if (offset?.startsWith(envelopeOffset)) return offset;
  // `as:"items._x"` names the envelope's row list by its response key; it is the
  // same place as `items[]`, not a nested `items` column of each row.
  const root = envelopeOffset.slice(0, -2);
  if (offset === root) return envelopeOffset;
  if (offset?.startsWith(root + ".")) offset = offset.slice(root.length + 1);
  return [envelopeOffset, offset].filter(Boolean).join(".");
}

/**
 * Encode one addon spec into its stored form (recursing into `children`). `path`
 * carries the spec objects on the current branch so a spec that (transitively)
 * lists itself under `children` throws a clear error instead of recursing until
 * the stack overflows — near-impossible in normal authoring, but cheap to reject.
 *
 * `envelopeOffset` (top-level only) prefixes the paging-envelope path onto the
 * offset; nested `children` graft relative to their parent addon's result, not
 * the query envelope, so it is never threaded into the recursion.
 */
function encodeOne(
  spec: AddonSpec,
  path: readonly AddonSpec[],
  envelopeOffset?: string,
): StoredAddon {
  if (path.includes(spec)) {
    throw new Error("addon: `children` cannot reference an ancestor addon spec (cycle detected).");
  }
  const { offset, as } = splitAs(spec.as);
  if (spec.envelope !== undefined && typeof spec.envelope !== "boolean") {
    throw new Error(`addon "${spec.as}": \`envelope\` must be true or false — got ${JSON.stringify(spec.envelope)}.`);
  }
  if (spec.envelope === true && envelopeOffset === undefined) {
    throw new Error(
      `addon "${spec.as}": \`envelope: true\` grafts onto a db.query's paging envelope, and this attachment ` +
        "has none — only a top-level addon on a list query with paging (and metadata) on does. Drop `envelope`.",
    );
  }
  const finalOffset =
    envelopeOffset !== undefined && spec.envelope !== true ? withEnvelopeOffset(offset, envelopeOffset) : offset;
  const stored: StoredAddon = {
    // An unbound attachment stores a blank id — the same "no target" the engine
    // writes, and the same spelling `table: null` / `fn: null` already use.
    id: spec.addon === null ? "" : resolveRef("addon", spec.addon),
    as,
    input: encodeInput(spec.input),
  };
  if (finalOffset) stored.offset = finalOffset;
  const output = encodeOutput(spec.output);
  if (output !== undefined) stored.output = output;
  if (spec.children?.length) {
    const nextPath = [...path, spec];
    stored.children = spec.children.map((child) => encodeOne(child, nextPath));
  }
  return stored;
}

/**
 * Encode an authored addon list into the stored `addon[]` block. Returns `[]`
 * for an omitted/empty list, so callers pass it straight through to the
 * statement envelope (preserving the empty-`addon:[]` default byte-for-byte).
 *
 * `envelopeOffset` (e.g. `"items[]"`) is set by a `db.query` that returns a
 * metadata paging envelope, so top-level addons graft onto each row inside
 * `items[]` rather than the envelope object.
 */
export function encodeAddons(
  specs?: readonly AddonSpec[],
  envelopeOffset?: string,
): StoredAddon[] {
  if (!specs?.length) return [];
  return specs.map((spec) => encodeOne(spec, [], envelopeOffset));
}
