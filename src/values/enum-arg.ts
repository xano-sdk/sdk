/**
 * Filter arguments with a closed set of accepted spellings — and the guard that
 * refuses one outside it.
 *
 * The generated signature already narrows these to a literal union, which
 * catches `fl.fsort("score", "decimal")` at compile time. It cannot catch
 * `fl.fsort(c.text("score"), c.text("decimal"))`, because a `Value` is a `Value`
 * — and that spelling is not exotic: it is what every example in the wild is
 * written as, and what codegen emits.
 *
 * Refusing the value does not make a pulled workspace holding one
 * un-exportable. When a guard refuses a filter, codegen falls back to the
 * degraded `{name, disabled, arg}` literal, which re-encodes byte-identically
 * and never reaches this choke point — the same path the `fl.transform` guard
 * already takes. So the round trip is preserved without the
 * authoring surface having to accept a value that silently misbehaves.
 *
 * Why it is worth refusing at all: the engine accepts every spelling here. It
 * does not validate, error, or warn — an unrecognized comparator falls through
 * to `itext` and sorts numbers as text. A lexicographic sort agrees with a
 * numeric one whenever the values share a digit count, so the mistake survives
 * small test data and shows up as a "top N" endpoint returning the right rows
 * in the wrong order.
 */
import type { Value } from "./value.js";

/** One enumerated argument: where it sits, what it accepts, and what to say. */
interface EnumArg {
  /** Positional slot, which is what `filter()` sees — it has no argument names. */
  readonly slot: number;
  /** The argument's name, for the message. */
  readonly arg: string;
  /** Every spelling the SDK accepts. */
  readonly members: readonly string[];
  /** Appended to the message: why the wrong spelling is worth refusing here. */
  readonly why: string;
}

/**
 * Filter → its enumerated argument.
 *
 * Mirrors `ARG_ENUMS` in `scripts/codegen-filters.ts`, which is what the emitted
 * signature narrows from; `test/values/filters.test.ts` asserts the two agree,
 * so an enum added there cannot ship without a runtime guard behind it. A table
 * rather than a special case, for the same reason.
 */
export const ENUM_ARG_FILTERS: Readonly<Record<string, EnumArg>> = {
  fsort: {
    slot: 1,
    arg: "type",
    members: ["text", "itext", "natural", "inatural", "number"],
    why:
      'The engine accepts any spelling here and validates none of them: an unrecognized comparator falls through ' +
      'to "itext" and sorts numbers as TEXT, so the array comes back in the wrong order with no error. Only ' +
      '"number" compares numerically.',
  },
};

/**
 * Refuse an enumerated argument the SDK does not recognize.
 *
 * Fires only on an INSPECTABLE argument — an unfiltered `const` string. A
 * `ref`, an input binding, or a filtered value carries no text to read, and a
 * guard that fired on those would be guessing. An EMPTY argument is left alone:
 * the editor stores an unset dropdown that way, and a pulled workspace holding
 * one has to keep round-tripping.
 */
export function assertEnumFilterArgs(name: string, args: ReadonlyArray<Value | undefined>): void {
  const spec = (Object.hasOwn(ENUM_ARG_FILTERS, name) ? ENUM_ARG_FILTERS[name] : undefined);
  if (spec === undefined) return;
  const arg = args[spec.slot];
  if (!isInspectableConst(arg) || arg.value === "") return;
  if (spec.members.includes(arg.value)) return;
  throw new Error(
    `fl.${name}: \`${spec.arg}\` is ${JSON.stringify(arg.value)}, which is not one of ` +
      `${spec.members.map((m) => JSON.stringify(m)).join(", ")}. ${spec.why}`,
  );
}

/** An argument whose text can be read at all: an unfiltered `const` string. */
function isInspectableConst(arg: unknown): arg is Value & { value: string } {
  return (
    typeof arg === "object" &&
    arg !== null &&
    (arg as Value).tag === "const" &&
    typeof (arg as Value).value === "string" &&
    ((arg as Value).filters?.length ?? 0) === 0
  );
}
