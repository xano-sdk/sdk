/**
 * Minimal, zero-dependency stderr UI for the CLI's human-facing progress output.
 *
 * Everything here writes to STDERR so stdout stays a clean data channel (a piped
 * bundle from `export`, the import response from `push`). Color is emitted only
 * when stderr is a TTY and the user hasn't opted out — honoring the `NO_COLOR`
 * convention (https://no-color.org) and `FORCE_COLOR` for the opposite — so piped
 * or CI logs stay plain ASCII with no escape-sequence noise.
 */
import { randomBytes } from "node:crypto";
import type { AnyWarningCode } from "../codes.js";
import { noteRunWarning } from "./output.js";

/**
 * Color-capable iff a real terminal on `isTTY` that understands escapes (not
 * `TERM=dumb`), not opted out (NO_COLOR), or force-enabled.
 */
function resolveColor(isTTY: boolean | undefined): boolean {
  return process.env.FORCE_COLOR
    ? process.env.FORCE_COLOR !== "0"
    : !process.env.NO_COLOR && isTTY === true && !dumbTerminal();
}

/** `TERM=dumb`: a terminal with no cursor control and no colour (an editor's shell buffer, say). */
function dumbTerminal(): boolean {
  return process.env.TERM === "dumb";
}

/**
 * The palette's styling is not an escape sequence until the moment it is
 * written. A palette function marks its text with a private token — a
 * Private Use Area bracket around this process's random nonce and the SGR
 * parameters — and {@link terminalText} turns exactly those tokens into SGR
 * after it has rendered every raw control character visibly. A value from a
 * server or a file cannot carry a token (it cannot know the nonce), so any
 * escape sequence it holds — colours, conceal, 256-colour, truecolour — is
 * shown, never obeyed, while the CLI's own colours still render.
 */
const MARK_OPEN = "\ue000";
const MARK_CLOSE = "\ue001";
const NONCE = Array.from(randomBytes(8), (b) => String.fromCharCode(0xe100 + b)).join("");
const mark = (code: string): string => `${MARK_OPEN}${NONCE}${code}${MARK_CLOSE}`;
const TOKEN = `${MARK_OPEN}${NONCE}([0-9;]+)${MARK_CLOSE}`;

/** A `style`-shaped palette whose color is gated on `on`. Its output is written through {@link terminalText}. */
function makePalette(on: boolean) {
  const paint = (code: string, s: string) => (on ? `${mark(code)}${s}${mark("0")}` : s);
  return {
    bold: (s: string) => paint("1", s),
    dim: (s: string) => paint("2", s),
    green: (s: string) => paint("32", s),
    red: (s: string) => paint("31", s),
    yellow: (s: string) => paint("33", s),
    cyan: (s: string) => paint("36", s),
  };
}

/** The shape every helper here (and the help renderer) paints through. */
export type Palette = ReturnType<typeof makePalette>;

/**
 * Small ANSI palette for the stderr progress UI (no-ops when color is disabled).
 * Color tracks STDERR, where every helper in this module writes.
 */
export const style = makePalette(resolveColor(process.stderr.isTTY));

/**
 * A palette for a human-facing view written to STDERR — the failure path's help
 * block. Built per call (rather than reusing {@link style}) so a test that flips
 * `NO_COLOR`/`FORCE_COLOR` mid-process sees the change; `style` is resolved once
 * at import time, which is right for the long-lived progress helpers and wrong
 * for a one-shot render.
 */
export function stderrStyle(): Palette {
  return makePalette(resolveColor(process.stderr.isTTY));
}

/**
 * A palette for a human-facing view a command prints to STDOUT (its data
 * channel) — so color tracks stdout's TTY, not stderr's. Built per call because
 * a command may only print to stdout when it detects a TTY there.
 */
export function stdoutStyle(): Palette {
  return makePalette(resolveColor(process.stdout.isTTY));
}

/**
 * The characters a terminal acts on rather than shows: C0 controls, DEL, C1
 * controls, and the bidi embedding/override/isolate marks that reorder a line.
 * A string from a server or a file carrying them can retitle the window,
 * clear the screen, write the clipboard (OSC 52) or make a name read backwards.
 * Matched here alone, with every stray token bracket; the palette's tokens are
 * matched whole so they survive.
 */
const SAFE_TEXT = new RegExp(`(${TOKEN})|[\\x00-\\x1f\\x7f-\\x9f\\u202a-\\u202e\\u2066-\\u2069\\ue000\\ue001]`, "g");

/** {@link SAFE_TEXT}, sparing the newlines and tabs that lay out a block. */
const TERMINAL_TEXT = new RegExp(`${TOKEN}|[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f\\u202a-\\u202e\\u2066-\\u2069\\ue000\\ue001]`, "g");

const TOKENS = new RegExp(TOKEN, "g");

const NAMED_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** One unsafe character as the escape a reader can see: `\x1b`, `\n`, `\u202e`. */
function visibleEscape(c: string): string {
  const named = NAMED_ESCAPES[c];
  if (named !== undefined) return named;
  const code = c.charCodeAt(0);
  return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * A server- or file-supplied value made safe to interpolate into one line of
 * human output: every control character — newlines and tabs included — and
 * every bidi override rendered as a visible escape. Use it on a name, label or
 * description line before it meets the CLI's own styling; `--json` output
 * carries the value unchanged.
 */
export function safeText(value: string): string {
  return value.replace(SAFE_TEXT, (match, token: string | undefined) => token ?? visibleEscape(match));
}

/**
 * Names from a file — stored profile names above all — as a quoted,
 * comma-separated list for one line of human output, each through
 * {@link safeText} so a newline in a hand-edited name cannot start a line of
 * its own.
 */
export function quotedNames(names: readonly string[]): string {
  return names.map((n) => `"${safeText(n)}"`).join(", ");
}

/**
 * The same text with every absolute URL replaced by a placeholder.
 *
 * Deliberately blunt: it removes the whole URL rather than trying to strip the
 * signature out of it, because "which part of this link is the secret" is a
 * question that has a different answer per storage provider, and getting it
 * wrong prints the credential. Nothing downstream needs the URL — the action
 * that failed is already named in the sentence around it. Punctuation that
 * ends the URL's sentence is kept.
 */
export function withoutUrls(message: string): string {
  // Lazy up to trailing punctuation, so "could not reach <url>: fetch failed"
  // keeps the colon the sentence put after the URL.
  return message.replace(/\bhttps?:\/\/\S+?(?=[.,:;!?)\]'"]*(?:\s|$))/gi, "<url>");
}

/** `text` without the palette's styling: for a channel that is not a terminal, such as a `--json` document. */
export function plainText(text: string): string {
  return text.replace(TOKENS, "");
}

/**
 * Text as it is written to the terminal — every writer in this module, and any
 * other write of text that holds the palette's styling, sends it through here
 * once, last. The newlines and tabs that lay it out are kept and the palette's
 * styling becomes SGR; every other control character — an escape sequence of
 * any kind that arrived inside an interpolated value — is rendered visibly, so
 * it is shown, never obeyed.
 */
export function terminalText(text: string): string {
  return text.replace(TERMINAL_TEXT, (match, code: string | undefined) =>
    code !== undefined ? `\x1b[${code}m` : visibleEscape(match),
  );
}

/** Human output on STDOUT, through {@link terminalText}. The caller supplies line breaks. */
export function printHuman(text: string): void {
  process.stdout.write(terminalText(text));
}

/**
 * An `id  guid  "name"` listing, aligned on the widest id and guid.
 *
 * Shared so every place that prints a table agrees on its shape: the three
 * `tables` verbs and the foreign-guid refusal that tells you to run one. A
 * fixed-width pad misaligns past its own width, and a bare name hides a
 * trailing space or a comma — both of which a Xano table name may contain,
 * since the engine declares it as unfiltered free text.
 *
 * Column order carries the reason each column is here. The id is recognition —
 * other engine surfaces and URLs show it — the guid is what `--seed` selects by
 * and what the reader came to copy, and the name is last because it is the only
 * column of unbounded width, so anywhere else it would push the other two out
 * of alignment. Guids come in two lengths (32-char hex from the SDK, ~27-char
 * base64url from the engine), so that column is padded too rather than assumed
 * uniform.
 */
export function formatTableListing(
  rows: readonly { id: number; guid: string; name: string }[],
  indent = "",
): string {
  // `Math.max(...[])` is -Infinity, which pads to a RangeError. Every call site
  // guards today; this keeps the next one from finding out the hard way.
  if (rows.length === 0) return "";
  const idWidth = Math.max(...rows.map((r) => String(r.id).length));
  const guidWidth = Math.max(...rows.map((r) => r.guid.length));
  return rows
    .map(
      (r) =>
        `${indent}${String(r.id).padStart(idWidth)}  ${r.guid.padEnd(guidWidth)}  ${safeText(JSON.stringify(r.name))}`,
    )
    .join("\n");
}

/**
 * Lay out label→value rows as an aligned, indented block (trailing newline
 * included), for {@link printHuman}. Labels are dimmed and padded to a common
 * width so values line up; callers pre-color values as they like. Each row is
 * one line by construction: a value — and anything a server or a file put in
 * it — goes through {@link safeText}, so a newline or carriage return in it is
 * shown and can never forge the row below. Padding is applied to the raw label
 * BEFORE dimming, so styling never skews the alignment.
 */
export function formatFields(rows: Array<[label: string, value: string]>): string {
  const s = stdoutStyle();
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${s.dim(safeText(label).padEnd(width))}  ${safeText(value)}`).join("\n") + "\n";
}

/** A primary progress step (`→ …`). */
export function step(msg: string): void {
  process.stderr.write(terminalText(`${style.cyan("→")} ${msg}\n`));
}

/** A successful outcome (`✓ …`, green). */
export function success(msg: string): void {
  process.stderr.write(terminalText(`${style.green("✓")} ${msg}\n`));
}

/**
 * A fatal outcome (`✗ …`, red). The counterpart to {@link success}: every way
 * the CLI can end now has a glyph, so a failed run reads as a designed state
 * rather than an unstyled sentence.
 */
export function error(msg: string): void {
  process.stderr.write(terminalText(`${stderrStyle().red("✗")} ${msg}\n`));
}

/**
 * A multi-line message laid out under its glyph: every continuation line
 * indented by `pad`, so a second line ("The request was sent, …") reads as part
 * of the line above rather than as a new, unmarked one flush against the
 * margin. The rule `reportFailure` applies under a `✗` (`indentContinuation`),
 * here for the other glyphs. A message whose continuation lines are ALL
 * indented already laid itself out and is left as written; blank lines stay
 * blank.
 */
function continued(msg: string, pad: string): string {
  const [head, ...rest] = msg.split("\n");
  if (rest.length === 0) return msg;
  const text = rest.filter((line) => line.trim() !== "");
  if (text.length > 0 && text.every((line) => /^\s/.test(line))) return msg;
  return [head, ...rest.map((line) => (line.trim() === "" ? "" : `${pad}${line}`))].join("\n");
}

/**
 * A non-fatal warning (`! …`, yellow). Continuation lines sit under its text,
 * and each of `remedies` is printed as a detail line under it.
 *
 * Also recorded under `code` for this run's `--json` document — its
 * `warnings[]` carries `{ code, message }` with the remedies appended one per
 * line — so every `!` line stderr prints is in the JSON too. `code` is required
 * and stable, dotted by area (`pull.no-git`, `deploy.tenant-write`); a static
 * test fails on a call without one. A plain `warn()` is a NOTICE: `--strict`
 * fails on build diagnostics and the export's own warnings, never on these.
 */
export function warn(
  msg: string,
  code: AnyWarningCode,
  remedies: readonly string[] = [],
  /** What `--json` carries in place of the printed text — a capped list's full form. */
  machine?: string,
): void {
  process.stderr.write(terminalText(`${style.yellow("!")} ${continued(msg, "  ")}\n`));
  for (const line of remedies) detail(line);
  noteRunWarning(code, machine ?? [msg, ...remedies].join("\n"));
}

/**
 * An informational FYI (`i …`, cyan) — guidance, not a problem. Distinct from
 * {@link warn}'s yellow `!` so a clean run's advisories don't scan as warnings
 * in CI logs. Still on stderr, so stdout stays a clean data channel.
 */
export function info(msg: string): void {
  process.stderr.write(terminalText(`${style.cyan("i")} ${msg}\n`));
}

/**
 * A dim, indented detail line under the preceding step/outcome. A multi-line
 * detail (a failure's message and its aftermath) keeps every line at that
 * indent, not only the first.
 */
export function detail(msg: string): void {
  process.stderr.write(terminalText(`  ${style.dim(continued(msg, "  "))}\n`));
}

/**
 * A highlighted, indented URL under the preceding outcome — bold cyan so the
 * deploy's payoff (the backend + static-host URLs you'll actually open) stands
 * out from the dim {@link detail} lines around it.
 */
export function link(url: string): void {
  process.stderr.write(terminalText(`  ${style.bold(style.cyan(url))}\n`));
}

/** A blank separator line. */
export function blank(): void {
  process.stderr.write("\n");
}

/**
 * A duration as a reader counts it: `840ms` under a second, `12.4s` under a
 * minute, `1m 04s` beyond. Sub-second runs keep milliseconds because "0.8s" and
 * "0.2s" are the same sentence to a reader and a very different feeling.
 *
 * Matches the spinner's own `(12s)` register — the outcome line is the same
 * measurement, held still — and is deliberately a HUMAN string: nothing machine
 * readable is derived from it, so a summary a wrapper parses never carries it.
 */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.round((safe % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * The dim `(12.4s)` a completed step trails, given the `Date.now()` it started
 * at. Returned (not printed) so it composes into the caller's own outcome line.
 */
export function elapsedSuffix(startedAt: number, now: number = Date.now()): string {
  return ` ${style.dim(`(${formatDuration(now - startedAt)})`)}`;
}

/** A live progress line. Calls are safe (and silent) after {@link Spinner.stop}. */
export interface Spinner {
  /** Replace the label shown next to the frame (e.g. a readiness ratio). */
  update(msg: string): void;
  /** Erase the line (TTY) and stop animating. Idempotent. */
  stop(): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_FRAME_MS = 80;

/**
 * Show an animated, self-erasing progress line for an operation that would
 * otherwise sit silent — a poll loop with a multi-minute budget (a fresh
 * ephemeral provisioning, microservices coming up) reads as a hung CLI without
 * one. The elapsed seconds are part of the point: they're what tells you the
 * wait is progressing rather than stuck.
 *
 * Animates only on a real terminal. Anywhere else (a pipe, CI, a test) it prints
 * the label once as a {@link detail} line and nothing further, so logs keep the
 * same single-line record they had before and never accumulate frames.
 *
 * `stop()` erases the line, so the caller's own outcome line — `✓ …` / `! …` —
 * is what remains. Always stop in a `finally`: an escaping error must not leave
 * a stray frame or a live interval behind.
 */
export function spinner(msg: string): Spinner {
  let text = msg;

  if (process.stderr.isTTY !== true || dumbTerminal()) {
    detail(msg);
    return { update: () => {}, stop: () => {} };
  }

  const start = Date.now();
  let frame = 0;
  let live = true;

  const clear = () => process.stderr.write("\r\x1b[2K");
  const render = () => {
    const secs = Math.round((Date.now() - start) / 1000);
    const suffix = secs >= 1 ? ` ${style.dim(`(${secs}s)`)}` : "";
    clear();
    process.stderr.write(terminalText(`${style.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] as string)} ${style.dim(text)}${suffix}`));
    frame += 1;
  };

  render();
  const timer = setInterval(render, SPINNER_FRAME_MS);
  // Never hold the process open on the animation alone: whatever we're waiting
  // for owns the event loop, and an un-unref'd interval would outlive a caller
  // that forgot to stop it.
  timer.unref();

  const self: Spinner = {
    update(next: string): void {
      text = next;
    },
    stop(): void {
      if (!live) return;
      live = false;
      liveSpinners.delete(self);
      clearInterval(timer);
      clear();
    },
  };
  liveSpinners.add(self);
  return self;
}

/**
 * Spinners currently animating a line. A spinner erases its own line on `stop()`,
 * but Ctrl-C never reaches the `finally` that would call it — so the signal
 * handler needs a way to reach in and wipe the half-drawn frame before printing
 * its own outcome. A Set (rather than a single slot) because nothing stops two
 * from overlapping, and a leftover frame is exactly what this exists to prevent.
 */
const liveSpinners = new Set<Spinner>();

/**
 * Erase any in-progress spinner line, leaving the cursor at column 0 on a clean
 * line. Safe to call when nothing is animating. For interrupt handling — the
 * normal path stops its own spinner in a `finally`.
 */
export function clearProgress(): void {
  for (const spin of [...liveSpinners]) spin.stop();
}

/** Run `work` under a {@link spinner}, erasing the line however it settles. */
export async function withSpinner<T>(msg: string, work: () => Promise<T>): Promise<T> {
  const spin = spinner(msg);
  try {
    return await work();
  } finally {
    spin.stop();
  }
}

/**
 * Render an ephemeral expiry (the API serializes it as `"2026-07-24 20:49:15+0000"`,
 * or tolerate a raw unix-epoch number) as a human "in Xh Ym" string, or "expired"
 * once it has passed. Shared by `deploy`, `ephemeral list`, and `ephemeral get`
 * so the countdown reads identically everywhere. Falls back to the raw value if
 * it can't be parsed, and "—" when absent.
 */
export function formatExpiration(expiresAt: string | number | undefined | null): string {
  if (expiresAt === undefined || expiresAt === null || expiresAt === "") return "—";
  const ms = typeof expiresAt === "number" ? expiresAt * 1000 : Date.parse(String(expiresAt).replace(" ", "T"));
  if (Number.isNaN(ms)) return String(expiresAt);
  const diff = (ms - Date.now()) / 1000;
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  return `in ${hours}h ${minutes}m`;
}

/**
 * Where a command is about to WRITE: the base its routes are appended to, the
 * workspace inside it, and — only when the destination is not the one the
 * credential names — how that destination calls itself (`tenant "prod"`).
 *
 * Structurally a subset of `env-target.ts`'s `MetaTarget`, so a resolved
 * destination can be handed straight in.
 */
export interface WriteTarget {
  readonly base: string;
  readonly workspaceId: number;
  /**
   * A destination the credential does not describe. Left out for the
   * credential's own workspace, where it would only repeat the word "workspace".
   */
  readonly label?: string;
  /**
   * Which hosted kind this is, for the machine payload's `kind` field — the one
   * field name for a backend kind in machine output. Optional so the callers
   * that have not named it yet keep their payload unchanged; a caller holding a
   * resolved source passes its `kind`.
   */
  readonly kind?: "workspace" | "ephemeral" | "tenant";
}

/**
 * A destination that is not a hosted Xano instance at all: an engine running on
 * the developer's own machine.
 *
 * Its own shape rather than a {@link WriteTarget} with a loopback `base`,
 * because the rendering has to SAY so. Rendered through the hosted path, a local
 * engine reads as `127.0.0.1:4200 · workspace 1` — indistinguishable from a
 * self-hosted instance that happens to be reached over a tunnel, which is
 * exactly the confusion the disclosure exists to prevent.
 */
export interface LocalEngineTarget {
  readonly kind: "local-engine";
  /** The engine's base URL, loopback by construction. */
  readonly url: string;
  readonly workspaceId: number;
}

/** Either destination a writing command can disclose. */
export type DisclosureTarget = WriteTarget | LocalEngineTarget;

function isLocalEngine(target: DisclosureTarget): target is LocalEngineTarget {
  return "kind" in target && target.kind === "local-engine";
}

/**
 * The two facts a mistargeted run turns on, as one phrase:
 * `app.xano.com · workspace 12`, or `tenant "prod" — prod.xano.io · workspace 1`,
 * or `local engine · 127.0.0.1:4200 · workspace 1`.
 *
 * Returned rather than printed because the commands disagree about where it
 * belongs — see {@link discloseWriteTarget} — and both renderings have to be the
 * same string, or a reader comparing two commands' output has to decide whether
 * two different-looking lines name the same backend.
 */
export function describeWriteTarget(target: DisclosureTarget): string {
  if (isLocalEngine(target)) {
    // The words come first, before anything a reader could mistake for a host
    // they recognize: what this line has to establish is that nothing here is
    // on a Xano instance at all.
    return `local engine · ${hostLabel(target.url)} · workspace ${target.workspaceId}`;
  }
  const where = `${hostLabel(target.base)} · workspace ${target.workspaceId}`;
  return target.label === undefined || target.label === "" ? where : `${target.label} — ${where}`;
}

/**
 * Say where a command is about to write, as a dim detail line under its step.
 *
 * `release` names its target INSIDE its step line (`Releasing … → app.xano.com ·
 * workspace 12`); `deploy`'s step already spends its width on the entry file and
 * the environment, so the same two facts ride a detail line beneath it. Either
 * way it is said once, and said BEFORE the write — which is what makes a
 * wrong-account run visible at the moment it can still be stopped, rather than a
 * receipt for something already landed.
 *
 * The destination is an ARGUMENT, never read off the credential here. A
 * credential describes the workspace it is bound to, and `tenant deploy` lands
 * on a tenant's own base with its own internal workspace — so a
 * credential-derived line would confidently name the wrong backend, which under
 * a rule that exists to catch mistargeting is worse than no line at all. Each
 * command passes what it is about to write to.
 *
 * Deliberately not wired into the dispatcher for every authenticated command: an
 * authenticated command is not necessarily a writing one, and a read that
 * announces a destination trains the reader to skim the line the writes depend on.
 */
export function discloseWriteTarget(target: DisclosureTarget): void {
  detail(`on ${describeWriteTarget(target)}`);
}

/**
 * The destination for a command that writes to the workspace its CREDENTIAL is
 * bound to, and nowhere else.
 *
 * Most adopters must pass the destination explicitly, because what they write to
 * is not what their credential describes — that is the whole reason
 * {@link discloseWriteTarget} takes an argument. This helper is for the minority
 * where the two genuinely coincide, so that "the credential is the destination"
 * is a claim made in ONE place a reader can check, rather than an identical
 * object literal repeated at each site where it happens to be true.
 *
 * Deliberately takes the two fields rather than a credential: `ui.ts` is the
 * presentation layer and must not import the auth module to render a line.
 *
 * Carries `kind: "workspace"`, so every machine `destination` built from it
 * names its kind as an ephemeral's or tenant's does — `workspace branch
 * delete|set-live` and `workspace reset-tables` reported `{ instance,
 * workspaceId }` alone. The text line does not read it.
 */
export function credentialWriteTarget(binding: { instance: string; workspaceId: number }): WriteTarget {
  return { base: binding.instance, workspaceId: binding.workspaceId, kind: "workspace" };
}

/**
 * The same destination for a `--json` caller, who reads stdout and never sees the
 * progress stream. One shape across every command that writes, so a wrapper
 * checking "did this land where I meant" reads the same two keys everywhere.
 *
 * `instance` carries the full base URL rather than the host: it is the value a
 * wrapper compares against its own configuration, and `hostLabel` is a reading
 * aid that drops information.
 *
 * A local engine carries `local: true` alongside it. A wrapper must not have to
 * infer "this is not a hosted backend" from the shape of a URL — a loopback
 * address is a fact about the network, not about what kind of destination this
 * was — and the flag is absent, not `false`, everywhere else, so its presence
 * is the signal.
 *
 * A hosted destination whose caller named its kind carries it as `kind`
 * (`workspace`, `ephemeral`, `tenant`), so a wrapper reads which backend kind
 * received the write from the same field every other machine output uses.
 */
export function writeTargetPayload(target: DisclosureTarget): {
  instance: string;
  workspaceId: number;
  label?: string;
  kind?: "workspace" | "ephemeral" | "tenant" | "local-engine";
  local?: true;
} {
  if (isLocalEngine(target)) {
    return { instance: target.url, workspaceId: target.workspaceId, kind: "local-engine", local: true };
  }
  return {
    instance: target.base,
    workspaceId: target.workspaceId,
    ...(target.label === undefined || target.label === "" ? {} : { label: target.label }),
    ...(target.kind === undefined ? {} : { kind: target.kind }),
  };
}

/**
 * The machine `destination` for a write to an ephemeral or a tenant: the ONE
 * shape every command reports it in.
 *
 * `instance` and `workspaceId` are the PARENT's — the instance and workspace it
 * lives under — because an ephemeral's or tenant's own URL could never match
 * the instance a wrapper has configured. `label` is its bare name (the handle
 * every verb takes, never prose), `url` its own base URL, and `display` the
 * name people call it, when its record carries one:
 * `{ instance, workspaceId, kind, label, url, display? }`.
 */
export function backendDestinationPayload(
  parent: { readonly instance: string; readonly workspaceId: number },
  backend: { readonly kind: "ephemeral" | "tenant"; readonly name: string; readonly url: string; readonly display?: string },
): ReturnType<typeof writeTargetPayload> & { url: string; display?: string } {
  return {
    ...writeTargetPayload({
      base: parent.instance.replace(/\/$/, ""),
      workspaceId: parent.workspaceId,
      label: backend.name,
      kind: backend.kind,
    }),
    url: backend.url,
    ...(backend.display === undefined || backend.display === "" ? {} : { display: backend.display }),
  };
}

/**
 * A human-friendly label for an origin: drop the scheme (and any trailing slash)
 * so `https://app.xano.com/` reads as `app.xano.com`. Falls back to the raw
 * string if it isn't a parseable URL.
 */
export function hostLabel(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}
