/**
 * Help rendering, driven entirely by the command registry (`commands.ts`).
 *
 * Every function here RETURNS a string rather than writing one, for two reasons:
 * the same block goes to stdout when help was requested and to stderr when it
 * accompanies a failure, and a returned value is what tests can assert on.
 *
 * Column widths are computed on the RAW strings and the color is applied after
 * padding — ANSI escape codes count as characters to `padEnd`, so coloring first
 * silently skews every column. The rest of the CLI's aligned output does the
 * same thing for the same reason.
 */
import {
  COMMANDS,
  renderArgs,
  FLAGS,
  HELP_GROUP_ORDER,
  getCommand,
  getSubcommand,
  liveSubcommandNames,
  visibleFlags,
  flagKey,
  flagSpec,
  flagValues,
  flagSummary,
  GLOBAL_FLAGS,
  flagRefFor,
  takesProfileFlag,
  type ArgSpec,
  type CommandSpec,
  type FlagRef,
  type SelectorDefault,
  type SubcommandSpec,
} from "./commands.js";
import { sourceSpellings } from "./source-selector.js";
import { stdoutStyle, type Palette } from "./ui.js";

/** Two-column rows, padded on the raw name then dimmed/colored. */
function table(
  rows: ReadonlyArray<readonly [string, string]>,
  s: Palette,
  indent = "  ",
  fixedWidth?: number,
): string[] {
  const width = fixedWidth ?? Math.max(0, ...rows.map(([name]) => name.length));
  return rows.map(([name, desc]) => `${indent}${s.cyan(name.padEnd(width))}  ${s.dim(desc)}`);
}

/**
 * A flag's spec line as THIS command means it.
 *
 * A per-command `values` override has to reach the rendered spec, or help would
 * print `--dest <ephemeral>` on a command that also accepts
 * `workspace`. The shared spec carries the placeholder (`--dest <a|b>`), so the
 * override is substituted into it rather than reconstructed — a spec with no
 * placeholder (a boolean flag) is returned untouched.
 */
function renderFlagSpec(ref: FlagRef): string {
  const spec = flagSpec(ref);
  const values = flagValues(ref);
  if (values === undefined || typeof ref === "string" || ref.values === undefined) return spec;
  return spec.replace(/<[^>]*>/, `<${values.join("|")}>`);
}

/** The `Flags` block for a command or subcommand, or nothing when it takes none. */
function flagSection(flags: readonly FlagRef[] | undefined, s: Palette): string[] {
  if (!flags || flags.length === 0) return [];
  const rows = flags
    .filter((ref) => Object.hasOwn(FLAGS, flagKey(ref)))
    .map((ref) => [renderFlagSpec(ref), flagSummary(ref)] as const);
  if (rows.length === 0) return [];
  return ["", s.bold("Flags"), ...table(rows, s)];
}

/**
 * An `Arguments` block for positionals that accept a closed set. Free-form
 * positionals are already described by the usage line; only a fixed set carries
 * information the usage line can't, and leaving it to prose means the terminal
 * can't answer "what values does this take".
 */
function argSection(args: readonly ArgSpec[] | undefined, s: Palette): string[] {
  const rows = (args ?? []).flatMap((a) => {
    // A selector positional lists the spellings its declaration accepts, and
    // what leaving it out means — the usage line can say neither.
    if (a.selector !== undefined) {
      return [[`<${a.name}>`, `${sourceSpellings(a.selector.accepted)}${OMITTED[a.selector.default]}`] as const];
    }
    return a.values !== undefined && a.values.length > 0 ? [[`<${a.name}>`, a.values.join(", ")] as const] : [];
  });
  return rows.length === 0 ? [] : ["", s.bold("Arguments"), ...table(rows, s)];
}

/** What an omitted selector positional means, appended to its Arguments row. */
const OMITTED: Record<SelectorDefault, string> = {
  tracked: " (omitted: the backend this project last deployed to)",
  entry: " (omitted: this project's entry file, compiled)",
  none: "",
};

/** Trailing example line, or nothing. */
function exampleSection(example: string | undefined, s: Palette): string[] {
  return example ? ["", s.bold("Example"), `  ${s.dim(example)}`] : [];
}

/**
 * The flags every command accepts, as `[spec, summary]` rows. Read from the
 * registry like everything else here, so `--json` gained its line in global help
 * by being declared once in `commands.ts`.
 */
function globalFlagRows(): Array<readonly [string, string]> {
  return GLOBAL_FLAGS.map((key) => [FLAGS[key].spec, FLAGS[key].summary] as const);
}

/**
 * One trailing line on every command and verb page naming the global flags. They
 * stay off each page's Flags block — a row apiece there is what the global list
 * exists to avoid — but an example is free to use one (`status --json`), and a
 * page must not show a flag it never names.
 */
function globalFlagsLine(s: Palette, command: string, sub?: string): string[] {
  const specs = GLOBAL_FLAGS.filter(
    (key) =>
      key !== "help" &&
      key !== "version" &&
      // A command that reaches no instance REFUSES `--profile` (see parseArgs).
      (key !== "profile" || takesProfileFlag(command, sub)) &&
      // `--no-refresh` turns off the AGENTS.md refresh a WORKSPACE compile does,
      // so only a page for a command that runs one lists it — the commands that
      // take the compile's env flags. `compile` and `routes` never refresh.
      (key !== "no-refresh" || flagRefFor(command, sub, "backend-env-file") !== undefined) &&
      // `completion` prints a script to source and refuses `--json`, so its
      // page must not offer it.
      (key !== "json" || command !== "completion"),
  ).map((key) => FLAGS[key].spec);
  // A page with no global flag left to offer (`completion`) says nothing,
  // rather than "the global flags  — see".
  if (specs.length === 0) return [];
  // `·` rather than `,` — a spec like `--profile, -p <name>` carries its own comma.
  return ["", s.dim(`Also takes the global flags ${specs.join(" · ")} — see \`xanosdk --help\`.`)];
}

/**
 * The grouped command reference — what bare `xanosdk`, `xanosdk help`, and
 * `xanosdk --help` print. Removed commands and aliases are hidden: this is the
 * menu of what to type, not an inventory.
 */
export function renderGlobalHelp(s: Palette = stdoutStyle(), version = ""): string {
  // Rows per group: the command itself, plus any subcommand that asked to be
  // surfaced in a group of its own (the `codegen` variants under "Pull").
  const byGroup = new Map<string, Array<readonly [string, string]>>();
  const push = (group: string, row: readonly [string, string]) => {
    const rows = byGroup.get(group) ?? [];
    rows.push(row);
    byGroup.set(group, rows);
  };
  for (const [name, spec] of Object.entries(COMMANDS) as Array<[string, CommandSpec]>) {
    if (spec.aliasOf === undefined) push(spec.group, [spec.display, spec.summary]);
    for (const sub of Object.values(spec.subcommands ?? {})) {
      if (sub.group === undefined) continue;
      push(sub.group, [sub.display ?? `${name} ${sub.summary}`, sub.groupSummary ?? sub.summary]);
    }
  }

  // One column width across ALL groups, not per group — the reference reads as
  // a single table broken by headings, which is how it has always rendered.
  const width = Math.max(0, ...[...byGroup.values()].flat().map(([n]) => n.length));
  const lines: string[] = [
    `${s.bold("xanosdk")}${version ? ` ${s.dim(`v${version}`)}` : ""} — the AI-first SDK & CLI for Xano backends`,
    "",
    `${s.dim("Usage:")} xanosdk ${s.cyan("<command>")} ${s.dim("[options]")}`,
  ];
  for (const group of HELP_GROUP_ORDER) {
    const rows = byGroup.get(group);
    if (!rows || rows.length === 0) continue;
    lines.push("", s.bold(group), ...table(rows, s, "  ", width));
  }
  // Same column width as the command groups above: the page reads as one table
  // broken by headings, and the global block is the last of those headings.
  lines.push("", s.bold("Global flags"), ...table(globalFlagRows(), s, "  ", width));
  lines.push(
    "",
    s.dim("Run `xanosdk <command> --help` for a command's arguments and flags."),
    s.dim("Docs: https://www.npmjs.com/package/@xano/sdk"),
  );
  return lines.join("\n") + "\n";
}

/**
 * Help for one command: its summary, usage, subcommands (families only), the
 * flags it accepts, and an example. Falls back to global help for a name the
 * registry doesn't know, so a help request never dead-ends.
 */
export function renderCommandHelp(command: string, s: Palette = stdoutStyle()): string {
  const spec = getCommand(command);
  if (!spec) return renderGlobalHelp(s);
  const subs = liveSubcommandNames(command);
  const usage =
    subs.length > 0
      ? `xanosdk ${command} <subcommand> ${s.dim("[options]")}`
      : `xanosdk ${command}${renderArgs(spec.args) ? ` ${renderArgs(spec.args)}` : ""} ${s.dim("[options]")}`;

  const lines: string[] = [`${s.bold(`xanosdk ${command}`)} — ${spec.summary}`, "", `${s.dim("Usage:")} ${usage}`];

  if (subs.length > 0) {
    const rows = subs.map((name) => {
      const sub = getSubcommand(command, name)!;
      const args = renderArgs(sub.args);
      return [args ? `${name} ${args}` : name, sub.summary] as const;
    });
    lines.push("", s.bold("Subcommands"), ...table(rows, s));
  }

  lines.push(...argSection(spec.args, s));
  lines.push(...flagSection(visibleFlags(spec), s));
  if (spec.notes !== undefined) lines.push("", s.bold("Notes"), `  ${spec.notes}`);
  lines.push(...exampleSection(spec.example, s));
  lines.push(...globalFlagsLine(s, command));

  if (subs.length > 0) {
    lines.push("", s.dim(`Run \`xanosdk ${command} <subcommand> --help\` for a subcommand's flags.`));
  }
  return lines.join("\n") + "\n";
}

/**
 * Help for one verb under a noun command. Falls back to the parent's help when
 * the verb is unknown — the parent block is what lists the valid ones.
 */
export function renderSubcommandHelp(command: string, sub: string, s: Palette = stdoutStyle()): string {
  const spec: SubcommandSpec | undefined = getSubcommand(command, sub);
  if (!spec) return renderCommandHelp(command, s);
  const args = renderArgs(spec.args);
  const lines: string[] = [
    `${s.bold(`xanosdk ${command} ${sub}`)} — ${spec.summary}`,
    "",
    `${s.dim("Usage:")} xanosdk ${command} ${sub}${args ? ` ${args}` : ""} ${s.dim("[options]")}`,
  ];
  lines.push(...argSection(spec.args, s));
  lines.push(...flagSection(visibleFlags(spec), s));
  lines.push(...exampleSection(spec.example, s));
  lines.push(...globalFlagsLine(s, command, sub));
  return lines.join("\n") + "\n";
}

/**
 * The block that belongs with a usage failure: subcommand-scoped when a verb was
 * named, command-scoped when only a command was, global otherwise.
 */
export function renderHelpFor(
  target: { command?: string; subcommand?: string } | undefined,
  s: Palette,
  version = "",
): string {
  if (target?.command === undefined) return renderGlobalHelp(s, version);
  if (target.subcommand !== undefined) return renderSubcommandHelp(target.command, target.subcommand, s);
  return renderCommandHelp(target.command, s);
}

/** Indent a rendered block so it sits under an error headline. */
export function indentBlock(text: string, indent = "  "): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : indent + line))
    .join("\n");
}
