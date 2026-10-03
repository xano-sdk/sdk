/**
 * `rawWhere()` — a table view's filter carried through verbatim.
 *
 * The view-level member of the `raw*` escape hatches. A view's `expression` is
 * the same boolean tree `where` builds, so almost every stored one decodes to
 * `expr()`/`cmp()`/`and()`/`or()`. The rest — a filter row the editor added and
 * never gave an operator, for one — has no authored form, and dropping it would
 * widen what the view returns. This keeps the stored list exactly.
 *
 * Reached via `@xano/sdk/codegen`, never from the discoverable authoring
 * namespace, for the same reason `raw()` stays off `s`.
 */
import { describeEntry } from "../statements/args.js";

/** Marker for a view filter carried through verbatim. */
export const RAW_WHERE: unique symbol = Symbol.for("xanosdk.view.rawExpression") as never;

/** A stored view `expression` list, as `ViewDef.where` accepts it. */
export interface RawWhere {
  readonly [RAW_WHERE]: readonly unknown[];
}

/**
 * Carry a stored view `expression` list through encoding unchanged.
 *
 * @param expression The view's stored `expression` array.
 */
export function rawWhere(expression: readonly unknown[]): RawWhere {
  if (!Array.isArray(expression)) {
    throw new Error(
      `rawWhere() takes a view's stored \`expression\` list — got ${describeEntry(expression)}.`,
    );
  }
  return { [RAW_WHERE]: structuredClone(expression) };
}

/** Whether a view's `where` is a {@link rawWhere} passthrough. */
export function isRawWhere(value: unknown): value is RawWhere {
  return typeof value === "object" && value !== null && Object.hasOwn(value, RAW_WHERE);
}
