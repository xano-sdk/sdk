/**
 * `c.expression("…")` — a Xano **Expression Engine** expression, carried through
 * verbatim. The string IS the expression, exactly as it would be typed into the
 * expression editor.
 *
 * ⚠️ THE STRING IS NOT VALIDATED. Xano SDK does not parse it, does not
 * type-check it, and cannot tell a working expression from a typo. Nothing
 * inside it participates in `InferResponse`, so a var referenced in the string
 * is invisible to the type system — renaming a var updates every typed `ref()`
 * and leaves this untouched. A malformed expression fails at RUNTIME; one that
 * is merely wrong (`$var.tota1`) returns a wrong answer instead of an error.
 * Play at your own risk until validation exists.
 *
 * So the ordering matters — reach for the typed surfaces FIRST:
 *
 *   references          ref() / inp() / col() / auth()
 *   transforms          withFilters(value, fl.*)
 *   dynamic objects     obj({...})   ← BUILDS a checked expression for you
 *   everything else     c.expression("...")   ← this file
 *
 * What actually needs it: expression-engine syntax the typed surfaces cannot
 * express — `~` string concatenation, inline arithmetic, conditionals.
 *
 * `c.expressionLegacy(...)` is the same passthrough for the older `const:expr`
 * form. It exists so codegen can bring back a workspace that still holds one —
 * do NOT author it. It is withheld from the value catalog in `llms.txt` and
 * named only in the `## Legacy` index, so it stays recognizable in pulled code
 * without being something to build with.
 */
import { defineFunction, s, c, inp, input, obj, ref } from "@xano/sdk";

export const constExpression = defineFunction({
  name: "ex_value_const_expression",
  input: {
    first_name: input.text({ required: true }),
    qty: input.int({ required: true }),
    unit_price: input.decimal({ required: true }),
  },
  stack: [
    // `~` is the engine's string-concatenation operator. No typed surface emits
    // it, which is exactly the case this constructor is for.
    s.set_var("greeting", c.expression('"Hello, " ~ $input.first_name ~ "!"')),

    // Inline arithmetic across two inputs — again, no filter chain equivalent
    // that reads as well.
    s.set_var("total", c.expression("$input.qty * $input.unit_price")),

    // COUNTER-EXAMPLE, and the one worth copying: this is a dynamic object, so
    // it goes through `obj()` — which renders the very same kind of expression,
    // but builds it from checked parts instead of a hand-written string.
    s.set_var("receipt", obj({ who: ref("greeting"), amount: ref("total"), qty: inp("qty") })),
  ],
  response: ref("receipt"),
});
