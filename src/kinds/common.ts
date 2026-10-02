/**
 * Small shapes shared across object kinds: the empty middleware block and the
 * tag encoding (`["a","b"]` → `[{tag:"a"},{tag:"b"}]`).
 */
import type { StackItemXdo } from "../types/xdo.js";

export interface MiddlewareBlock {
  pre_customize: boolean;
  post_customize: boolean;
  /** Pre/post attachment entries — `mvp:middleware` stack items (see middleware-attach.ts). */
  pre: StackItemXdo[];
  post: StackItemXdo[];
}

export function emptyMiddleware(): MiddlewareBlock {
  return { pre_customize: false, post_customize: false, pre: [], post: [] };
}

export function encodeTags(tags: string[] | undefined): Array<{ tag: string }> {
  return (tags ?? []).map((tag) => ({ tag }));
}

export interface HistoryBlock {
  inherit: boolean;
  enabled: boolean;
  limit: number;
}

/**
 * Object kinds whose request-history default is OFF. Mirrors the engine's
 * request-history default:
 *   $defaultEnabled = !in_array($objType, ["function", "middleware", "trigger"]);
 * i.e. query/task/tool default ON, function/middleware/trigger default OFF —
 * confirmed against the live xdo corpus (query 44/44 `true`, function 4/4 `false`,
 * tool `true`).
 *
 * `message` (realtime) is off for a different reason than the rest: it is not a
 * legacy carve-out but a hot-path decision — its stored default is `false` at
 * every tier, object and container alike.
 */
const HISTORY_DEFAULT_OFF = new Set(["function", "middleware", "trigger", "message"]);

/** The default `history` block for an object kind (keyed by its payload/object type). */
export function defaultHistory(objType: string, override?: Partial<HistoryBlock>): HistoryBlock {
  return {
    inherit: override?.inherit ?? true,
    enabled: override?.enabled ?? !HISTORY_DEFAULT_OFF.has(objType),
    limit: override?.limit ?? 100,
  };
}
