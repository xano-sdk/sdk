/**
 * The export checks `xanosdk compile <def>` runs over the one def it compiled.
 *
 * `compile` printed an artifact and nothing else, so a def that `export` would
 * warn about — or refuse under `--strict` — compiled clean. It now runs every
 * check that reads ONE def, over that def's encoded artifact. The checks that
 * relate objects to each other (an auth table the workspace registers, a
 * reference into another def, two routes shadowing) are left to `export`:
 * alone, every such reference looks dangling.
 */
import type { TableDef } from "../kinds/table.js";
import { getKind } from "../kinds/kind.js";
import { registerAllKinds } from "../kinds/all.js";
import { DiagnosticBag, type Diagnostic } from "../workspace/diagnostics.js";
import { standaloneDefKind } from "../workspace/xano.js";
import {
  checkDecodeOnlyStatements,
  checkExpressionOperands,
  checkInterpolatedValues,
  checkLoopControl,
  checkNonJsonValues,
  checkNullMatchArgs,
  checkPasswordInputHashing,
  checkZipPasswordKeys,
  checkPathSegmentCandidates,
  checkRegexOperandOrder,
  checkReservedColumnNames,
  checkReservedInputNames,
  checkRunFamilyHosts,
  checkLiveDatasourceTests,
  checkSafeRefMatchArgs,
  checkSearchOperandFilters,
  checkSeed,
  checkStacks,
  checkSwitchFallthrough,
  checkToThrowScope,
  checkUnboundVarRefs,
} from "../workspace/guards.js";
import { checkFilterOperands } from "../workspace/filter-operands.js";

/** The bundle section a compiled def sits in — the section `emit` encoded it for. */
function payloadKeyOf(def: object): string {
  registerAllKinds();
  const kind = standaloneDefKind(def);
  return kind === undefined ? "function" : getKind(kind).payloadKey;
}

/**
 * Run the per-def export checks over `artifact` (the encoded `def`). Warnings
 * go where export's do; under `strict` any finding fails, exactly as
 * `export --strict` would for this def. A def's own `diagnostics.allow` is
 * honoured. `raised` are the warnings the encoder raised while compiling it.
 */
export function checkCompiledDef(
  def: object,
  artifact: string,
  strict: boolean,
  raised: readonly Diagnostic[] = [],
): void {
  const encoded = JSON.parse(artifact) as Record<string, unknown>;
  const payloadKey = payloadKeyOf(def);
  const sections = { [payloadKey]: [encoded] };
  const tables = payloadKey === "dbo" ? [def as TableDef] : [];
  const allow = new Set((def as { diagnostics?: { allow?: readonly string[] } }).diagnostics?.allow ?? []);
  const bag = new DiagnosticBag(strict);
  // A table's column checks read the def itself rather than its encoding.
  bag.accepts = (code, subject) => (subject === encoded || subject === def) && allow.has(code);
  for (const d of raised) bag.warn(d.code, d.message, encoded);
  checkNonJsonValues(sections, bag);
  // No workspace config: a lone def cannot know what the workspace declares,
  // so its env reads are export's to judge.
  checkStacks(tables, sections, bag, {}, "authored");
  checkExpressionOperands(sections, bag);
  checkInterpolatedValues(sections, bag);
  checkRegexOperandOrder(sections, bag);
  checkDecodeOnlyStatements(sections, bag);
  checkRunFamilyHosts(sections, bag);
  checkLiveDatasourceTests(sections, bag);
  checkLoopControl(sections, bag);
  checkSwitchFallthrough(sections, bag);
  checkSearchOperandFilters(sections, bag);
  checkFilterOperands(sections, bag);
  checkUnboundVarRefs(sections, bag);
  checkToThrowScope(sections, bag);
  checkPasswordInputHashing(sections, bag);
  checkZipPasswordKeys(sections, bag);
  checkSafeRefMatchArgs(sections, bag);
  checkNullMatchArgs(sections, bag);
  checkPathSegmentCandidates(sections, bag);
  checkSeed(tables, bag);
  checkReservedColumnNames(tables, bag);
  checkReservedInputNames(sections, bag);
  bag.flush();
}
