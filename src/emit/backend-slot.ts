/**
 * A command's backend selector slot, read from the registry and applied.
 *
 * Every operation that names a running backend declares ONE slot per role in
 * `commands.ts` — the kinds it accepts, whether bare means the tracked backend,
 * and which kinds it refuses with a reason (see {@link SelectorSpec}). Help,
 * completion and the manifest render that declaration; this module is the half
 * that ENFORCES it, so a handler cannot accept a kind its help does not show,
 * and a kind a command cannot serve is refused with the same reason whether it
 * was typed or came from the tracked pointer.
 *
 * Handlers adopt it one at a time; `test/emit/backend-slot-agreement.test.ts`
 * holds the list of slots whose handler still passes its own set to
 * `parseSource`, and fails when a migrated one disagrees with its declaration.
 *
 * Pure: no filesystem, no network. Resolving what a bare form means belongs to
 * the tracked-backend resolver.
 */
import {
  BARE,
  isKindShaped,
  parseSource,
  sourceSpellings,
  type SelectorNoun,
  type Source,
  type SourceKind,
} from "./source-selector.js";
import { UsageError, type HelpTarget } from "./errors.js";
import {
  COMMANDS,
  getCommand,
  getSubcommand,
  type ArgSpec,
  type CommandSpec,
  type FlagKey,
  type FlagRef,
  type SelectorRole,
  type SelectorSpec,
  type SubcommandSpec,
} from "./commands.js";

/** One declared selector slot, located. */
export interface BackendSlot {
  readonly command: string;
  readonly subcommand?: string;
  /** How the slot is written on the command line: `--to`, `--on`, or `<source>`. */
  readonly spelling: string;
  /** The FLAGS key when the slot is a flag; absent for a positional. */
  readonly flag?: FlagKey;
  readonly selector: SelectorSpec;
}

/** `env set`, for a message. */
export function commandPath(command: string, subcommand: string | undefined): string {
  return subcommand === undefined ? command : `${command} ${subcommand}`;
}

function slotsOf(command: string, subcommand: string | undefined, spec: CommandSpec | SubcommandSpec): BackendSlot[] {
  const out: BackendSlot[] = [];
  const at = subcommand === undefined ? { command } : { command, subcommand };
  for (const arg of (spec.args ?? []) as readonly ArgSpec[]) {
    if (arg.selector !== undefined) out.push({ ...at, spelling: `<${arg.name}>`, selector: arg.selector });
  }
  for (const ref of (spec.flags ?? []) as readonly FlagRef[]) {
    if (typeof ref === "string" || ref.selector === undefined) continue;
    out.push({ ...at, spelling: `--${ref.key}`, flag: ref.key as FlagKey, selector: ref.selector });
  }
  return out;
}

/** Every declared slot in the registry, in registry order. */
export function allBackendSlots(): BackendSlot[] {
  const out: BackendSlot[] = [];
  for (const [name, raw] of Object.entries(COMMANDS)) {
    const spec = raw as CommandSpec;
    out.push(...slotsOf(name, undefined, spec));
    for (const [verb, sub] of Object.entries(spec.subcommands ?? {})) out.push(...slotsOf(name, verb, sub));
  }
  return out;
}

/**
 * The slot a command declares for `role`, or undefined.
 *
 * `role` is enough to find it: a command has at most one slot per role —
 * `deploy` has two, its `subject` positional and its `to` flag.
 */
export function backendSlot(
  command: string,
  subcommand: string | undefined,
  role: SelectorRole,
): BackendSlot | undefined {
  const spec = subcommand === undefined ? getCommand(command) : getSubcommand(command, subcommand);
  if (spec === undefined) return undefined;
  return slotsOf(command, subcommand, spec).find((s) => s.selector.role === role);
}

/** The slot a command declares for flag `key`, or undefined — for the parse-arm errors. */
export function backendSlotForFlag(
  command: string | undefined,
  subcommand: string | undefined,
  key: FlagKey,
): BackendSlot | undefined {
  if (command === undefined) return undefined;
  const spec = subcommand === undefined ? getCommand(command) : getSubcommand(command, subcommand);
  if (spec === undefined) return undefined;
  return slotsOf(command, subcommand, spec).find((s) => s.flag === key);
}

/**
 * {@link backendSlot}, for a handler: a missing declaration is a programming
 * error in this repo, not a user mistake, so it throws a plain Error naming
 * the gap.
 */
export function requireBackendSlot(command: string, subcommand: string | undefined, role: SelectorRole): BackendSlot {
  const slot = backendSlot(command, subcommand, role);
  if (slot === undefined) {
    throw new Error(`\`${commandPath(command, subcommand)}\` declares no \`${role}\` selector slot in commands.ts.`);
  }
  return slot;
}

/** How a slot is described in its parse-arm error: what a value there IS. */
const ROLE_NOUN: Record<SelectorRole, string> = {
  from: "a source",
  to: "a destination",
  on: "a backend",
  subject: "a backend",
};

/** The kind named, for a refusal sentence. */
const KIND_PHRASE: Record<SourceKind, string> = {
  workspace: "the workspace",
  ephemeral: "an ephemeral",
  "local": "a Xano Engine",
  tenant: "a tenant",
  release: "a release",
  file: "a bundle file",
};

function helpFor(slot: BackendSlot): HelpTarget {
  return slot.subcommand === undefined
    ? { command: slot.command }
    : { command: slot.command, subcommand: slot.subcommand };
}

/**
 * A flag slot given no value (`--to $UNSET`). Rendered from the declaration so
 * the spellings in the error are the ones this command takes.
 */
export function slotValueMissing(slot: BackendSlot): UsageError {
  const accepted = `${ROLE_NOUN[slot.selector.role]}: ${sourceSpellings(slot.selector.accepted)}`;
  // A positional slot left off is a missing ARGUMENT, and reads like every other
  // one (`missing required <source>`); only a flag given no value "expects" one.
  if (!slot.spelling.startsWith("--")) {
    return new UsageError(
      `\`xanosdk ${commandPath(slot.command, slot.subcommand)}\`: missing required ${slot.spelling} — ${accepted}.`,
      { helpFor: helpFor(slot) },
    );
  }
  return new UsageError(`${slot.spelling} expects ${accepted}.`, { helpFor: helpFor(slot) });
}

/** Which kind a raw selector value names, when it names one at all. */
function kindOf(raw: string): SourceKind | undefined {
  if (isKindShaped(raw)) return raw.slice(0, raw.indexOf(":")) as SourceKind;
  return BARE.includes(raw as SourceKind) ? (raw as SourceKind) : undefined;
}

/**
 * A ready-to-type alternative for a tracked refusal: `, for example \`--to ephemeral\``.
 *
 * An ephemeral when the slot takes one, because the refusal fires right after a
 * local deploy and the throwaway hosted kind is the one that cannot land
 * anywhere real. A positional slot has no flag to prefix, so it gets none.
 */
function exampleOf(slot: BackendSlot): string {
  if (!slot.spelling.startsWith("--")) return "";
  const pick = slot.selector.accepted.includes("ephemeral")
    ? "ephemeral"
    : slot.selector.accepted.find((k) => slot.selector.refused?.[k] === undefined && k !== "file");
  return pick === undefined ? "" : `, for example \`${slot.spelling} ${pick}\``;
}

/**
 * The refusal for a kind this slot declares it cannot serve, or undefined when
 * the slot has no reason on record for `kind`.
 *
 * `origin` is what named the kind: the raw string typed into the slot, or
 * `"tracked"` when it came from what the project last deployed to. The second
 * form exists because a bare command must refuse exactly as the typed form
 * does — `publish` bare after a local deploy is the same impossibility
 * as `publish --to local` — and must say how to name something else.
 */
export function refusedKind(
  slot: BackendSlot,
  kind: SourceKind,
  origin: { readonly typed: string; readonly name?: string } | "tracked",
): UsageError | undefined {
  const declared = slot.selector.refused?.[kind];
  if (declared === undefined) return undefined;
  // A reason's `<ephemeral name>`-style placeholder is filled with the name
  // that was typed: `--to ephemeral:pr-3` is answered with `tenant:pr-3`,
  // ready to paste, not with a template to fill in. A bare kind takes the
  // name the caller knows it by (the project's tracked one), when it has one.
  const typedName =
    origin === "tracked"
      ? ""
      : origin.typed.includes(":")
        ? origin.typed.slice(origin.typed.indexOf(":") + 1).trim()
        : (origin.name ?? "");
  const reason = typedName === "" ? declared : declared.split(`<${kind} name>`).join(typedName);
  const path = commandPath(slot.command, slot.subcommand);
  const accepted = sourceSpellings(slot.selector.accepted);
  // By role, like `parseSource`'s refusals: "Backends are workspace, …" under
  // `--to` described a destination as something else.
  const plural = SELECTOR_NOUN[slot.selector.role].plural;
  const lead =
    origin === "tracked"
      ? `This project last deployed to ${KIND_PHRASE[kind]}, which \`xanosdk ${path}\` cannot serve: ${reason}. ` +
        `Name another with \`${slot.spelling}\`${exampleOf(slot)}. ${plural} are ${accepted}.`
      : `"${origin.typed}" names ${KIND_PHRASE[kind]}, which \`xanosdk ${path}\` cannot serve: ${reason}. ` +
        `${plural} are ${accepted}.`;
  // A pointer, not the block: the value parsed and the kind is what refuses.
  // The message already lists the backends this slot takes, and the usage
  // block's argument list would name the very kind just refused.
  return new UsageError(lead, { hintFor: helpFor(slot) });
}

/**
 * Parse one value typed into `slot`, or throw a {@link UsageError}.
 *
 * A refused kind is refused with its reason BEFORE `parseSource` sees it:
 * `parseSource` would otherwise report "which this command does not take",
 * which is true and useless — the reason is what tells the reader whether to
 * pick another backend or another command.
 */
export function parseSlot(
  slot: BackendSlot,
  raw: string,
  /** The name a bare kind stands for here (the tracked one), to fill a refusal's placeholder. */
  name?: string,
): Source {
  const kind = kindOf(raw);
  if (kind !== undefined) {
    const refusal = refusedKind(slot, kind, name === undefined ? { typed: raw } : { typed: raw, name });
    if (refusal !== undefined) throw refusal;
  }
  return parseSource(raw, slot.selector.accepted, helpFor(slot), SELECTOR_NOUN[slot.selector.role]);
}

/** How a refusal names what this slot takes, by its role (see `SelectorNoun`). */
const SELECTOR_NOUN: Record<SelectorRole, SelectorNoun> = {
  from: { singular: "source", plural: "Sources" },
  to: { singular: "destination", plural: "Destinations" },
  on: { singular: "backend", plural: "Backends" },
  subject: { singular: "backend", plural: "Backends" },
};
