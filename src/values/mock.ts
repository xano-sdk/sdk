/**
 * A statement's per-test MOCK — the value a step returns instead of doing its
 * work, when one specific test runs.
 *
 * Authored keyed by TEST NAME, which is what the Xano editor shows and what
 * XanoScript spells. The stored form is keyed by test ID; the rewrite happens
 * at kind-encode time, the only place that knows both the stack and the test
 * list (see `../kinds/test-mocks.js`).
 *
 * A mock applies ONLY while its test runs. It has no effect on a normal
 * request, so mocking a step does not change what the deployed endpoint does.
 */
import type { Value } from "./value.js";
import { describeEntry } from "../statements/args.js";

/**
 * One mock: a value, or a value plus `enabled`.
 *
 * The bare form means enabled. The object form exists so a mock can be kept
 * around switched off — the editor stores a disabled mock rather than deleting
 * it, and dropping it on encode would lose an authored artefact.
 */
export type MockEntry = Value | { value: Value; enabled?: boolean };

/** A statement's mocks, keyed by the name of the test each applies to. */
export type MockMap = Record<string, MockEntry>;

/** The stored `mvp_test_mock` shape. */
export interface MockXdo {
  value: string;
  tag: string;
  filters: unknown[];
  enabled: boolean;
}

function isWrapped(e: MockEntry): e is { value: Value; enabled?: boolean } {
  // `null`/a primitive (through `any`) is neither form; the check below names it.
  return typeof e === "object" && e !== null && typeof (e as { tag?: unknown }).tag !== "string";
}

/**
 * Encode an authored mock map, keys left as TEST NAMES.
 *
 * Deliberately does not resolve names to ids: a statement factory has no access
 * to the enclosing object's test list, and guessing would be worse than the
 * two-step. {@link ../kinds/test-mocks.js resolveMockKeys} finishes the job.
 */
export function encodeMockMap(mock: MockMap): Record<string, MockXdo> {
  const out: Record<string, MockXdo> = {};
  // A mock map is keyed by test NAME; a list or a string read as keys "0", "1", ….
  if (typeof mock !== "object" || mock === null || Array.isArray(mock)) {
    throw new Error(
      `\`mock\` must be a { "<test name>": value } record, keyed by the name of each test it applies to — got ${
        describeEntry(mock)
      }.`,
    );
  }
  for (const [testName, entry] of Object.entries(mock)) {
    const wrapped = isWrapped(entry);
    const value = wrapped ? entry.value : entry;
    if (typeof (value as { tag?: unknown } | null | undefined)?.tag !== "string") {
      throw new Error(
        `mock for test "${testName}": expected a tagged value (\`c.*\`/\`ref\`/…) or ` +
          `\`{ value, enabled }\`, got ${describeEntry(entry)}. A mock stores ` +
          `\`{value,tag,filters}\` copied off this argument, so a plain JS value ` +
          `encodes an empty mock that silently returns nothing when the test runs.`,
      );
    }
    out[testName] = {
      value: value.value,
      tag: value.tag,
      filters: value.filters,
      enabled: wrapped ? (entry.enabled ?? true) : true,
    };
  }
  return out;
}
