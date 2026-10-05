/**
 * Managed blocks: a span of generated content the SDK owns, living inside a file
 * the USER owns.
 *
 * This is the only safe shape for `.gitattributes`, `AGENTS.md` and anything else
 * git or an agent reads one-file-per-directory: the SDK cannot render its own file
 * beside theirs, so it has to write INTO theirs. Without a boundary the only
 * options are "write once and never touch it again" — which freezes the content at
 * whatever shipped the day the project was scaffolded — or "overwrite", which
 * throws away the user's own notes and rules.
 *
 * Everything here is a PURE STRING FUNCTION. No `node:fs`, no prompts, no UI: the
 * unit that does the file I/O composes these, and keeping the splice logic
 * filesystem-free is what makes every corruption mode below testable in-memory.
 */

/**
 * How one family of files spells a block.
 *
 * Generalized on a DIALECT VALUE, not on a comment character, and the reason is
 * concrete rather than stylistic: the agent-guidance markers are fixed HTML
 * sentinels carrying no package name (`<!-- BEGIN:xanosdk-agent-rules -->`), and
 * files written by earlier SDK versions are sitting on users' disks right now. A
 * composer parameterized only by comment syntax could not find those markers and
 * would APPEND A DUPLICATE BLOCK into a hand-written `AGENTS.md` — exactly the
 * corruption this module exists to prevent. A dialect can be pinned to literal
 * legacy strings; a comment character cannot.
 */
export interface BlockDialect {
  /** The opening marker line for `pkg`. A dialect may ignore `pkg` (legacy sentinels do). */
  readonly begin: (pkg: string) => string;
  /** The closing marker line for `pkg`. */
  readonly end: (pkg: string) => string;
  /** The stamp line recording which SDK version generated the body. */
  readonly stamp: (version: string) => string;
  /** Read the version back out of a composed block, or null when it carries no stamp. */
  readonly parseStamp: (block: string) => string | null;
}

/** Which block, in which file — the file only so errors can name it. */
export interface BlockSpec {
  readonly dialect: BlockDialect;
  /** Package name the block belongs to, so several packages' blocks coexist in one file. */
  readonly pkg: string;
  /** Path used in error messages. Purely cosmetic; no I/O is done with it. */
  readonly file?: string;
}

/** A located block: `[start, end)` over the source text, markers included. */
export interface BlockSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The result of a splice, with the signal a caller needs to skip an unnecessary write. */
export interface BlockEdit {
  readonly text: string;
  /**
   * False when `text` is byte-identical to the input. A caller that writes anyway
   * bumps the file's mtime on every run, which is how a tool earns a place in
   * someone's `.gitignore` — and mtime is what the idempotency requirement asserts.
   */
  readonly changed: boolean;
}

/**
 * `# xanosdk:begin <pkg>` / `# xanosdk:end <pkg>` — for files whose comment character
 * is `#`, `.gitattributes` above all.
 *
 * Package-keyed and whitespace-delimited, so a scoped name (`@xano-sdk/xanoscript`)
 * is safe in the marker without quoting, and so a file can carry one block per
 * contributing package.
 */
export const HASH_DIALECT: BlockDialect = {
  begin: (pkg) => `# xanosdk:begin ${pkg}`,
  end: (pkg) => `# xanosdk:end ${pkg}`,
  stamp: (version) => `# xanosdk ${version} — generated; edits inside this block are overwritten`,
  parseStamp: (block) => /^# xanosdk (\S+) — generated/m.exec(block)?.[1] ?? null,
};

/**
 * `<!-- BEGIN:<name> -->` / `<!-- END:<name> -->` — for Markdown, whose only comment
 * is HTML's, with the stamp in the same syntax so it stays invisible when rendered.
 *
 * Keyed on a NAME rather than a package, and not by preference: the module's
 * marker checks derive the package-independent prefix from `begin("")` (see
 * {@link assertNoForgedMarkers} and {@link linesOutsideBlocks}), which needs the
 * package to be the marker's TAIL — and an HTML comment cannot end with its
 * package, because `-->` has to follow it. So a Markdown file carries one block
 * per name, and the name says what the block holds: the agent brief's
 * `xanosdk-agent-rules`, the README's `xanosdk-built-with`.
 */
export function htmlDialect(name: string): BlockDialect {
  const begin = `<!-- BEGIN:${name} -->`;
  const end = `<!-- END:${name} -->`;
  return {
    begin: () => begin,
    end: () => end,
    stamp: (version) => `<!-- xanosdk ${version} — generated; edits inside this block are overwritten -->`,
    parseStamp: (block) => /<!-- xanosdk (\S+) — generated/.exec(block)?.[1] ?? null,
  };
}

/** Git's conflict markers, as they appear at the start of a line. */
const CONFLICT_MARKERS = ["<<<<<<<", ">>>>>>>"] as const;

/**
 * Compose a block: markers naming `pkg`, a version stamp, then the body.
 *
 * The stamp is what lets a later run tell CURRENT from STALE without diffing
 * bodies — a diff would also fire on a user's whitespace edit inside the block,
 * and re-writing on every invocation is the mtime churn `BlockEdit.changed` exists
 * to avoid.
 *
 * Leading and trailing blank lines are trimmed off the body: the SDK owns the
 * separation BETWEEN blocks, so a contribution that pads its own edges would
 * compound with that and drift. Contributed lines are otherwise verbatim.
 *
 * An EMPTY contribution composes to the empty string, which {@link upsertBlock}
 * reads as "remove the block". That is the path a module takes when its feature is
 * switched off: a stale block left behind would keep applying a rule the user just
 * turned off, which is worse than never having written one.
 *
 * A body line that SPELLS A MARKER is refused here, and not only at the callers
 * that validate contributions. Blocks are located by COUNTING markers (see
 * {@link locate}), so one forged line composes a block that is unbalanced the
 * moment it is written, and every command that could repair it throws on the
 * same count — a file only a hand edit can rescue. A composer that cannot
 * author that shape is one no future caller can make author it by forgetting a
 * check of its own.
 *
 * Always emits LF. {@link upsertBlock} re-renders to whatever the target file uses.
 */
export function composeBlock(spec: BlockSpec, lines: readonly string[], version: string): string {
  const body = trimBlankEdges(lines.flatMap((line) => line.split(/\r?\n/)));
  if (body.length === 0) return "";
  const { dialect, pkg } = spec;
  assertNoForgedMarkers(body, spec);
  return [dialect.begin(pkg), dialect.stamp(version), "", ...body, dialect.end(pkg)].join("\n");
}

/**
 * Refuse a body line that would be read back as a marker.
 *
 * The prefixes come from the DIALECT (`begin("")`/`end("")`), never retyped —
 * the same derivation {@link linesOutsideBlocks} uses, and for the same reason:
 * a literal copy stops matching the day a second dialect appears. A dialect
 * whose markers ignore the package yields the whole marker line, which
 * `startsWith` matches just as exactly.
 *
 * Cross-package matters as much as own-package. `@a/one` contributing
 * `# xanosdk:begin @a/two` leaves @a/two's block unlocatable, so what is refused
 * is the marker PREFIX, not this block's own two marker lines.
 */
function assertNoForgedMarkers(body: readonly string[], spec: BlockSpec): void {
  const { dialect, pkg } = spec;
  const where = spec.file === undefined ? "" : ` in ${spec.file}`;
  const markers = [dialect.begin("").trim(), dialect.end("").trim()];
  for (const line of body) {
    const trimmed = line.trim();
    if (!markers.some((marker) => trimmed.startsWith(marker))) continue;
    throw new Error(
      `xanosdk managed block for ${pkg}${where} would contain a line that spells a block ` +
        `marker (${trimmed}). Writing it would leave the file with markers no run can ` +
        "balance, and every command that could repair it reads the same count.",
    );
  }
}

/**
 * The `.gitattributes` block identity — the one definition of it.
 *
 * `init` writes that file from scratch and the reconciler splices it in place;
 * both have to name the same block for the same package or the second would
 * append beside the first instead of replacing it. So the spec is composed
 * here, in the module that owns the grammar, rather than twice at the callers.
 */
export function gitattributesSpec(pkg: string): BlockSpec {
  return { dialect: HASH_DIALECT, pkg, file: ".gitattributes" };
}

/**
 * Every non-blank line of `text` that lies OUTSIDE every package's managed
 * block, trimmed — what a caller needs to tell an unmarked hand-written rule
 * from one the SDK already owns.
 *
 * Marker lines are recognized through the DIALECT, never as hardcoded strings:
 * the grammar is this module's and a copy of it at a caller silently stops
 * working the day a second dialect is used. `begin("")`/`end("")` give the
 * marker's package-independent PREFIX — the pkg is the whole-line tail, and a
 * dialect that ignores pkg (the legacy sentinels) yields the full marker line,
 * which `startsWith` matches just as exactly.
 *
 * Unlike {@link findBlock} this cannot be occurrence-COUNTED per package,
 * because the caller does not know which packages the file carries blocks for —
 * including one whose module is no longer installed. An unbalanced file is not
 * refused here either: this feeds a WARNING, and a scan that throws would turn
 * a courtesy into a failure. The balance refusal stays with the splice.
 */
export function linesOutsideBlocks(text: string, dialect: BlockDialect): string[] {
  const begin = dialect.begin("");
  const end = dialect.end("");
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(begin)) inside = true;
    else if (trimmed.startsWith(end)) inside = false;
    else if (!inside && trimmed !== "") out.push(trimmed);
  }
  return out;
}

/**
 * Every package `text` carries a block for, in first-marker order.
 *
 * The enumerator the REMOVAL pass needs. Removal is otherwise derived from the
 * `"xanosdk"` config block alone, so a marked block whose config entry is gone is
 * an ORPHAN: nothing owns it, nothing drops it, and its rules keep applying
 * forever. That state is manufactured by the CLI's own advice — `marketplace
 * remove` refuses a module recorded `enabled: false` and tells the reader to
 * delete its config entry. Unioning this with the block's keys is what lets a
 * reconcile drop a span belonging to a package that is neither a dependency nor
 * configured.
 *
 * Read off BEGIN markers alone, and deliberately: an END with no BEGIN is half
 * a block, which the SPLICE refuses by name. A scan that threw here would turn
 * "which packages does this file mention" into a failure — the same posture
 * {@link linesOutsideBlocks} takes.
 *
 * Only a package-keyed dialect can be enumerated. One whose markers ignore the
 * package (the legacy agent sentinels) yields the empty name, which is not a
 * package and is skipped.
 */
export function blockPackages(text: string, dialect: BlockDialect): string[] {
  const begin = dialect.begin("");
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(begin)) continue;
    const pkg = trimmed.slice(begin.length).trim();
    if (pkg !== "" && !out.includes(pkg)) out.push(pkg);
  }
  return out;
}

/**
 * Locate `spec`'s block in `text`, markers included, or null when it has none.
 *
 * Throws rather than guessing whenever the markers do not describe exactly one
 * block — see {@link locate} for the three refusals and why each one exists.
 */
export function findBlock(text: string, spec: BlockSpec): BlockSpan | null {
  return locate(text, spec);
}

/** The version stamped into `spec`'s block in `text`, or null when there is none. */
export function blockVersion(text: string, spec: BlockSpec): string | null {
  const span = locate(text, spec);
  return span === null ? null : spec.dialect.parseStamp(span.text);
}

/**
 * Splice `block` into `existing`, preserving every byte outside the block.
 *
 * Three cases, in the order they matter: an existing file WITH the block, so only
 * the block's span changes; an existing file WITHOUT one, so the block is appended
 * and the user's content is kept whole — the case that makes this safe to point at
 * a repo that already had a hand-written file; and an empty `block`, which removes
 * it (see {@link removeBlock}).
 *
 * Line endings are preserved — a CRLF file stays CRLF, an LF file stays LF —
 * because these files are in version control and a whole-file line-ending flip
 * buries the one line that actually changed.
 *
 * The trailing-newline RUN is preserved with one deliberate exception: a file
 * that ended with NO newline gets one, because the appended block is now the
 * last line and a generated line running into whatever a later edit appends is
 * not a block anyone can splice. One in, one out; two in, two out; zero in, ONE
 * out. Idempotent either way — a second run finds the block and replaces it in
 * place, so the count never grows.
 */
export function upsertBlock(existing: string | null, spec: BlockSpec, block: string): BlockEdit {
  const before = existing ?? "";
  if (block.trim().length === 0) return removeBlock(before, spec);

  const eol = detectEol(before);
  const rendered = block.replace(/\r?\n/g, eol);
  const span = locate(before, spec);

  if (span !== null) {
    // Sliced, not `String.replace` — a `$&`, `` $` ``, `$'` or `$1` anywhere in the
    // generated body is a substitution pattern to `replace`, and would splice the
    // surrounding file into itself. Nothing generated contains one today; the
    // failure if anything ever did would be silent corruption of a user's file.
    return settle(before, before.slice(0, span.start) + rendered + before.slice(span.end));
  }

  if (before.trim().length === 0) return settle(before, rendered + eol);

  // Append. The user's own content — heading and all — stays exactly where it is;
  // we add below it, never reframe around it.
  const tail = trailingNewlines(before);
  return settle(before, trimEndLines(before) + eol + eol + rendered + (tail === "" ? eol : tail));
}

/**
 * Remove `spec`'s block from `existing`, along with its stamp and the blank line
 * that separated it from the surrounding content.
 *
 * Leaving the separator behind would make every install/remove cycle grow the file
 * by a blank line, so the junction between what was above and what was below is
 * collapsed back to a single blank line — or to nothing, when one side is empty.
 */
export function removeBlock(existing: string | null, spec: BlockSpec): BlockEdit {
  const before = existing ?? "";
  const span = locate(before, spec);
  if (span === null) return { text: before, changed: false };

  const eol = detectEol(before);
  const tail = trailingNewlines(before);
  const head = trimEndLines(before.slice(0, span.start));
  const rest = trimStartLines(before.slice(span.end));

  let out = head === "" || rest === "" ? head + rest : head + eol + eol + rest;
  if (out !== "" && tail !== "" && !/\r?\n$/.test(out)) out += tail;
  return settle(before, out);
}

/**
 * Find the one block `spec` describes, refusing every shape that is not exactly
 * zero or one of it.
 *
 * **Balance is occurrence COUNT, not `indexOf`.** Locating the span with `indexOf`
 * on each marker makes a file with TWO begins and TWO ends parse as "balanced":
 * the span runs from the first begin to the first end, and the second copy is
 * silently stranded inside the file forever. A git merge conflict inside a marked
 * block produces exactly that shape, and these files live in version control — so
 * counting is not pedantry, it is the likeliest real failure.
 *
 * Half a block means someone edited by hand and stopped partway; rewriting it
 * automatically would risk destroying whatever is now between the markers.
 */
function locate(text: string, spec: BlockSpec): BlockSpan | null {
  const { dialect, pkg } = spec;
  const where = spec.file === undefined ? "" : ` in ${spec.file}`;
  // Markers are matched as WHOLE LINES, never as substrings: `# xanosdk:begin
  // @xano-sdk/x` is a prefix of `# xanosdk:begin @xano-sdk/xanoscript`, so a plain
  // `indexOf` would have one package claim another package's block.
  const begins = lineOccurrences(text, dialect.begin(pkg));
  const ends = lineOccurrences(text, dialect.end(pkg));

  if (begins.length === 0 && ends.length === 0) return null;

  if (begins.length > 1 || ends.length > 1) {
    throw new Error(
      `unbalanced xanosdk managed block for ${pkg}${where}: found ${begins.length} BEGIN and ` +
        `${ends.length} END markers where at most one of each is valid — usually the residue of ` +
        "a merge. Keep the copy you want and delete the rest by hand; rewriting it automatically " +
        "would strand whichever copy we did not pick.",
    );
  }

  if (begins.length === 0 || ends.length === 0 || ends[0]! < begins[0]!) {
    throw new Error(
      `unbalanced xanosdk managed block for ${pkg}${where}: found ${begins.length === 0 ? "no" : "a"} BEGIN and ` +
        `${ends.length === 0 ? "no" : "an"} END marker. Repair or remove the block by hand — ` +
        "rewriting it automatically would risk destroying whatever is between them.",
    );
  }

  const start = begins[0]!;
  const end = ends[0]! + dialect.end(pkg).length;
  const block = text.slice(start, end);

  // A conflicted block is a block two people disagree about. Overwriting it would
  // resolve that disagreement by discarding one side without telling anyone.
  // Only `<<<<<<<` and `>>>>>>>` are triggers: a bare `=======` line is also a
  // Markdown setext heading underline, and these blocks carry Markdown.
  if (CONFLICT_MARKERS.some((marker) => hasLineStarting(block, marker))) {
    throw new Error(
      `xanosdk managed block for ${pkg}${where} contains git conflict markers. Resolve the ` +
        "conflict by hand, then re-run — rewriting a conflicted block would silently discard " +
        "one side of it.",
    );
  }

  return { start, end, text: block };
}

/** Start indices where `marker` occupies a whole line (trailing spaces tolerated). */
function lineOccurrences(text: string, marker: string): number[] {
  const hits: number[] = [];
  for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + marker.length)) {
    if (i !== 0 && text[i - 1] !== "\n") continue;
    let j = i + marker.length;
    while (text[j] === " " || text[j] === "\t") j++;
    if (text[j] === "\r") j++;
    if (j === text.length || text[j] === "\n") hits.push(i);
  }
  return hits;
}

function hasLineStarting(text: string, marker: string): boolean {
  return text.startsWith(marker) || text.includes(`\n${marker}`);
}

/**
 * The file's line ending. A file with any CRLF is treated as a CRLF file: mixing a
 * fresh LF block into one is how a diff turns into a whole-file rewrite on the next
 * editor save.
 */
function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The run of newlines the file ends with, so appending can put it back unchanged. */
function trailingNewlines(text: string): string {
  return /(?:\r?\n)*$/.exec(text)?.[0] ?? "";
}

/** Drop trailing blank/whitespace-only lines, keeping the last line of content. */
function trimEndLines(text: string): string {
  return text.replace(/[ \t]*(?:\r?\n[ \t]*)*$/, "");
}

/** Drop leading blank/whitespace-only lines. */
function trimStartLines(text: string): string {
  return text.replace(/^[ \t]*(?:\r?\n[ \t]*)*/, "");
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/** Report byte-identity, so an unchanged file is never rewritten. */
function settle(before: string, after: string): BlockEdit {
  return { text: after, changed: after !== before };
}
