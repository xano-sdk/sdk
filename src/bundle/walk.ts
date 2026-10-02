/**
 * Statement-tree traversal for a compiled bundle.
 *
 * A stack is a `run[]` of {@link StackItemXdo} envelopes, and a statement that
 * nests carries its children under `context` — never under a single key. A
 * conditional stores `if.run` / `elif.run` / `else.run`, a try/catch reuses the
 * same three keys for `try` / `catch` / `finally`, a switch stores its cases
 * under `elif.run` and its default under `else.run`, and every loop, group and
 * transaction stores a bare `context.run`.
 *
 * A tool that hardcodes that key set drops a subtree silently the day the engine
 * adds a nesting shape, so {@link subStacks} does not hardcode it: it finds a
 * sub-stack by SHAPE — any `context` member that is a `{run: [...]}` object,
 * plus `context.run` itself. {@link SUB_STACK_KEYS} is exported as the set known
 * today, and it fixes the ORDER discovery reports; a key outside it is still
 * found, reported after the known ones, in `context` order.
 */

import type { StackItemXdo } from "../types/xdo.js";

/**
 * The `context` keys that hold a nested stack today, in the order
 * {@link subStacks} reports them. The order is the authoring order for every
 * statement that nests: `if` before `elif` before `else` for a conditional,
 * try before catch before finally for a try/catch, cases before default for a
 * switch.
 *
 * This is a reference set, not a filter — see the module note.
 */
export const SUB_STACK_KEYS: readonly string[] = ["if", "elif", "else", "then", "run"];

/**
 * The authoring name of each sub-stack, per stored statement. The engine's key
 * says where the bytes live; the label says what the branch MEANS, and the two
 * disagree wherever a statement reuses a generic key — `try_catch.else` is the
 * catch block, `switch.elif` is the case list.
 */
const SUB_STACK_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "mvp:conditional": { if: "then", elif: "elif", else: "else" },
  "mvp:conditional_elif": { if: "then" },
  "mvp:switch": { elif: "cases", else: "default" },
  "mvp:switch_case": { if: "body" },
  "mvp:try_catch": { if: "try", else: "catch", then: "finally" },
};

/** One nested stack hanging off a statement's `context`. */
export interface SubStack {
  /** The `context` key the stack is stored under (`if`, `elif`, `else`, `then`, `run`). */
  readonly key: string;
  /**
   * What the branch means at the authoring surface — `try`/`catch`/`finally` for
   * a try/catch, `cases`/`default` for a switch, `body` for a loop. Falls back
   * to the key for a statement with no recorded mapping.
   */
  readonly label: string;
  /** The nested statements, in run order. */
  readonly run: readonly StackItemXdo[];
}

/** A statement reached by {@link walk}, with its address and nesting depth. */
export interface WalkedStatement {
  /** The statement envelope, by reference — not a copy. */
  readonly raw: StackItemXdo;
  /**
   * The statement's address within the stack it was walked from — see
   * {@link statementPath}. `"2"` is the third top-level statement; `"2.if.0"` is
   * the first statement of its `if` branch.
   */
  readonly path: string;
  /** Nesting depth: `0` for a top-level statement, `1` inside one sub-stack, and so on. */
  readonly depth: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The `run[]` a `context` member holds, or `null` if it is not a sub-stack. */
function runOf(value: unknown): readonly StackItemXdo[] | null {
  if (!isRecord(value)) return null;
  const run = value.run;
  return Array.isArray(run) ? (run as StackItemXdo[]) : null;
}

/**
 * Every nested stack a statement carries, in canonical order.
 *
 * Returns an empty array for a leaf statement. A sub-stack stored empty
 * (`elif: {run: []}`, which the engine always persists on a conditional) is
 * REPORTED with an empty `run` rather than skipped — the branch exists in the
 * bytes, and a tool that renders branches wants to know the difference between
 * "no elif" and "an elif that does nothing".
 */
export function subStacks(raw: StackItemXdo): SubStack[] {
  const context = raw?.context;
  if (!isRecord(context)) return [];
  const labels = (Object.hasOwn(SUB_STACK_LABELS, raw.name) ? SUB_STACK_LABELS[raw.name] : undefined) ?? {};

  const found: SubStack[] = [];
  const push = (key: string, value: unknown): void => {
    const run = key === "run" ? (Array.isArray(value) ? (value as StackItemXdo[]) : null) : runOf(value);
    if (!run) return;
    found.push({ key, label: labels[key] ?? (key === "run" ? "body" : key), run });
  };

  for (const key of SUB_STACK_KEYS) {
    if (Object.hasOwn(context, key)) push(key, context[key]);
  }
  // Anything the engine nests under a key this SDK has not seen. Reported after
  // the known keys so adding one later cannot reorder an existing bundle's paths.
  for (const key of Object.keys(context)) {
    if (!SUB_STACK_KEYS.includes(key)) push(key, context[key]);
  }
  return found;
}

/**
 * Join path segments into a statement path.
 *
 * The format is dot-separated, alternating an index with the `context` key that
 * contains the next level: `2` is the third top-level statement, `2.if.0` is the
 * first statement of its `if` branch, `2.elif.0.if.1` is the second statement of
 * its first elif branch. The KEY is used, not the label, so the path addresses
 * the stored bytes and stays stable if an authoring name changes.
 *
 * One shared address is the point: a lint finding, a review comment and a
 * runtime error written by three different tools all name the same node.
 */
export function statementPath(segments: readonly (string | number)[]): string {
  return segments.join(".");
}

/**
 * Walk a stack depth-first in pre-order — every statement, then its sub-stacks
 * in {@link subStacks} order.
 *
 * A statement that is itself a branch carrier (`mvp:conditional_elif`,
 * `mvp:switch_case`) is a stack item like any other, so it is VISITED and then
 * descended into. A tool counting statements should filter those out; a tool
 * addressing nodes wants them present.
 *
 * Iterative rather than recursive: a generated stack can nest deep enough to
 * blow the call stack, and a bundle reader must not be the thing that crashes.
 */
export function walk(run: readonly StackItemXdo[]): WalkedStatement[] {
  const out: WalkedStatement[] = [];
  // Stack of pending frames, popped LIFO — children pushed in reverse so they
  // come back out in run order.
  const pending: { raw: StackItemXdo; path: string; depth: number }[] = [];
  for (let i = run.length - 1; i >= 0; i--) {
    pending.push({ raw: run[i]!, path: statementPath([i]), depth: 0 });
  }

  while (pending.length > 0) {
    const frame = pending.pop()!;
    out.push(frame);
    const children: { raw: StackItemXdo; path: string; depth: number }[] = [];
    for (const sub of subStacks(frame.raw)) {
      for (let i = 0; i < sub.run.length; i++) {
        children.push({
          raw: sub.run[i]!,
          path: statementPath([frame.path, sub.key, i]),
          depth: frame.depth + 1,
        });
      }
    }
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
  }
  return out;
}
