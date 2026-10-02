/**
 * Which SDK kind a toolset guid was bound as, this process — `mcpServer` or
 * `agent`.
 *
 * Both are stored as one `toolset` type, so a reference to one that is not
 * registered could only be reported as "references toolset …, field
 * `mcpServer`/`agent`" — the engine's word and both fields. The trigger factory
 * that bound the guid knows which it took; it records it here. A hint for error
 * text only, like the guid seed hints — never read for resolution.
 */
export type ToolsetField = "mcpServer" | "agent";

const BOUND_AS = new Map<string, ToolsetField>();

/** Record that `guid` was bound through the trigger field `field`. */
export function noteToolsetTarget(guid: string, field: ToolsetField): void {
  BOUND_AS.set(guid, field);
}

/** The field a toolset guid was bound through, if a trigger here bound it. */
export function toolsetTargetField(guid: string): ToolsetField | undefined {
  return BOUND_AS.get(guid);
}
