/**
 * `xanosdk agent-skill install | uninstall | status` — puts the `xano-backend`
 * skill into the coding agents on this machine, and takes it out again.
 *
 * Stateless: each copy carries its own version and digest
 * (`agent-skill.ts`), so a copy is classified from its bytes alone. A copy
 * whose digest does not verify is the user's, and only `install --force`
 * replaces it. A symlinked skill directory belongs to another installer and is
 * left alone. Nothing here prompts.
 *
 * Node-only; lazily imported from `cli.ts`.
 */
import type { ParsedArgs } from "./cli.js";
import { readVersion } from "./cli.js";
import { UsageError, unknownSubcommand } from "./errors.js";
import { isMachineOutput, writeJson } from "./output.js";
import { detail, success } from "./ui.js";
import { classifySkill, renderAgentSkill, type SkillState } from "./agent-skill.js";
import {
  KNOWN_AGENT_IDS,
  detectAgents,
  readCopy,
  removeCopy,
  skillTargets,
  targetDetected,
  targetsForAgents,
  writeCopy,
  type SkillTarget,
} from "./agent-skill-targets.js";

type Action = "created" | "updated" | "unchanged" | "removed" | "skipped";

interface Outcome {
  readonly agent: SkillTarget["agent"];
  readonly path: string;
  readonly state: SkillState;
  readonly action?: Action;
  readonly reason?: "edited" | "symlink";
  readonly detected?: boolean;
}

const VERBS = ["install", "uninstall", "status"] as const;
type Verb = (typeof VERBS)[number];

export async function runAgentSkillCommand(args: ParsedArgs): Promise<void> {
  const subcommand = args.subcommand;
  if (subcommand === undefined || !(VERBS as readonly string[]).includes(subcommand)) {
    throw unknownSubcommand("agent-skill", subcommand);
  }
  const verb = subcommand as Verb;
  const unknown = args.agent.filter((id) => !KNOWN_AGENT_IDS.includes(id));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown agent ${unknown.map((id) => `"${id}"`).join(", ")}. \`--agent\` takes: ${KNOWN_AGENT_IDS.join(", ")}.`,
      { hintFor: { command: "agent-skill", subcommand: verb } },
    );
  }

  const rendered = renderAgentSkill(readVersion());
  const named = args.agent.length > 0 ? targetsForAgents(args.agent) : undefined;

  let outcomes: Outcome[];
  if (verb === "status") {
    const detected = detectAgents();
    outcomes = (named ?? skillTargets()).map((t) => ({
      ...t,
      state: classifySkill(readCopy(t.path).text, rendered),
      detected: targetDetected(t.agent, detected),
    }));
  } else if (verb === "install") {
    const targets = named ?? targetsForAgents(detectAgents());
    if (targets.length === 0) {
      throw new UsageError(
        "No coding agent found on this machine, so there is nowhere to install the skill. " +
          `Name one with \`--agent <id>\`: ${KNOWN_AGENT_IDS.join(", ")}.`,
        { hintFor: { command: "agent-skill", subcommand: "install" } },
      );
    }
    outcomes = targets.map((t) => install(t, rendered, args));
  } else {
    outcomes = (named ?? skillTargets()).map((t) => uninstall(t, rendered, args));
  }

  report(verb, outcomes, args);
}

function install(target: SkillTarget, rendered: string, args: ParsedArgs): Outcome {
  const copy = readCopy(target.path);
  const state = classifySkill(copy.text, rendered);
  const base = { ...target, state };
  if (copy.symlink) return { ...base, action: "skipped", reason: "symlink" };
  if (state === "current") return { ...base, action: "unchanged" };
  if (state === "edited" && !args.force) return { ...base, action: "skipped", reason: "edited" };
  if (!args.dryRun) writeCopy(target.path, rendered);
  return { ...base, action: state === "absent" ? "created" : "updated" };
}

function uninstall(target: SkillTarget, rendered: string, args: ParsedArgs): Outcome {
  const copy = readCopy(target.path);
  const state = classifySkill(copy.text, rendered);
  const base = { ...target, state };
  if (state === "absent") return { ...base, action: "unchanged" };
  if (copy.symlink) return { ...base, action: "skipped", reason: "symlink" };
  if (state === "edited") return { ...base, action: "skipped", reason: "edited" };
  if (!args.dryRun) removeCopy(target.path);
  return { ...base, action: "removed" };
}

const REASONS: Record<NonNullable<Outcome["reason"]>, string> = {
  edited: "edited since it was installed; left as it is",
  symlink: "the skill directory is a symlink another installer manages; left as it is",
};

function report(verb: Verb, outcomes: readonly Outcome[], args: ParsedArgs): void {
  const preview = args.dryRun && verb !== "status" ? " (dry run: nothing written)" : "";
  for (const o of outcomes) {
    success(`${o.agent}: ${o.action ?? o.state}${preview}`);
    detail(o.path);
    if (o.reason !== undefined) detail(REASONS[o.reason]);
  }
  if (outcomes.some((o) => o.reason === "edited") && verb === "install") {
    detail("`xanosdk agent-skill install --force` replaces an edited copy.");
  }
  if (isMachineOutput(args)) {
    writeJson({ ...(verb === "status" ? {} : { dryRun: args.dryRun }), targets: outcomes });
  }
}
