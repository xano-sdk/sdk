/**
 * A saved UNIT TEST — one entry of the `test[]` a query, function, or
 * middleware carries. This is the thing the Xano UI calls a unit test: a named
 * set of inputs, run against the object it hangs off, with assertions on the
 * response.
 *
 * ## Not `workflowTest()`
 *
 * A {@link ../kinds/workflow-test.js WorkflowTestDef} is a standalone top-level
 * object with its own stack that calls other objects. A unit test is a PROPERTY
 * of one object and has no stack of its own — the object under test is the
 * stack. The two never interact.
 *
 * ## Mocks live on the statements, not here
 *
 * A test can substitute a value for any statement in the object's stack, so the
 * step returns the mock instead of doing its work. That is authored on the
 * STATEMENT (`s.*(…, { mock: { "<test name>": … } })`) and keyed by this test's
 * name; see {@link ./test-mocks.js}.
 */
import { describeEntry } from "../statements/args.js";
import type { Value } from "../values/value.js";
import type { TestExpect } from "../values/expect.js";
import type { LeanInput } from "../statements/lean-input.js";
import { leanInput } from "../statements/lean-input.js";
import { deriveGuid } from "../refs/guid.js";

export interface TestDef {
  /**
   * The test's display name, unique within the object. It is also the key a
   * statement's `mock` map uses to name this test, which is why a duplicate is
   * refused rather than merged.
   */
  name: string;
  /**
   * Explicit stored `id` (this test's identity). Defaults to one derived from
   * the owning object and the test name; set it to keep identity across a
   * rename. A pulled test always carries the id Xano minted for it.
   */
  id?: string;
  description?: string;
  /**
   * Datasource to run against. `""` (the default) means an EMPTY datasource —
   * the recommended default for isolated runs. Any other value names a datasource
   * the engine **clones** before the test runs; `"live"` warns at encode time to
   * prevent cloning large production databases, but in ephemeral test environments
   * `datasource: "live"` is safe and allows running tests against `table({ seed })` rows.
   */
  datasource?: string;
  /**
   * The inputs to call the object with, by input name — the same tagged values
   * used everywhere else (`c.*`, `ref`, …), not plain JS scalars.
   */
  input?: Record<string, Value>;
  /**
   * The assertions, built with the top-level `expect.*` helpers — NOT
   * `s.expect.*`, which builds workflow-test statements. See
   * {@link ../values/expect.js}.
   */
  expect?: TestExpect[];
  /**
   * An auth token to run the test as an authenticated caller.
   *
   * Accepted so an authored test can supply one, but note that a pull does NOT
   * bring it back: a token is an expiring credential rather than authored
   * configuration, so `codegen` reports a stored one as a deliberate omission
   * instead of writing it into a committed tree.
   */
  token?: string;
}

/** The stored `mvp_test` shape. */
export interface TestXdo {
  datasource: string;
  description: string;
  expect: TestExpect[];
  id: string;
  input: LeanInput[];
  name: string;
  /**
   * Always emitted, blank when unset. The stored schema marks it optional, but a
   * live round trip shows the engine persists `""` regardless — omitting it read
   * as a failed round trip on every test.
   */
  token: string;
}

/**
 * The identity seed for a test's derived id.
 *
 * Scoped by the owning object because a test name is only unique WITHIN one
 * object — two queries may each have a "happy path". Ids never cross objects
 * (a statement's mock map is read against its own object's tests), so a
 * collision would be harmless, but a seed that cannot collide is one less thing
 * to reason about.
 */
export function testIdSeed(ownerKind: string, ownerName: string, testName: string): string {
  return `${ownerKind}/${ownerName}:${testName}`;
}

/** Encode one `TestDef` into the stored `mvp_test` shape. */
export function encodeTest(def: TestDef, ownerKind: string, ownerName: string): TestXdo {
  if (!def.name) throw new Error("test: `name` is required.");
  const owner = `${ownerKind} "${ownerName}" test "${String(def.name)}"`;
  if (def.input !== undefined && def.input !== null && (typeof def.input !== "object" || Array.isArray(def.input))) {
    throw new Error(`${owner}: \`input\` must be a { name: value } record — got ${describeEntry(def.input)}.`);
  }
  if (def.expect !== undefined && def.expect !== null && !Array.isArray(def.expect)) {
    throw new Error(`${owner}: \`expect\` must be a list of expectations — got ${describeEntry(def.expect)}.`);
  }
  const datasource = def.datasource ?? "";
  const xdo: TestXdo = {
    datasource,
    description: def.description ?? "",
    expect: def.expect ?? [],
    id: def.id ?? deriveGuid("test", testIdSeed(ownerKind, ownerName, def.name)),
    input: Object.entries(def.input ?? {}).map(([name, v]) => leanInput(name, v)),
    name: def.name,
    token: def.token ?? "",
  };
  return xdo;
}

/**
 * Encode an object's whole `test[]`, refusing a duplicate name.
 *
 * A duplicate is refused rather than tolerated because the name is the key a
 * statement's `mock` map resolves against: with two tests called "happy path"
 * there is no answer to which one a mock belongs to, and the engine would
 * silently apply it to whichever id won.
 */
export function encodeTests(
  defs: readonly TestDef[] | undefined,
  ownerKind: string,
  ownerName: string,
): TestXdo[] {
  if (defs === undefined || defs === null) return [];
  if (!Array.isArray(defs)) {
    throw new Error(`${ownerKind} "${ownerName}": \`tests\` must be a list of tests — got ${describeEntry(defs)}.`);
  }
  defs.forEach((def, i) => {
    if (typeof def !== "object" || def === null || Array.isArray(def)) {
      throw new Error(`${ownerKind} "${ownerName}": \`tests[${i}]\` must be a test ({ name, input, expect }) — got ${describeEntry(def)}.`);
    }
  });
  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.name)) {
      throw new Error(
        `${ownerKind} "${ownerName}": two tests are named "${def.name}". ` +
          `A test name is how a statement's \`mock\` names the test it belongs to, ` +
          `so names must be unique within an object. Rename one of them.`,
      );
    }
    seen.add(def.name);
  }
  return defs.map((def) => encodeTest(def, ownerKind, ownerName));
}

/**
 * Declare a saved unit test. Sugar for a plain object literal — use it for the
 * inferred type and the doc hover; `tests: [{ … }]` is equally valid.
 */
export function test(def: TestDef): TestDef {
  return def;
}
