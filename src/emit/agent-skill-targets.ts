/**
 * Where `xanosdk agent-skill` puts the skill: the agents on this machine and
 * the user-level skill directories they read, plus the file access on those
 * directories. Kept apart from the command so a path change is a one-file fix
 * and the command's tests cross a module boundary.
 *
 * At most two directories are written. Claude Code reads its own
 * (`~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills`). Codex, Cursor, Copilot,
 * Gemini CLI, Amp and OpenCode all read the open-standard `~/.agents/skills`,
 * so their agent-specific directories are not written. Cursor and OpenCode also
 * read `~/.claude/skills`; an install for both writes the same file twice,
 * which they load as one skill.
 *
 * An agent is detected by its home config directory. Every function takes the
 * `env` it reads, so a test names its own home.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readEnvVar } from "../util/env.js";
import { expandHome } from "../util/home-path.js";
import { AGENT_SKILL_NAME } from "./agent-skill.js";

/** A directory the skill is written into: Claude Code's own, or the open-standard one. */
export type TargetId = "claude-code" | "agents";

export interface SkillTarget {
  readonly agent: TargetId;
  /** The `SKILL.md` this target holds. */
  readonly path: string;
}

type Env = NodeJS.ProcessEnv;

function userHome(env: Env): string {
  return env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
}

/** A directory-valued override, read as a shell would have expanded a leading `~`. */
const dirVar = (name: string, env: Env): string | undefined => expandHome(readEnvVar(name, env));

const claudeHome = (env: Env): string => dirVar("CLAUDE_CONFIG_DIR", env) ?? join(userHome(env), ".claude");

/** Each agent detected, the directory that says it is installed, and the target it reads. */
const AGENTS: ReadonlyArray<{ id: string; home: (env: Env) => string; target: TargetId }> = [
  { id: "claude-code", home: claudeHome, target: "claude-code" },
  { id: "codex", home: (env) => dirVar("CODEX_HOME", env) ?? join(userHome(env), ".codex"), target: "agents" },
  { id: "cursor", home: (env) => join(userHome(env), ".cursor"), target: "agents" },
  { id: "copilot", home: (env) => join(userHome(env), ".copilot"), target: "agents" },
  { id: "gemini", home: (env) => join(userHome(env), ".gemini"), target: "agents" },
  { id: "amp", home: (env) => join(userHome(env), ".config", "amp"), target: "agents" },
  { id: "opencode", home: (env) => join(userHome(env), ".config", "opencode"), target: "agents" },
];

/** What `--agent` accepts: the two target ids, then every agent detected by name. */
export const KNOWN_AGENT_IDS: readonly string[] = [
  "claude-code",
  "agents",
  ...AGENTS.map((a) => a.id).filter((id) => id !== "claude-code"),
];

/** The ids of the agents whose home config directory exists, in {@link AGENTS} order. */
export function detectAgents(env: Env = process.env): string[] {
  return AGENTS.filter((a) => existsSync(a.home(env))).map((a) => a.id);
}

/** Both targets, Claude Code's first. */
export function skillTargets(env: Env = process.env): SkillTarget[] {
  const file = (skills: string): string => join(skills, AGENT_SKILL_NAME, "SKILL.md");
  return [
    { agent: "claude-code", path: file(join(claudeHome(env), "skills")) },
    { agent: "agents", path: file(join(userHome(env), ".agents", "skills")) },
  ];
}

/** The targets `ids` (agent or target ids from {@link KNOWN_AGENT_IDS}) read, each once, in target order. */
export function targetsForAgents(ids: readonly string[], env: Env = process.env): SkillTarget[] {
  const wanted = new Set<TargetId>(ids.map((id) => AGENTS.find((a) => a.id === id)?.target ?? "agents"));
  return skillTargets(env).filter((t) => wanted.has(t.agent));
}

/** Whether the target agent `target` is read by an agent in `detected`. */
export function targetDetected(target: TargetId, detected: readonly string[]): boolean {
  return AGENTS.some((a) => a.target === target && detected.includes(a.id));
}

/** A copy on disk: its text (null when absent), and whether the skill directory or file is a symlink. */
export interface CopyOnDisk {
  readonly text: string | null;
  readonly symlink: boolean;
}

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

export function readCopy(path: string): CopyOnDisk {
  const symlink = isLink(dirname(path)) || isLink(path);
  return { text: existsSync(path) ? readFileSync(path, "utf8") : null, symlink };
}

export function writeCopy(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Removes the copy, and the skill directory when that leaves it empty. */
export function removeCopy(path: string): void {
  rmSync(path, { force: true });
  const dir = dirname(path);
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}
