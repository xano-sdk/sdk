/**
 * The toolchain modules' half of `routes.gen.ts`: checking the section a
 * module's `routesManifest` hook returns, composing every section into the
 * rendered core in its own marked block, and reading those blocks back out of
 * an existing file so a module that fails a run keeps its previous one (KTD7).
 *
 * The core sections are `routes-manifest.ts`'s; this file only ever appends to
 * what it rendered.
 */
import type { RoutesManifestSection } from "../plugin.js";
import { byCodeUnit } from "../util/code-unit.js";
import { blockPackages, composeBlock, findBlock, type BlockDialect, type BlockSpec } from "./managed-blocks.js";
import { MANIFEST_HEADER, RouteManifestError, ROUTES_MANIFEST_BASENAME } from "./routes-manifest.js";

/**
 * One toolchain module's section of the manifest, under the package and
 * version that produced it — what {@link composeRoutesManifest} takes and
 * {@link parseModuleSections} gives back, so a block read off an existing file
 * recomposes to the same bytes.
 */
export interface ModuleSection {
  readonly pkg: string;
  readonly version: string;
  readonly section: RoutesManifestSection;
}

/**
 * A module block in `routes.gen.ts`:
 *
 *     // xanosdk:begin @xano-sdk/zod
 *     // xanosdk:version 1.0.3 - generated; edits inside this block are overwritten
 *
 *     // xanosdk:imports [{"from":"zod","names":["z"]}]
 *     export const ROUTE_SCHEMAS = ...
 *     // xanosdk:end @xano-sdk/zod
 *
 * The managed-block grammar (`managed-blocks.ts`) in `//` comments, so the
 * same balance, conflict and forged-marker refusals apply here as to
 * `.gitattributes`.
 *
 * The `imports` line records the module's OWN imports inside its block. The
 * file's import lines are merged across modules, so they cannot say which
 * module needed what; this line can. It is what lets a block be carried
 * forward from the existing file when its module fails this run (KTD7) and
 * still compile: the parsed block brings its imports back with it.
 */
const MODULE_DIALECT: BlockDialect = {
  begin: (pkg) => `// xanosdk:begin ${pkg}`,
  end: (pkg) => `// xanosdk:end ${pkg}`,
  stamp: (version) => `// xanosdk:version ${version} - generated; edits inside this block are overwritten`,
  parseStamp: (block) => /^\/\/ xanosdk:version (\S+)/m.exec(block)?.[1] ?? null,
};

const IMPORTS_LINE = "// xanosdk:imports ";

const moduleSpec = (pkg: string): BlockSpec => ({ dialect: MODULE_DIALECT, pkg, file: ROUTES_MANIFEST_BASENAME });

/** A bare package specifier: an optional scope, a name, an optional subpath. Nothing else. */
const BARE_SPECIFIER = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*(?:\/[\w.~@-]+)*$/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** A trimmed line that opens a static `import`. Its first line is enough: `import {` alone is one. */
const STATIC_IMPORT = /^import(?:\s+type)?(?:\s*["'{*]|\s+[A-Za-z_$][\w$]*\s*(?:,|from\b))/;
/**
 * An `export … from` re-export, matched over the whole source: unlike an
 * import, its first line (`export {`) says nothing until the `from` that a
 * formatter puts lines below it.
 */
const RE_EXPORT = /^[ \t]*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s*from\s*["']/m;
/** A dynamic `import()` or `require()` of the SDK. */
const SDK_LOAD = /\b(?:import|require)\s*\(\s*["'`]@xano\/sdk(?:\/|["'`])/;

/**
 * Check a module's section and return its imports normalized: one entry per
 * package, packages and names sorted, names deduped. Throws a
 * {@link RouteManifestError} naming the module for anything the composer
 * cannot write safely.
 *
 * Called by the firing helper (so a bad section is that module's failure) and
 * again by the composer (so no caller can write one by skipping the helper).
 */
export function checkModuleSection(
  pkg: string,
  section: unknown,
): ReadonlyArray<{ from: string; names: string[] }> {
  const refuse = (why: string): never => {
    throw new RouteManifestError(`${pkg}: its routes.gen.ts section ${why}`);
  };
  if (section === null || typeof section !== "object") return refuse("is not an object with a `source` string.");
  if (typeof (section as { then?: unknown }).then === "function") {
    return refuse("is a Promise. `routesManifest` must be synchronous: every writer of the file has to produce the same bytes, and the decode paths write it synchronously.");
  }
  const { source, imports } = section as { source?: unknown; imports?: unknown };
  if (typeof source !== "string") return refuse("has no `source` string.");
  // The composer refuses these too (`composeBlock`), but there the refusal is
  // the whole file's: it surfaces from `composeRoutesManifest` over every module
  // at once, so one module's doc comment would cost the frontend its ROUTES.
  // Refused here, it is this module's `failed` result, and its previous block
  // is carried forward like any other failure (KTD7).
  //
  // A marker prefix anywhere unbalances the count blocks are located by. An
  // imports-shaped FIRST line is read back by `parseModuleSections` as the
  // block's own imports line, so the carried block would not be this one. Only
  // the first: a later line is never read as one.
  const lines = source.split(/\r?\n/);
  const trimmed = lines.map((line) => line.trim());
  const markers = [MODULE_DIALECT.begin("").trim(), MODULE_DIALECT.end("").trim()];
  const forged = trimmed.find((line) => markers.some((marker) => line.startsWith(marker)));
  if (forged !== undefined) {
    return refuse(`has a line that spells a block marker (${forged}); the file's blocks are found by counting them.`);
  }
  const first = lines.find((line) => line.trim() !== "");
  if (first?.startsWith(IMPORTS_LINE)) {
    return refuse(`starts with a line that spells the block's imports line (${first.trim()}); declare imports in \`imports\`.`);
  }
  // The `imports` checks below are the only place a specifier is vetted, so an
  // import written into `source` would carry `@xano/sdk` (or a relative path)
  // straight past them. A static import or re-export line is refused whatever
  // it names; a dynamic one only when it names the SDK, since `import("pkg")`
  // is also how a type reaches into a package it does not load.
  const written =
    trimmed.find((line) => STATIC_IMPORT.test(line) || SDK_LOAD.test(line)) ??
    RE_EXPORT.exec(source)?.[0].trim().split(/\r?\n/)[0];
  if (written !== undefined) {
    return refuse(`writes an import in its source (${written}); declare imports in \`imports\`.`);
  }
  if (imports !== undefined && !Array.isArray(imports)) return refuse("has `imports` that is not an array.");
  const merged = new Map<string, Set<string>>();
  for (const entry of (imports ?? []) as unknown[]) {
    const { from, names } = (entry ?? {}) as { from?: unknown; names?: unknown };
    if (typeof from !== "string") return refuse("declares an import with no `from` string.");
    if (from === "@xano/sdk" || from.startsWith("@xano/sdk/")) {
      return refuse(
        `imports from ${JSON.stringify(from)}. The manifest exists so a frontend can skip the SDK runtime; a module section may not import it.`,
      );
    }
    if (!BARE_SPECIFIER.test(from) || from.split("/").some((part) => part === "." || part === "..")) {
      return refuse(
        `imports from ${JSON.stringify(from)}, which is not a bare package specifier. A relative or absolute path resolves against wherever the file is written, and a protocol is not a package the project depends on.`,
      );
    }
    if (!Array.isArray(names) || names.length === 0) return refuse(`imports nothing by name from ${JSON.stringify(from)}.`);
    for (const name of names as unknown[]) {
      if (typeof name !== "string" || !IDENTIFIER.test(name)) {
        return refuse(`imports ${JSON.stringify(name)} from ${JSON.stringify(from)}, which is not a plain identifier.`);
      }
      merged.set(from, (merged.get(from) ?? new Set()).add(name));
    }
  }
  return [...merged]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([from, names]) => ({ from, names: [...names].sort(byCodeUnit) }));
}

/**
 * The manifest with every module's section composed in (KTD4).
 *
 * `core` is a `renderRouteManifest` result. The merged imports of every
 * section go directly under the generated-file header, one line per package,
 * sorted and deduped; then the core sections, unchanged; then each section in
 * its marked block, ordered by package name whatever order `modules` is in. A
 * section with a blank `source` writes no block, and its imports are dropped
 * with it. With no block to write, the result IS `core`, byte for byte.
 *
 * Pure, like everything it composes: the same inputs give the same bytes.
 */
export function composeRoutesManifest(core: string, modules: readonly ModuleSection[]): string {
  if (!core.startsWith(MANIFEST_HEADER)) {
    throw new RouteManifestError("composeRoutesManifest: `core` is not a rendered route manifest.");
  }
  const imports = new Map<string, Set<string>>();
  const blocks: string[] = [];
  let previous: string | undefined;
  for (const { pkg, version, section } of [...modules].sort((a, b) => byCodeUnit(a.pkg, b.pkg))) {
    if (pkg === previous) {
      throw new RouteManifestError(`${pkg}: two routes.gen.ts sections for one module; a module contributes one.`);
    }
    previous = pkg;
    const own = checkModuleSection(pkg, section);
    if (section.source.trim() === "") continue;
    for (const { from, names } of own) {
      for (const name of names) imports.set(from, (imports.get(from) ?? new Set()).add(name));
    }
    const lines = own.length > 0 ? [`${IMPORTS_LINE}${JSON.stringify(own)}`, section.source] : [section.source];
    try {
      blocks.push(composeBlock(moduleSpec(pkg), lines, version));
    } catch (error) {
      throw new RouteManifestError(error instanceof Error ? error.message : String(error));
    }
  }
  if (blocks.length === 0) return core;
  const importLines = [...imports]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([from, names]) => `import { ${[...names].sort(byCodeUnit).join(", ")} } from ${JSON.stringify(from)};\n`);
  return `${MANIFEST_HEADER}${importLines.join("")}${core.slice(MANIFEST_HEADER.length)}${blocks.map((b) => `\n${b}\n`).join("")}`;
}

/**
 * Every module block in an existing manifest, as the sections that compose
 * back to it: `composeRoutesManifest(core, parseModuleSections(text))` writes
 * those blocks byte for byte, onto whatever `core` is current. That is how a
 * module that fails this run keeps its previous block (KTD7).
 *
 * Sorted by package. Throws a {@link RouteManifestError} when a block is not
 * one the SDK wrote: unbalanced markers (a merge residue), conflict markers,
 * or a block missing its version stamp or carrying an unreadable imports line.
 * Guessing at a hand-edited block would carry a broken one forward.
 *
 * `only` limits the read to those packages' blocks, so a broken block that
 * belongs to some other module (one regenerated fresh this run anyway) is
 * never parsed and cannot fail the read.
 */
export function parseModuleSections(text: string, only?: ReadonlySet<string>): ModuleSection[] {
  return blockPackages(text, MODULE_DIALECT)
    .filter((pkg) => only === undefined || only.has(pkg))
    .sort(byCodeUnit)
    .map((pkg) => {
      const fail = (why: string): never => {
        throw new RouteManifestError(
          `${pkg}: its block in ${ROUTES_MANIFEST_BASENAME} ${why} Repair or delete the block by hand, then regenerate the file.`,
        );
      };
      let span: ReturnType<typeof findBlock>;
      try {
        span = findBlock(text, moduleSpec(pkg));
      } catch (error) {
        return fail(`cannot be read: ${error instanceof Error ? error.message : String(error)}.`);
      }
      // [begin, stamp, "", ...body, end] — the shape composeBlock writes.
      const lines = span!.text.split(/\r?\n/);
      const version = MODULE_DIALECT.parseStamp(lines[1] ?? "");
      if (version === null || lines[2] !== "") return fail("has no version stamp under its begin marker.");
      let body = lines.slice(3, -1);
      let imports: unknown;
      if (body[0]?.startsWith(IMPORTS_LINE)) {
        try {
          imports = JSON.parse(body[0].slice(IMPORTS_LINE.length));
        } catch {
          return fail("has an imports line that is not valid JSON.");
        }
        body = body.slice(1);
      }
      const section = { ...(imports === undefined ? {} : { imports }), source: body.join("\n") };
      checkModuleSection(pkg, section);
      return { pkg, version, section: section as RoutesManifestSection };
    });
}
