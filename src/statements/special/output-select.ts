/**
 * Column selection for a db read's `output` envelope — the `items[]` tree.
 *
 * The engine stores a selection as a **recursive** `{name, children}` tree: a
 * leaf (`children: []`) selects the whole column, and a node with children
 * selects only those keys of an object column. Real workspaces nest two deep
 * (an `obj` column's sub-keys), and nothing in the stored shape bounds the depth.
 *
 * The authoring surface is a flat list of **dotted paths** — `["id",
 * "password_reset.token", "password_reset.expiration"]` — which is exactly
 * isomorphic to that tree: nothing else is stored on a node, top-level names are
 * unique, and no real column name contains a dot. A flat list also keeps the
 * common (unnested) case identical to what it has always been, and keeps the
 * selection narrowable in the response type by its root segment.
 *
 * {@link encodeOutputItems} and {@link outputPaths} are inverses and live
 * together deliberately: `codegen` reads a stored tree back through
 * `outputPaths`, so a decoder cannot drift from the encoder whose bytes judge it.
 */

/** One node of the stored output-selection tree. */
export interface OutputItem {
  name: string;
  children: OutputItem[];
}

/**
 * A selectable output path: a column of the bound table, a dotted path (into an
 * object column, or into a joined table), or a field of the paging envelope.
 *
 * The bound table's schema is not the set of valid roots. A real query also
 * selects from joined tables (`photo.id`, `merchant.id`) and, when it is paged,
 * from the envelope wrapped around the rows (`itemsReceived`, `curPage`,
 * `items.title`) — none of which any table declares. Typed as bare columns, the
 * union rejected valid queries and a tree pulled from one did not compile.
 *
 * The bare-name arm stays CLOSED, so a typo is still an error. Only the two
 * forms that were provably wrong are open: see {@link QualifiedCol} for the
 * dotted root, and {@link PagingEnvelopeField} for the envelope.
 */
export type OutputPath<C extends string> = QualifiedCol<C> | PagingEnvelopeField;

/**
 * A column of the bound table, or a column of any OTHER table reached by a
 * dotted path.
 *
 * A dot at the root means the root is a table, not a column of this one:
 * `photo.id` reads the joined `photo`, and `comments.id` qualifies the bound
 * table by its own `tableAlias`, which is what Xano's editor writes. The SDK's
 * own docs say so — "joined columns are addressable by dotted path in
 * `where`/`sort`/`eval`" — and `SortDirective.sortBy` is documented as "the
 * column (or dot-path)". Both were typed as a bare column anyway, so 45 real
 * selections and sorts across 11 workspaces did not compile.
 *
 * The bare arm stays closed: a typo like `"emial"` is still an error, which is
 * where the union earns its keep. Nothing is given up by opening the dotted form,
 * because the engine has no other meaning for a dot at the root.
 *
 * ⚠ `comments.id` is only the bound table's own alias WHEN THE QUERY DECLARES ONE
 * (`tableAlias`) — that is why Xano's editor can write it and a hand-authored
 * query cannot. Without `tableAlias`, qualifying the bound table by its NAME does
 * not resolve, and the query fails at runtime; `db.query` checks the
 * `where`/`sort`/`eval` paths for it at export. Bare is the form to reach for.
 */
export type QualifiedCol<C extends string> = C | `${string}.${string}`;

/**
 * The roots an output selection may take when the read is PAGED: the rows under
 * `items`, and the counters the envelope wraps them in.
 *
 * A value, not just a type, because the build-time guard needs the same set — an
 * output tree rooted at a ROW while the statement binds the ENVELOPE selects
 * nothing at all, and the two readings of "what is the root here" must not drift
 * apart.
 */
export const PAGING_ENVELOPE_ROOTS = [
  "items",
  "itemsReceived",
  "itemsTotal",
  "curPage",
  "nextPage",
  "prevPage",
  "pageTotal",
  "offset",
  "perPage",
] as const;

/**
 * The fields a PAGED read adds around the rows. Selectable like a column and
 * declared by no table, so a paged query's `output` names them directly —
 * `items` whole keeps every row column.
 */
export type PagingEnvelopeField = (typeof PAGING_ENVELOPE_ROOTS)[number];

/** The root segment of a dotted output path — the column it selects from. */
export type OutputRoot<P extends string> = P extends `${infer Head}.${string}` ? Head : P;

/**
 * Build the stored `items[]` tree from a flat list of dotted paths, preserving
 * first-seen order at every level.
 *
 * Rejects a path with an empty segment, and rejects listing a column both whole
 * and partially (`["a", "a.b"]`) — the tree cannot hold both meanings, so
 * accepting it would silently drop the whole-column selection.
 */
export function encodeOutputItems(paths: readonly string[]): OutputItem[] {
  const roots: OutputItem[] = [];
  // Nodes reached by a full path, so a repeat path can be detected as a conflict
  // rather than resolved by position.
  const whole = new Set<string>();
  for (const path of paths) {
    const segments = path.split(".");
    if (segments.some((segment) => segment === "")) {
      throw new Error(
        `db output: "${path}" has an empty path segment — use "column" or "column.key".`,
      );
    }
    let level = roots;
    let walked = "";
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i]!;
      walked = walked === "" ? name : `${walked}.${name}`;
      let node = level.find((item) => item.name === name);
      if (!node) {
        node = { name, children: [] };
        level.push(node);
      } else if (whole.has(walked) || i === segments.length - 1) {
        // Either the ancestor was already selected whole and this path narrows
        // it, or this path selects whole something already narrowed.
        throw new Error(
          `db output: "${walked}" is selected both whole and by sub-key — list either "${walked}" ` +
            `or its "${walked}.<key>" paths, not both.`,
        );
      }
      if (i === segments.length - 1) whole.add(walked);
      level = node.children;
    }
  }
  return roots;
}

/**
 * Flatten a stored `items[]` tree back to the dotted paths that produce it, or
 * `null` when the tree holds something this surface cannot express: a node
 * without a string `name`, or a name containing a dot (which would re-encode as
 * two levels). Returning `null` lets the caller decline rather than emit an
 * authoring form that does not round-trip.
 */
export function outputPaths(items: unknown): string[] | null {
  if (!Array.isArray(items)) return null;
  const out: string[] = [];
  const walk = (list: readonly unknown[], prefix: string): boolean =>
    list.every((raw) => {
      if (raw === null || typeof raw !== "object") return false;
      const node = raw as { name?: unknown; children?: unknown };
      if (typeof node.name !== "string" || node.name === "" || node.name.includes(".")) return false;
      const path = prefix === "" ? node.name : `${prefix}.${node.name}`;
      const children = node.children;
      if (children === undefined || (Array.isArray(children) && children.length === 0)) {
        out.push(path);
        return true;
      }
      if (!Array.isArray(children)) return false;
      return walk(children, path);
    });
  return walk(items, "") ? out : null;
}
