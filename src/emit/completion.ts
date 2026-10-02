/**
 * `xanosdk completion <bash|zsh|fish>` — emit a shell completion script.
 *
 * Generated STATICALLY from the command registry: the script that lands in your
 * shell profile has the command, subcommand, and flag names baked in, so pressing
 * Tab costs nothing. The alternative — a script that shells out to
 * `xanosdk __complete` on every keystroke — pays a Node startup (~80ms) per Tab,
 * which is exactly the latency budget completion has to live inside. The tradeoff
 * is that the script goes stale on upgrade; `completion` is cheap to re-run, and
 * the install snippets below pipe it through a file you can regenerate.
 *
 * Pure string building over the registry — no `node:*`, no I/O. Lazily imported
 * by the command layer since almost no run needs it.
 */
import {
  argValues,
  flagSpec,
  flagKey,
  flagRefFor,
  flagValues,
  getCommand,
  GLOBAL_FLAGS,
  liveCommandNames,
  liveSubcommandNames,
  takesProfileFlag,
  visibleFlags,
  type ArgSpec,
  type CommandSpec,
  type FlagRef,
} from "./commands.js";

/** The shells we emit for. */
export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
/**
 * Real shells with no script here, so an argument naming one is refused as
 * unsupported rather than "corrected" to whichever supported name sits a couple
 * of edits away.
 */
export const UNSUPPORTED_SHELLS: ReadonlySet<string> = new Set([
  "pwsh",
  "powershell",
  "cmd",
  "sh",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "nushell",
  "elvish",
  "xonsh",
]);
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** Whether `s` names a shell we can emit for. */
export function isCompletionShell(s: string): s is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(s);
}

/**
 * The completable tokens in a flag spec: `--out, -o <path>` → `--out -o`.
 * Placeholders never match — `<ephemeral|workspace>`, `KEY=VALUE`, and `<p>` carry
 * no leading dash — so the display string doubles as the token source and there
 * is no second list to keep in sync.
 */
function flagTokens(ref: FlagRef): string[] {
  const spec = flagSpec(ref);
  return spec.match(/-{1,2}[a-z][a-z-]*/g) ?? [];
}

/**
 * Whether a flag takes its value as the NEXT word (`--config <path>`,
 * `--static-env KEY=VALUE`) — not one written only inline (`--entry=<path>`,
 * `--lock[=<path>]`), whose next word is something else.
 */
function takesNextWord(ref: FlagRef): boolean {
  const rest = flagSpec(ref)
    .replace(/-{1,2}[a-z][a-z-]*,?/g, "")
    .trim();
  return rest !== "" && !rest.startsWith("=") && !rest.startsWith("[");
}

/**
 * Every flag token whose next word is its value, wherever it appears — so a
 * scope reader skips `-p prof` whole rather than reading `prof` as the command.
 * A token that is a plain switch anywhere is left out: skipping the word after
 * it there would swallow the command.
 */
function valueFlagTokens(): string[] {
  const refs: FlagRef[] = [...(GLOBAL_FLAGS as readonly FlagRef[])];
  for (const name of liveCommandNames()) {
    const spec = getCommand(name)!;
    refs.push(...(visibleFlags(spec) ?? []));
    for (const verb of liveSubcommandNames(name)) refs.push(...(visibleFlags(spec.subcommands![verb]!) ?? []));
  }
  const valued = new Set<string>();
  const switches = new Set<string>();
  for (const ref of refs) for (const token of flagTokens(ref)) (takesNextWord(ref) ? valued : switches).add(token);
  return [...valued].filter((t) => !switches.has(t)).sort();
}

/**
 * What completes as the value of a flag that takes the next word and has no
 * closed set: a file, a directory, a stored profile name, or nothing (a
 * free-form value — a name, a number, a URL). Read off the spec's placeholder,
 * so a new `<path>` flag completes files without a second list to update.
 */
export type ValueKind = "file" | "dir" | "profile" | "free";

export function valueKind(ref: FlagRef): ValueKind | undefined {
  if (!takesNextWord(ref) || flagValues(ref) !== undefined) return undefined;
  const key = flagKey(ref);
  if (key === "profile" || key === "to-profile") return "profile";
  const spec = flagSpec(ref);
  if (/<dir>/.test(spec) || key.endsWith("-dir")) return "dir";
  if (/<(path|file|p)>/.test(spec)) return "file";
  return "free";
}

/**
 * What completes after `--flag=` for a flag whose value is written ONLY there
 * (`--lock[=<path>]`, `--seed[=<guids>]`): read off the placeholder as
 * {@link valueKind} reads a next-word one. Undefined for every other flag —
 * the word after `--lock ` is not its value, so this applies to the `=` form only.
 */
export function inlineValueKind(ref: FlagRef): ValueKind | undefined {
  if (takesNextWord(ref) || flagValues(ref) !== undefined) return undefined;
  const rest = flagSpec(ref)
    .replace(/-{1,2}[a-z][a-z-]*,?/g, "")
    .trim();
  const placeholder = /^\[?=<([^>]+)>/.exec(rest)?.[1];
  if (placeholder === undefined) return undefined;
  const parts = placeholder.split("|");
  if (parts.includes("dir")) return "dir";
  if (parts.some((p) => p === "path" || p === "file")) return "file";
  return "free";
}

/** Every flag token a command (or one of its verbs) accepts. */
function tokensFor(flags: readonly FlagRef[] | undefined): string[] {
  return (flags ?? []).flatMap(flagTokens);
}

/** Whether this scope's positionals want filesystem paths. */
function wantsPaths(args: readonly ArgSpec[] | undefined): boolean {
  return (args ?? []).some((a) => a.path === true);
}

/**
 * The closed set the FIRST positional accepts, when it has one (`completion
 * <shell>`). Only the first: later positionals are all free-form here, and
 * tracking position across interleaved flags is more machinery than the one
 * command that would use it justifies.
 */
function firstArgValues(args: readonly ArgSpec[] | undefined): string[] {
  const first = args?.[0];
  // `argValues` reads a selector positional's declaration too, so `pull <Tab>`
  // offers the bare backend kinds it accepts.
  return first === undefined ? [] : [...(argValues(first) ?? [])];
}

/** `[flag token, allowed values]` for every flag in this scope with a closed set. */
function valuedFlags(flags: readonly FlagRef[] | undefined): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (const ref of flags ?? []) {
    // The command's own set when it has one — a completion that offered
    // `workspace` to `deploy --dest` would suggest a value the command refuses.
    const values = flagValues(ref);
    if (values === undefined) continue;
    for (const token of flagTokens(ref)) out.push([token, [...values]]);
  }
  return out;
}

/**
 * A one-line description safe to embed in any of the three scripts. Colons are
 * kept — `api:<canonical>` is how the thing is spelled: zsh's `_describe`
 * splits a row at its FIRST unescaped colon, which is the name's own (names
 * never hold one), and fish takes the description as one argument.
 */
function describe(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Single-quote for POSIX-ish shells, closing and reopening around any quote. */
function sq(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Every scope we complete: the bare command, plus `command sub` for each verb. */
interface Scope {
  /** `deploy`, or `workspace export`. */
  readonly key: string;
  readonly flags: string[];
  readonly paths: boolean;
  /** The closed set its first positional accepts, if any. */
  readonly values: string[];
  /** Flags in this scope that accept a closed set of values. */
  readonly valued: Array<[string, string[]]>;
  /** Every other flag in this scope whose next word is its value, and what that value is. */
  readonly kinds: Array<[string, ValueKind]>;
  /** Flags in this scope whose value is written only after `=`, and what that value is. */
  readonly inlineKinds: Array<[string, ValueKind]>;
}

/** `[flag token, value kind]` for a scope's flags whose value is written only after `=`. */
function inlineKindedFlags(flags: readonly FlagRef[] | undefined): Array<[string, ValueKind]> {
  return (flags ?? []).flatMap((ref) => {
    const kind = inlineValueKind(ref);
    return kind === undefined ? [] : flagTokens(ref).filter((t) => t.startsWith("--")).map((t) => [t, kind] as [string, ValueKind]);
  });
}

/** `[flag token, value kind]` for a scope's own flags and the global ones it takes. */
function kindedFlags(flags: readonly FlagRef[] | undefined, command: string, verb: string | undefined): Array<[string, ValueKind]> {
  const globals = GLOBAL_FLAGS.filter((key) => key !== "profile" || takesProfileFlag(command, verb)) as readonly FlagRef[];
  const out: Array<[string, ValueKind]> = [];
  const seen = new Set<string>();
  for (const ref of [...(flags ?? []), ...globals]) {
    const kind = valueKind(ref);
    if (kind === undefined) continue;
    for (const token of flagTokens(ref)) {
      if (seen.has(token)) continue;
      seen.add(token);
      out.push([token, kind]);
    }
  }
  return out;
}

/**
 * The global flags a scope accepts — every command takes them, so they were
 * missing from every command's list. `--profile` only where it is honoured: a
 * command that refuses it (`compile`, `profile use`) would be offered a flag
 * that fails.
 */
function globalTokens(command: string, verb: string | undefined): string[] {
  return GLOBAL_FLAGS.filter((key) => key !== "profile" || takesProfileFlag(command, verb))
    // A verb with its own `--version <v>` (an engine version) does not answer
    // the global `--version`/`-v` there, so neither is offered as the global.
    .filter((key) => key !== "version" || flagRefFor(command, verb, "engine-version") === undefined)
    // `env set` reads a `-v` as the VALUE and refuses `--version`, so neither is offered.
    .filter((key) => key !== "version" || !(command === "env" && verb === "set"))
    .flatMap((key) => flagTokens(key as FlagRef));
}

/** A scope's own flag tokens, then the globals it does not already list. */
function withGlobals(own: string[], command: string, verb: string | undefined): string[] {
  return [...new Set([...own, ...globalTokens(command, verb)])];
}

/**
 * The global flags offered before any command (`xanosdk --<Tab>`): all of them —
 * `--json`, `--no-refresh` and `--profile` are moved behind the command, and a
 * leading `--help`/`--version` is answered as it stands.
 */
function leadingGlobals(): string {
  return GLOBAL_FLAGS.flatMap((key) => flagTokens(key as FlagRef)).join(" ");
}

/** The `profile` verbs whose positional is a stored profile's name. */
const PROFILE_NAME_VERBS = ["use", "show", "delete", "set-default"] as const;

/**
 * Print the stored profile NAMES — the keys of the credential file's
 * `profiles`, never a value, so no token reaches a terminal — from the file the
 * command being typed would read, by the CLI's own rule: `--config`, else
 * $XANO_CONFIG, else `--local`'s project file; else `login`/`logout` write the
 * shared file, and every other command reads the project's `.xano/auth.json`
 * when it holds a profile, else the shared file. The shells pass the words
 * typed so far after `--`. Plain JS for `node -e` (xanosdk already needs node);
 * no single quote, so it embeds in a single-quoted shell word.
 */
const PROFILE_NAMES_JS = [
  'const fs=require("fs"),os=require("os"),p=require("path");',
  "const names=(f)=>{try{const j=JSON.parse(fs.readFileSync(f,\"utf8\"));",
  'const o=j&&typeof j.profiles==="object"&&j.profiles?j.profiles:null;',
  "return o?Object.keys(o).filter((n)=>/^[A-Za-z0-9._-]+$/.test(n)):[];}catch{return [];}};",
  "const a=process.argv.slice(1);let cfg,local=false,cmd;",
  "for(let i=0;i<a.length;i++){const w=a[i];",
  // bash splits `--config=/alt.json` at the `=` (COMP_WORDBREAKS): `--config`, `=`, `/alt.json`.
  'if(w==="--config"){cfg=a[++i];if(cfg==="=")cfg=a[++i];}else if(w.startsWith("--config="))cfg=w.slice(9);',
  'else if(w==="--local")local=true;else if(w==="-p"||w==="--profile"){i++;if(a[i]==="=")i++;}',
  'else if(!w.startsWith("-")&&cmd===undefined)cmd=w;}',
  // A leading `~` the shell left unexpanded (quoted, or after `--config=`) is the home directory.
  'const tl=(f)=>f&&(f==="~"||f.startsWith("~/"))?p.join(os.homedir(),f.slice(1)):f;',
  "cfg=tl(cfg||process.env.XANO_CONFIG);",
  "const localFile=()=>{const home=p.resolve(os.homedir()),start=process.cwd();let d=start;for(;;){",
  'if(["xano.profile.json","package.json",".git"].some((m)=>fs.existsSync(p.join(d,m))))return p.join(d,".xano","auth.json");',
  'const up=p.dirname(d);if(up===d||d===home)return p.join(start,".xano","auth.json");d=up;}};',
  'const shared=tl(process.env.XANO_GLOBAL_CONFIG)||p.join(os.homedir(),".xanosdk","auth.json");',
  "let file;if(cfg)file=cfg;else if(local)file=localFile();",
  'else if(cmd==="login"||cmd==="logout")file=shared;',
  "else{const l=localFile();file=names(l).length?l:shared;}",
  'const n=names(file);if(n.length)console.log(n.join(" "));',
].join("");

/** The `local-engine` verbs whose positional is an engine's name. */
const ENGINE_NAME_VERBS = ["stop", "token"] as const;

/**
 * The local engine records' home and file — `LOCAL_ENGINE_HOME_ENV` and
 * `LOCAL_ENGINE_STATE_FILE`, spelled here because this module stays free of
 * `node:*` (a test holds them equal).
 */
export const ENGINE_RECORDS = { homeEnv: "XANOSDK_LOCAL_ENGINE_HOME", file: "engines.json" } as const;

/**
 * Print the local engine NAMES this machine's records hold — read off the
 * records file, never by starting or asking an engine, so a Tab costs a file
 * read. A record may name an engine that has since stopped; `stop` answers that
 * as "not running" (E2E pass 27: `local-engine stop <Tab>` offered nothing).
 * Plain JS for `node -e`, no single quote.
 */
const ENGINE_NAMES_JS = [
  'const fs=require("fs"),os=require("os"),p=require("path");',
  `const home=process.env.${ENGINE_RECORDS.homeEnv}||p.join(os.homedir(),".xanosdk","local-engine");`,
  `try{const j=JSON.parse(fs.readFileSync(p.join(home,${JSON.stringify(ENGINE_RECORDS.file)}),"utf8"));`,
  'const e=j&&typeof j.engines==="object"&&j.engines?Object.values(j.engines):[];',
  'const n=[...new Set(e.map((r)=>r&&r.name).filter((x)=>typeof x==="string"&&/^[A-Za-z0-9._-]+$/.test(x)))];',
  'if(n.length)console.log(n.join(" "));}catch{}',
].join("");

function scopes(): Scope[] {
  const out: Scope[] = [];
  for (const name of liveCommandNames()) {
    const spec = getCommand(name)!;
    out.push({
      key: name,
      flags: withGlobals(tokensFor(visibleFlags(spec)), name, undefined),
      paths: wantsPaths(spec.args),
      values: firstArgValues(spec.args),
      valued: valuedFlags(visibleFlags(spec)),
      kinds: kindedFlags(visibleFlags(spec), name, undefined),
      inlineKinds: inlineKindedFlags(visibleFlags(spec)),
    });
    for (const verb of liveSubcommandNames(name)) {
      const sub = spec.subcommands![verb]!;
      out.push({
        key: `${name} ${verb}`,
        flags: withGlobals(tokensFor(visibleFlags(sub)), name, verb),
        paths: wantsPaths(sub.args),
        values: firstArgValues(sub.args),
        valued: valuedFlags(visibleFlags(sub)),
        kinds: kindedFlags(visibleFlags(sub), name, verb),
        inlineKinds: inlineKindedFlags(visibleFlags(sub)),
      });
    }
  }
  return out;
}

/** `[name, description]` for every top-level command. */
function commandRows(): Array<[string, string]> {
  return liveCommandNames().map((n) => [n, describe(getCommand(n)!.summary)]);
}

/** `[verb, description]` for a family, or an empty list for a leaf command. */
function subcommandRows(command: string): Array<[string, string]> {
  const spec = getCommand(command) as CommandSpec | undefined;
  return liveSubcommandNames(command).map((v) => [v, describe(spec!.subcommands![v]!.summary)]);
}

// ── bash ────────────────────────────────────────────────────────────────────

function renderBash(): string {
  const commands = liveCommandNames().join(" ");
  const subLines = liveCommandNames()
    .filter((c) => liveSubcommandNames(c).length > 0)
    .map((c) => `    ${c}) echo ${sq(liveSubcommandNames(c).join(" "))} ;;`);
  const flagLines = scopes()
    .filter((s) => s.flags.length > 0)
    .map((s) => `    ${sq(s.key)}) echo ${sq(s.flags.join(" "))} ;;`);
  // `case` alternatives are `|`-separated — a space-separated list parses as one
  // pattern containing spaces and bash rejects it outright.
  const pathLines = scopes()
    .filter((s) => s.paths)
    .map((s) => sq(s.key))
    .join("|");

  const valueLines = scopes()
    .filter((s) => s.values.length > 0)
    .map((s) => `    ${sq(s.key)}) echo ${sq(s.values.join(" "))} ;;`);
  const flagValueLines = scopes()
    .flatMap((s) => s.valued.map(([token, values]) => [`${s.key} ${token}`, values] as const))
    .map(([k, values]) => `    ${sq(k)}) echo ${sq(values.join(" "))} ;;`);
  const flagKindLines = scopes().flatMap((s) =>
    s.kinds.map(([token, kind]) => `    ${sq(`${s.key} ${token}`)}) echo ${kind} ;;`),
  );
  const inlineKindLines = scopes().flatMap((s) =>
    s.inlineKinds.map(([token, kind]) => `    ${sq(`${s.key} ${token}`)}) echo ${kind} ;;`),
  );

  // bash has no per-candidate descriptions, so this is names only. `compgen -f`
  // handles the path positions; everything else completes from the lists above.
  return `# xanosdk completion for bash. Regenerate after upgrading:
#   xanosdk completion bash > ~/.xanosdk-completion.bash
#   echo 'source ~/.xanosdk-completion.bash' >> ~/.bashrc

_xanosdk_subcommands() {
  case "$1" in
${subLines.join("\n")}
  esac
}

_xanosdk_flags() {
  case "$1" in
${flagLines.join("\n")}
  esac
}

_xanosdk_argvalues() {
  case "$1" in
${valueLines.join("\n")}
  esac
}

_xanosdk_flagvalues() {
  case "$1" in
${flagValueLines.join("\n")}
  esac
}

# What the argument of a value flag is when it has no closed set: file, dir, profile, or free.
_xanosdk_flagkind() {
  case "$1" in
${flagKindLines.join("\n")}
  esac
}

# The same, for a flag whose value is written only after \`=\` (\`--lock=<path>\`).
_xanosdk_inlinekind() {
  case "$1" in
${inlineKindLines.join("\n")}
  esac
}

# Stored profile names (keys only — never a token), from the file this line reads.
_xanosdk_profiles() {
  command -v node >/dev/null 2>&1 || return
  node -e ${sq(PROFILE_NAMES_JS)} -- "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null
}

# Local engine names, from the engine records on this machine — nothing is started.
_xanosdk_engines() {
  command -v node >/dev/null 2>&1 || return
  node -e ${sq(ENGINE_NAMES_JS)} 2>/dev/null
}

_xanosdk() {
  local cur cmd sub scope o=1
  cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()

  # Global flags typed before the command (\`xanosdk --json status\`) are
  # skipped, value and all: the command is the first word after them.
  while [ "$o" -lt "$COMP_CWORD" ]; do
    case "\${COMP_WORDS[o]}" in
      --json|--no-refresh|--profile=*) o=$((o + 1)) ;;
      -p|--profile)
        if [ "\${COMP_WORDS[o+1]}" = "=" ]; then o=$((o + 3)); else o=$((o + 2)); fi ;;
      *) break ;;
    esac
  done
  # Completing the value of a leading -p/--profile.
  if [ "$COMP_CWORD" -lt "$o" ]; then
    COMPREPLY=( $(compgen -W "$(_xanosdk_profiles)" -- "$cur") )
    return
  fi
  cmd="\${COMP_WORDS[o]}"
  sub="\${COMP_WORDS[o+1]}"

  # The first word after any leading global flags is the command; a dash there
  # is another global flag.
  if [ "$COMP_CWORD" -eq "$o" ]; then
    case "$cur" in
      -*) COMPREPLY=( $(compgen -W ${sq(leadingGlobals())} -- "$cur") ) ;;
      *) COMPREPLY=( $(compgen -W ${sq(commands)} -- "$cur") ) ;;
    esac
    return
  fi

  # \`help <command> [verb]\`: a command path, completed as one.
  if [ "$cmd" = help ]; then
    case "$cur" in
      -*) ;;
      *)
        if [ "$COMP_CWORD" -eq $((o + 1)) ]; then
          COMPREPLY=( $(compgen -W ${sq(commands)} -- "$cur") )
        elif [ "$COMP_CWORD" -eq $((o + 2)) ]; then
          COMPREPLY=( $(compgen -W "$(_xanosdk_subcommands "$sub")" -- "$cur") )
        fi
        return
        ;;
    esac
  fi

  # The word after a noun command is its verb.
  local subs
  subs="$(_xanosdk_subcommands "$cmd")"
  if [ "$COMP_CWORD" -eq $((o + 1)) ] && [ -n "$subs" ]; then
    COMPREPLY=( $(compgen -W "$subs" -- "$cur") )
    return
  fi

  scope="$cmd"
  if [ -n "$subs" ]; then scope="$cmd $sub"; fi

  # A dash starts a flag; anything else is a positional.
  case "$cur" in
    -*)
      COMPREPLY=( $(compgen -W "$(_xanosdk_flags "$scope")" -- "$cur") )
      return
      ;;
  esac

  # Directly after a flag that takes a value, that value, never the
  # positional of the command.
  local prev values kind eq=0
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  # bash splits \`--profile=prod\` at the \`=\` (COMP_WORDBREAKS): the flag is the
  # word before it, and a bare \`=\` under the cursor is an empty value.
  if [ "$cur" = "=" ]; then
    cur=""
    eq=1
  elif [ "$prev" = "=" ] && [ "$COMP_CWORD" -ge 2 ]; then
    prev="\${COMP_WORDS[COMP_CWORD-2]}"
    eq=1
  fi
  case "$prev" in
    -p|--profile)
      COMPREPLY=( $(compgen -W "$(_xanosdk_profiles)" -- "$cur") )
      return
      ;;
  esac
  values="$(_xanosdk_flagvalues "$scope $prev")"
  if [ -n "$values" ]; then
    COMPREPLY=( $(compgen -W "$values" -- "$cur") )
    return
  fi
  kind="$(_xanosdk_flagkind "$scope $prev")"
  # After \`--flag=\` the word is the value of that flag, never a positional.
  if [ -z "$kind" ] && [ "$eq" = 1 ] && [[ "$prev" == --* ]]; then
    kind="$(_xanosdk_inlinekind "$scope $prev")"
    [ -n "$kind" ] || kind=free
  fi
  case "$kind" in
    profile)
      COMPREPLY=( $(compgen -W "$(_xanosdk_profiles)" -- "$cur") )
      return
      ;;
    file|dir)
      compopt -o filenames 2>/dev/null
      local IFS=$'\\n'
      if [ "$kind" = dir ]; then COMPREPLY=( $(compgen -d -- "$cur") ); else COMPREPLY=( $(compgen -f -- "$cur") ); fi
      return
      ;;
    # A free-form value (a name, a number, a URL): nothing to offer, not even files.
    free)
      compopt +o default 2>/dev/null
      return
      ;;
  esac
  # A profile name: the one \`profile use|show|delete|set-default\` takes.
  case "$scope" in
    ${PROFILE_NAME_VERBS.map((v) => sq(`profile ${v}`)).join("|")})
      COMPREPLY=( $(compgen -W "$(_xanosdk_profiles)" -- "$cur") )
      return
      ;;
    # The engine name \`local-engine stop|token\` takes.
    ${ENGINE_NAME_VERBS.map((v) => sq(`local-engine ${v}`)).join("|")})
      COMPREPLY=( $(compgen -W "$(_xanosdk_engines)" -- "$cur") )
      return
      ;;
  esac

  # A positional can take both a closed set and a file (deploy <source>: a
  # backend kind or a bundle), so the set is offered and file names are
  # added after it rather than instead of it.
  values="$(_xanosdk_argvalues "$scope")"
  if [ -n "$values" ]; then
    COMPREPLY=( $(compgen -W "$values" -- "$cur") )
  fi

  case "$scope" in
    ${pathLines || "''"}) COMPREPLY+=( $(compgen -f -- "$cur") ) ;;
  esac
}

complete -o default -F _xanosdk xanosdk
`;
}

// ── zsh ─────────────────────────────────────────────────────────────────────

function renderZsh(): string {
  const commandBlock = commandRows()
    .map(([n, d]) => `    ${sq(`${n}:${d}`)}`)
    .join("\n");

  const familyBlocks = liveCommandNames()
    .filter((c) => liveSubcommandNames(c).length > 0)
    .map((c) => {
      const rows = subcommandRows(c)
        .map(([v, d]) => `        ${sq(`${v}:${d}`)}`)
        .join("\n");
      return `      ${c})\n        _xanosdk_verbs=(\n${rows}\n        )\n        ;;`;
    })
    .join("\n");

  const flagBlocks = scopes()
    .filter((s) => s.flags.length > 0)
    .map((s) => `      ${sq(s.key)}) _xanosdk_flags=(${s.flags.map(sq).join(" ")}) ;;`)
    .join("\n");

  const pathBlock = scopes()
    .filter((s) => s.paths)
    .map((s) => sq(s.key))
    .join("|");

  const valueBlocks = scopes()
    .filter((s) => s.values.length > 0)
    // A scope that also takes paths falls through to `_files` below, so
    // `deploy <Tab>` offers the backend kinds AND the files beside them.
    .map((s) => `      ${sq(s.key)}) compadd ${s.values.map(sq).join(" ")}${s.paths ? "" : "; return"} ;;`)
    .join("\n");

  const flagValueBlocks = scopes()
    .flatMap((s) => s.valued.map(([token, values]) => [`${s.key} ${token}`, values] as const))
    .map(([k, values]) => `      ${sq(k)}) compadd ${values.map(sq).join(" ")}; return ;;`)
    .join("\n");

  const zshKind: Record<ValueKind, string> = {
    file: "_files; return",
    dir: "_files -/; return",
    profile: "_xanosdk_profile_names; return",
    // A free-form value (a name, a number, a URL): nothing to offer.
    free: "return",
  };
  const flagKindBlocks = scopes()
    .flatMap((s) => s.kinds.map(([token, kind]) => `      ${sq(`${s.key} ${token}`)}) ${zshKind[kind]} ;;`))
    .join("\n");
  const inlineKindBlocks = scopes()
    .flatMap((s) => s.inlineKinds.map(([token, kind]) => `      ${sq(`${s.key} ${token}`)}) ${zshKind[kind]} ;;`))
    .join("\n");

  return `#compdef xanosdk
# xanosdk completion for zsh. Regenerate after upgrading:
#   xanosdk completion zsh > "\${fpath[1]}/_xanosdk"
#   # …then restart your shell, or: autoload -U compinit && compinit

# Stored profile names (keys only — never a token), from the file this line reads.
_xanosdk_profile_names() {
  (( $+commands[node] )) && compadd -- \${=$(node -e ${sq(PROFILE_NAMES_JS)} -- "\${(@)words[2,CURRENT-1]}" 2>/dev/null)}
}

_xanosdk() {
  local -a _xanosdk_commands _xanosdk_verbs _xanosdk_flags
  local cmd sub scope
  _xanosdk_commands=(
${commandBlock}
  )

  # Global flags typed before the command (\`xanosdk --json status\`) are
  # skipped, value and all: the command is the first word after them.
  local o=2
  while (( o < CURRENT )); do
    case "\${words[o]}" in
      --json|--no-refresh|--profile=*) (( o += 1 )) ;;
      -p|--profile) (( o += 2 )) ;;
      *) break ;;
    esac
  done
  # Completing the value of a leading -p/--profile.
  if (( CURRENT < o )); then
    _xanosdk_profile_names
    return
  fi

  if (( CURRENT == o )); then
    if [[ "\${words[CURRENT]}" == -* ]]; then
      compadd -- ${leadingGlobals().split(" ").map(sq).join(" ")}
    else
      _describe -t commands 'xanosdk command' _xanosdk_commands
    fi
    return
  fi

  cmd="\${words[o]}"
  case "$cmd" in
${familyBlocks}
  esac

  # \`help <command> [verb]\`: a command path, completed as one.
  if [[ "$cmd" == help && "\${words[CURRENT]}" != -* ]]; then
    if (( CURRENT == o + 1 )); then
      _describe -t commands 'xanosdk command' _xanosdk_commands
    elif (( CURRENT == o + 2 )); then
      cmd="\${words[o + 1]}"
      case "$cmd" in
${familyBlocks}
      esac
      (( \${#_xanosdk_verbs} )) && _describe -t subcommands "xanosdk $cmd subcommand" _xanosdk_verbs
    fi
    return
  fi

  if (( CURRENT == o + 1 )) && (( \${#_xanosdk_verbs} )); then
    _describe -t subcommands "xanosdk $cmd subcommand" _xanosdk_verbs
    return
  fi

  scope="$cmd"
  if (( \${#_xanosdk_verbs} )); then
    sub="\${words[o + 1]}"
    scope="$cmd $sub"
  fi

  case "$scope" in
${flagBlocks}
  esac

  # \`--flag=<value>\`: zsh keeps it one word, so the flag is what precedes its
  # \`=\`, and the value completes after it as it would after \`--flag \`.
  if [[ "\${words[CURRENT]}" == --*=* ]]; then
    local eqflag="\${words[CURRENT]%%=*}"
    compset -P "\${eqflag}="
    case "$eqflag" in
      --profile) _xanosdk_profile_names; return ;;
    esac
    case "$scope $eqflag" in
${flagValueBlocks}
${flagKindBlocks}
${inlineKindBlocks}
    esac
    return
  fi

  if [[ "\${words[CURRENT]}" == -* ]]; then
    compadd -a _xanosdk_flags
    return
  fi

  # Directly after a flag that takes a value, that value, never the
  # positional of the command.
  case "\${words[CURRENT-1]}" in
    -p|--profile) _xanosdk_profile_names; return ;;
  esac
  case "$scope \${words[CURRENT-1]}" in
${flagValueBlocks}
${flagKindBlocks}
  esac

  # A profile name: the one \`profile use|show|delete|set-default\` takes.
  case "$scope" in
    ${PROFILE_NAME_VERBS.map((v) => sq(`profile ${v}`)).join("|")})
      _xanosdk_profile_names
      return
      ;;
  esac
  # The engine name \`local-engine stop|token\` takes, from the engine records on this machine.
  case "$scope" in
    ${ENGINE_NAME_VERBS.map((v) => sq(`local-engine ${v}`)).join("|")})
      (( $+commands[node] )) && compadd -- \${=$(node -e ${sq(ENGINE_NAMES_JS)} 2>/dev/null)}
      return
      ;;
  esac

  case "$scope" in
${valueBlocks}
  esac

  case "$scope" in
    ${pathBlock || "'__none__'"}) _files ;;
  esac
}

_xanosdk "$@"
`;
}

// ── fish ────────────────────────────────────────────────────────────────────

/**
 * fish decides where it is with a helper, not with `__fish_seen_subcommand_from`.
 *
 * That builtin is true when ANY listed word appears ANYWHERE on the line, so a
 * scope keyed `workspace export` matched every line containing `export` —
 * offering the top-level `export`'s flags under `workspace export`, and
 * `release list` the flags of every scope that lists `list`. The helper reads
 * the scope the way the other two shells do: the first word is the command,
 * and — for a command with verbs — the second word is the verb.
 */
function renderFish(): string {
  const families = liveCommandNames().filter((c) => subcommandRows(c).length > 0);
  const valueFlags = new Set(valueFlagTokens());
  const lines: string[] = [
    "# xanosdk completion for fish. Regenerate after upgrading:",
    "#   xanosdk completion fish > ~/.config/fish/completions/xanosdk.fish",
    "",
    // Without this, fish offers files at every position.
    "complete -c xanosdk -f",
    "",
    "# The command, and for a command with verbs the verb, typed so far. A flag",
    "# is skipped, and so is the value of one that takes the next word",
    "# (`-p prof status` is `status`, not `prof`).",
    "function __xanosdk_scope",
    "    set -l typed (commandline -opc)",
    "    set -e typed[1]",
    "    set -l words",
    "    set -l skip 0",
    "    for w in $typed",
    "        if test $skip -eq 1",
    "            set skip 0",
    "            continue",
    "        end",
    "        switch $w",
    `            case ${[...valueFlags].map(sq).join(" ")}`,
    "                set skip 1",
    "            case '-*'",
    "            case '*'",
    "                set -a words $w",
    "        end",
    "    end",
    "    test (count $words) -ge 1; or return",
    `    if contains -- $words[1] ${families.map(sq).join(" ")}; and test (count $words) -ge 2`,
    '        echo "$words[1] $words[2]"',
    "    else",
    "        echo $words[1]",
    "    end",
    "end",
    "",
    "function __xanosdk_scope_is",
    "    set -l scope (__xanosdk_scope)",
    '    test "$scope" = "$argv[1]"',
    "end",
    "",
    "# No command typed yet — flags and their values aside.",
    "function __xanosdk_no_command",
    "    set -l scope (__xanosdk_scope)",
    '    test -z "$scope"',
    "end",
    "",
    "# `help` followed by exactly the words in $argv (flags aside) — the help",
    "# target typed so far, so the next word completes as a command or a verb.",
    "function __xanosdk_help_on",
    "    set -l typed (commandline -opc)",
    "    set -e typed[1]",
    "    set -l words",
    "    for w in $typed",
    "        switch $w",
    "            case '-*'",
    "            case '*'",
    "                set -a words $w",
    "        end",
    "    end",
    '    test "$words[1]" = help; or return 1',
    "    set -e words[1]",
    '    test "$words" = "$argv"',
    "end",
    "",
    "# Stored profile names (keys only — never a token), from the file this line reads.",
    "function __xanosdk_profiles",
    "    set -l words (commandline -opc)",
    "    command -q node; or return",
    `    node -e ${sq(PROFILE_NAMES_JS)} -- $words[2..-1] 2>/dev/null | string split ' '`,
    "end",
    "",
    "# Local engine names, from the engine records on this machine — nothing is started.",
    "function __xanosdk_engines",
    "    command -q node; or return",
    `    node -e ${sq(ENGINE_NAMES_JS)} 2>/dev/null | string split ' '`,
    "end",
    "",
    "# Directories for a directory flag's value. fish puts back a `--flag=` or `-f`",
    "# it read off the token, so only the value is completed — and `-f=`'s `=` is",
    "# part of what fish reads as the value.",
    "function __xanosdk_dirs",
    "    set -l tok (commandline -ct)",
    "    set -l lead ''",
    "    if string match -qr -- '^--[^=]*=' $tok",
    "        set tok (string replace -r -- '^--[^=]*=' '' $tok)",
    "    else if string match -qr -- '^-[A-Za-z]=' $tok",
    "        set lead '='",
    "        set tok (string sub -s 4 -- $tok)",
    "    end",
    "    for d in (__fish_complete_directories \"$tok\")",
    "        printf '%s%s\\n' $lead $d",
    "    end",
    "end",
    "",
  ];

  for (const [name, desc] of commandRows()) {
    lines.push(`complete -c xanosdk -n __xanosdk_no_command -a ${sq(name)} -d ${sq(desc)}`);
  }
  // `xanosdk --<Tab>`: the global flags, before any command.
  for (const token of leadingGlobals().split(" ")) lines.push(fishFlagLine("__xanosdk_no_command", token, valueFlags));

  // `help <command> [verb]`: a command path.
  for (const [name, desc] of commandRows()) {
    lines.push(`complete -c xanosdk -n '__xanosdk_help_on' -a ${sq(name)} -d ${sq(desc)}`);
  }
  for (const command of families) {
    for (const [verb, desc] of subcommandRows(command)) {
      lines.push(`complete -c xanosdk -n ${sq(`__xanosdk_help_on ${command}`)} -a ${sq(verb)} -d ${sq(desc)}`);
    }
  }

  for (const command of families) {
    lines.push("");
    // Only while the command is typed and its verb is not: the scope is the
    // bare command exactly then.
    const condition = `__xanosdk_scope_is ${sq(command)}`;
    for (const [verb, desc] of subcommandRows(command)) {
      lines.push(`complete -c xanosdk -n ${sq(condition)} -a ${sq(verb)} -d ${sq(desc)}`);
    }
  }

  lines.push("");
  for (const scope of scopes()) {
    if (scope.flags.length === 0 && !scope.paths && scope.values.length === 0) continue;
    const condition = `__xanosdk_scope_is ${sq(scope.key)}`;
    const values = new Map(scope.valued);
    const kinds = new Map(scope.kinds);
    for (const token of scope.flags) lines.push(fishFlagLine(condition, token, valueFlags, values.get(token), kinds.get(token)));
    if (scope.values.length > 0) {
      lines.push(`complete -c xanosdk -n ${sq(condition)} -a ${sq(scope.values.join(" "))}`);
    }
    // The name `profile use|show|delete|set-default` takes: a stored profile.
    if ((PROFILE_NAME_VERBS as readonly string[]).some((v) => scope.key === `profile ${v}`)) {
      lines.push(`complete -c xanosdk -n ${sq(condition)} -a '(__xanosdk_profiles)'`);
    }
    if ((ENGINE_NAME_VERBS as readonly string[]).some((v) => scope.key === `local-engine ${v}`)) {
      lines.push(`complete -c xanosdk -n ${sq(condition)} -a '(__xanosdk_engines)'`);
    }
    if (scope.paths) lines.push(`complete -c xanosdk -n ${sq(condition)} -F`);
  }

  return lines.join("\n") + "\n";
}

/**
 * One fish flag completion. fish wants the name without dashes, long vs short
 * split. A flag whose next word is its value takes one, so fish completes that
 * value instead of offering commands or flags there: a closed set, the stored
 * profile names, files or directories for a path, else nothing (a free-form
 * value). `-r` alone leaves fish's file completion on, so only a file value is
 * `-r -F`; every other value is `-x` (`-r -f`), which offers just its own list.
 */
function fishFlagLine(
  condition: string,
  token: string,
  valueFlags: ReadonlySet<string>,
  set?: readonly string[],
  kind?: ValueKind,
): string {
  const bare = token.replace(/^-+/, "");
  const which = token.startsWith("--") ? "-l" : "-s";
  const cond = /^[a-z_]+$/.test(condition) ? condition : sq(condition);
  const suffix =
    set !== undefined
      ? ` -x -a ${sq(set.join(" "))}`
      : kind === "profile" || token === "-p" || token === "--profile"
        ? " -x -a '(__xanosdk_profiles)'"
        : kind === "file"
          ? " -r -F"
          : kind === "dir"
            ? " -x -a '(__xanosdk_dirs)'"
            : valueFlags.has(token) || kind === "free"
              ? " -x"
              : "";
  return `complete -c xanosdk -n ${cond} ${which} ${sq(bare)}${suffix}`;
}

/** Render the completion script for one shell. */
export function renderCompletion(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return renderBash();
    case "zsh":
      return renderZsh();
    case "fish":
      return renderFish();
  }
}

/** The `completion` command: write the script to stdout (it is the requested artifact). */
export function runCompletionCommand(shell: CompletionShell): void {
  process.stdout.write(renderCompletion(shell));
}
