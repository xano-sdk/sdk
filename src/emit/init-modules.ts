/**
 * `xanosdk init --marketplace <a,b>` — install marketplace add-ons into a fresh
 * scaffold and wire them into `xano/index.ts`.
 *
 * The point of the flag is reproducibility. Onboarding prints the command it
 * ran, and that command is only honest if running it yourself produces the same
 * project — which, for a project with add-ons, means the packages are installed
 * AND registered. Installing without registering leaves a dependency nobody
 * imports, which is a different project wearing the same name.
 *
 * ── How a module says how to register itself ────────────────────────────────
 *
 * From its own `package.json`, which is the only description of a package that
 * ships with the package:
 *
 *     "xanosdk": { "register": "registerAuth", "returns": "workspace" }
 *
 * `register` names the exported function; `returns` says whether calling it
 * hands back the workspace or a handle worth keeping. A module that cannot be
 * registered bare adds what it needs, as another package's export:
 *
 *     "xanosdk": {
 *       "register": "registerChatbot",
 *       "returns": "handle",
 *       "options": { "authTable": { "package": "@xano-sdk/auth", "export": "userTable" } }
 *     }
 *
 * An option whose value is a plain literal rather than another package's export
 * says so with `value`:
 *
 *     "xanosdk": {
 *       "register": "registerAuth",
 *       "returns": "workspace",
 *       "options": { "canonical": { "value": "authn" } }
 *     }
 *
 * `canonical` is the case that made this necessary. A module that registers an
 * api group and leaves its canonical unpinned scaffolds a project whose own
 * `getPath()` throws — the generated code contradicts the generated AGENTS.md,
 * which tells the reader to pin it. Declaring the pin puts it in the file.
 *
 * That is the whole contract, and it is deliberately declarative — the alternative, which
 * onboarding had to live with before this existed, is parsing a prose snippet
 * out of the catalogue and guessing at its shape. That guess was 425 lines and
 * it could be wrong.
 *
 * `options` is also how a module says its register call needs NOTHING: declare
 * `"options": {}` and the call is written bare, with no further questions asked
 * and — the one case that holds the promise below in full — nothing loaded.
 * Omit the key and the module has said nothing either way, so it is imported
 * after all and its arity read: a register function that takes an options
 * argument no one declared is left OUT of the scaffold rather than called
 * without it, because the call would not compile and this CLI has no value to
 * put there.
 *
 * A module that has not adopted the field yet still works: its installed entry
 * is imported and read for a single `register*` export. Real exports, not prose
 * — this cannot mistake a comment for code — and adopting the field replaces
 * the search with a statement.
 *
 * ── Why the generated file can be this simple ───────────────────────────────
 *
 * Because registration MUTATES the workspace. Measured, not assumed:
 * `registerAuth` ends in `return xano` — the same object it was handed — and
 * `registerVector` returns `{ ...vec, xano }`, having already registered onto
 * that same instance. So `registerX(app);` as a statement is correct for both,
 * the order of the calls does not matter, and the default export is the
 * workspace either way. `returns` only decides whether the result is worth
 * binding to a name; it is never load-bearing for correctness.
 *
 * Node-only; reached from `init-command.ts`, which the CLI imports lazily.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { UsageError } from "./errors.js";
import { shellWord } from "./command-line.js";
import {
  type LoadedEntry,
  homepageOf,
  installedPackageDir,
  loadEntryExports,
  moduleKind,
  packageNameOf,
  readInstalledManifest,
  localPathOf,
} from "./module-manifest.js";
import { type NpmVersionResult, condenseNpmError, npmViewVersion } from "./npm.js";
import { addArgs, installSite, removeCommandFor } from "./package-manager.js";
import { type AddOutcome, addDependency, removeDependency } from "./project-dependency.js";
import { isLocalSpecifier } from "./marketplace-resolve.js";
import { spinner, step, success, warn } from "./ui.js";

/**
 * An option a module needs, named as another package's export.
 *
 * `@xano-sdk/chatbot` is the case this exists for: `registerChatbot` refuses to
 * build without an `authTable`, and the value it wants is `userTable` from
 * `@xano-sdk/auth` — a reference to another module, not a literal. Registering it
 * without one produces a project that scaffolds cleanly and then fails on the
 * first export, which is the worst place to find out.
 */
export interface OptionImport {
  /** The package the value comes from. */
  readonly package: string;
  /** The named export to pass. */
  readonly export: string;
}

/**
 * An option whose value is a literal the module names itself — a canonical slug,
 * a flag, a count. Written into the call as JSON, so nothing is imported for it.
 */
export interface OptionLiteral {
  readonly value: string | number | boolean;
}

/** One option's value: another package's export, or a literal. */
export type OptionRef = OptionImport | OptionLiteral;

/** Narrow an {@link OptionRef} to the import form. */
export function isOptionImport(ref: OptionRef): ref is OptionImport {
  return "package" in ref;
}

/**
 * Whether a register call can be written, from the options side.
 *
 * A union rather than a boolean because the three answers are not two: a module
 * that says it needs nothing, a module whose arity says it needs something no
 * one declared, and a module we could not read well enough to know. The third
 * is the one a boolean gets wrong — collapsing it into either answer either
 * writes a call that may not compile or refuses one with a reason that is not
 * true.
 *
 * Arity is a signal, not a proof, because the published artifact is not the
 * source: `options?: Opts` and a default parameter downleveled to ES5 both
 * report 2, and `(xano, ...rest)` reports 1. The first two cost a module its
 * registration, which is safe — the scaffold compiles and the file says why.
 * The last is what the `xanosdk` field settles; nothing measured from outside
 * the module can.
 */
export type OptionsVerdict =
  /** Declared its options, or its arity says the call takes none. Writable. */
  | { readonly kind: "accounted" }
  /** Its arity says the call takes an options argument nobody declared. */
  | { readonly kind: "undeclared" }
  /** Its entry could not be read, so neither of the above could be settled. */
  | { readonly kind: "unreadable"; readonly why: string };

/** How one installed module gets onto the workspace. */
export interface ModuleRegistration {
  readonly pkg: string;
  /** The exported function to call, e.g. `registerAuth`. */
  readonly register: string;
  /** A name to bind the result to, when the module returns a handle. */
  readonly binding: string | null;
  /** Options the call needs, by option name. Empty for most modules. */
  readonly options: Readonly<Record<string, OptionRef>>;
  /**
   * Whether every argument the call takes has been accounted for.
   *
   * The rule — write the call only once every argument is accounted for —
   * decided where the module is read, because this is where both halves are in
   * hand: what the module declared, and what its
   * register function's arity says it takes. `partitionRegistrations` only acts
   * on it.
   */
  readonly optionsVerdict: OptionsVerdict;
  /** Where the answer came from — reported, so adoption is visible. */
  readonly source: "manifest" | "exports";
  /**
   * The module's own `homepage`, when its package.json names one.
   *
   * Where a refusal sends the reader. A module this CLI cannot wire is one only
   * its author can explain, and the installed manifest is the one place that
   * says where without this file knowing the package.
   */
  readonly docs?: string;
  /**
   * For a module installed from a path rather than the catalogue: its README
   * (or package directory), relative to the project. `marketplace details`
   * knows only catalogue modules, so this is where its wiring is pointed at.
   */
  readonly readme?: string;
}

/** A module that installed but could not be wired, and why. */
export interface UnwiredModule {
  readonly pkg: string;
  readonly reason: string;
  /** {@link ModuleRegistration.readme}: where a module from a path documents its wiring. */
  readonly readme?: string;
  /**
   * The register function, when we got far enough to learn its name.
   *
   * Absent for a module we could not read at all — one that exports no
   * `register*`, or several. Present for the case this matters in: a module we
   * understood completely and declined to write anyway, where the commented
   * snippet can be the real call rather than a shape to fill in.
   */
  readonly register?: string;
  /**
   * The options the call needs, when every one is known and only a package the
   * project lacks stands in the way — so the commented snippet is the real call,
   * ready to uncomment once that package is added.
   */
  readonly options?: Readonly<Record<string, OptionRef>>;
}

/**
 * Split `--marketplace` values into package names.
 *
 * Comma-separated and repeatable, so the flag reads as one
 * line in a printed command: `--marketplace @xano-sdk/auth,@xano-sdk/vector`.
 *
 * A name starting with `-` is refused here rather than handed to npm, which
 * would read it as a flag of its own — the same trap `marketplace install`
 * guards against, and worth catching before a scaffold has been written.
 */
export function parseMarketplaceFlag(values: readonly string[]): string[] {
  const packages: string[] = [];
  for (const value of values) {
    for (const raw of value.split(",")) {
      const pkg = raw.trim();
      if (pkg === "") continue;
      if (pkg.startsWith("-")) {
        throw new UsageError(
          `\`--marketplace\`: "${pkg}" starts with a dash, so npm would read it as a flag, not a package.`,
          { helpFor: { command: "init" } },
        );
      }
      // Deduplicated: npm would install it twice happily, and the generated
      // file would call the same register function twice — which the modules
      // themselves throw on.
      if (!packages.includes(pkg)) packages.push(pkg);
    }
  }
  return packages;
}

/**
 * The `options` clause, kept only where it is fully specified.
 *
 * A half-written entry is dropped rather than guessed at: passing an option
 * whose value we invented is worse than passing none, because the module's own
 * error about a MISSING option is precise and ours would not be.
 */
function readOptionRefs(raw: unknown): Record<string, OptionRef> {
  if (typeof raw !== "object" || raw === null) return {};
  const refs: Record<string, OptionRef> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const pkg = entry["package"];
    const exported = entry["export"];
    if (typeof pkg === "string" && pkg !== "" && typeof exported === "string" && exported !== "") {
      refs[name] = { package: pkg, export: exported };
      continue;
    }
    // A literal. Only the JSON scalars — an object or array would have to be
    // re-serialized into the generated file, and no module has asked for one.
    const literal = entry["value"];
    if (typeof literal === "string" || typeof literal === "number" || typeof literal === "boolean") {
      refs[name] = { value: literal };
    }
  }
  return refs;
}

/**
 * Options for modules that have not adopted the `xanosdk` field yet.
 *
 * Each entry exists because the alternative is a scaffold that does not hold up:
 *
 * - `registerAuth(app)` leaves the auth api group's canonical unpinned, so
 *   `loginQuery.getPath()` throws in the project the CLI just wrote. `"authn"`
 *   is the value this repo's scaffold prose, agent brief and grounding docs name.
 * - `registerChatbot(app)` throws at load: its authenticated endpoints need an
 *   `authTable`. Its arity is 1 (options are optional in the signature), so
 *   nothing measured from outside says so. With `@xano-sdk/auth` in the project
 *   its `userTable` is the value; without it the module is left unwired, naming
 *   the package it needs (see `partitionRegistrations`).
 *
 * A module's OWN declaration always wins, so an entry here is dead the moment
 * the package ships one — which is the intended end state, not a fallback to
 * grow.
 */
const UNDECLARED_OPTIONS: Readonly<Record<string, Readonly<Record<string, OptionRef>>>> = {
  "@xano-sdk/auth": { canonical: { value: "authn" } },
  "@xano-sdk/chatbot": { authTable: { package: "@xano-sdk/auth", export: "userTable" } },
};

/**
 * Break prose at a width, so a sentence composed here wraps like the file it
 * lands in. Written rather than baked into the strings: the wording varies with
 * what happened, and hand-placed line breaks in a string that is sometimes
 * appended to are wrong the first time the appended half exists.
 */
function wrapAt(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** `registerVector` → `vector`, for binding a returned handle. */
function bindingNameFor(register: string): string {
  const bare = register.replace(/^register/, "");
  return bare === "" ? "handle" : bare[0]!.toLowerCase() + bare.slice(1);
}

/** Whether `register` declares a second parameter the caller has to pass. */
function takesSecondArgument(loaded: Record<string, unknown>, register: string): boolean {
  const fn = loaded[register];
  return typeof fn === "function" && fn.length >= 2;
}

/**
 * What an attempted load says about `register`'s options argument.
 *
 * A load that did not happen settles NOTHING, and the direction that matters is
 * which way an unsettled answer falls. Treating it as "accounted" writes the
 * bare call — a call that may not compile, reached through the field meant to
 * prevent it — so it falls the other way: unreadable, refused, with the load
 * failure as the reason rather than a claim about an argument we never saw.
 */
function verdictFromArity(entry: LoadedEntry, register: string): OptionsVerdict {
  if (entry.kind !== "loaded") return { kind: "unreadable", why: entry.why };
  return takesSecondArgument(entry.exports, register) ? { kind: "undeclared" } : { kind: "accounted" };
}

/**
 * How `pkg` registers itself: from its manifest if it says, else from what it
 * exports.
 *
 * The import is the fallback and not the first choice on purpose. It is
 * accurate — these are the real exports, so no comment or string can be
 * mistaken for one — but it runs the module's top-level code, and a package
 * that declares the field never has to be loaded at all.
 */
export async function readRegistration(
  dir: string,
  pkg: string,
): Promise<ModuleRegistration | { unwired: string } | { toolchain: true }> {
  const manifest = readInstalledManifest(dir, pkg);
  if (manifest === null) return { unwired: "it is not in node_modules after the install" };

  // Before anything is searched for or loaded. A toolchain module extends the
  // CLI and registers nothing, so hunting it for a `register*` export would
  // find none — correctly — and report it as unwired, which is a FALSE warning
  // rather than a degraded one. It would also import the module's whole entry
  // graph here, which the toolchain loader is careful to avoid.
  if (moduleKind(pkg, manifest) === "toolchain") return { toolchain: true };

  const field = manifest["xanosdk"];
  if (typeof field === "object" && field !== null) {
    const declaration = field as Record<string, unknown>;
    const register = declaration["register"];
    if (typeof register === "string" && register !== "") {
      // A module that declared its options has stated what the call needs, and
      // is taken at its word — the one case nothing is loaded for. Silence is
      // not a declaration, so the arity is measured after all.
      const declared = declaration["options"];
      return {
        pkg,
        register,
        binding: declaration["returns"] === "handle" ? bindingNameFor(register) : null,
        // The module's own declaration wins option by option, so a package that
        // ships one is never second-guessed here.
        options: { ...UNDECLARED_OPTIONS[pkg], ...readOptionRefs(declared) },
        optionsVerdict:
          declared !== undefined
            ? { kind: "accounted" }
            : verdictFromArity(await loadEntryExports(dir, pkg, manifest), register),
        source: "manifest",
        docs: homepageOf(manifest),
      };
    }
  }

  const entry = await loadEntryExports(dir, pkg, manifest);
  if (entry.kind !== "loaded") return { unwired: entry.why };
  const loaded = entry.exports;

  const names = Object.keys(loaded).filter(
    (name) => /^register[A-Z]/.test(name) && typeof loaded[name] === "function",
  );
  if (names.length === 0) {
    return {
      unwired: `it exports no register* function, and its package.json has no "xanosdk" field`,
    };
  }
  if (names.length > 1) {
    // Ambiguity is exactly what the manifest field settles, so say so rather
    // than picking one and being right by luck.
    return {
      unwired: `it exports ${names.length} register* functions (${names.join(", ")}) — its package.json needs a "xanosdk" field naming the one to call`,
    };
  }
  // Without the field there is nothing that says the result is a handle, and
  // binding a value nobody asked for is worse than not binding it: the call
  // registers either way. Options are whatever `UNDECLARED_OPTIONS` knows the
  // package needs, which for everything but `@xano-sdk/auth` is nothing — and a
  // value this file supplies is not the module accounting for its own argument,
  // so it never authorises the call.
  const register = names[0]!;
  return {
    pkg,
    register,
    optionsVerdict: takesSecondArgument(loaded, register)
      ? { kind: "undeclared" }
      : { kind: "accounted" },
    binding: null,
    options: { ...UNDECLARED_OPTIONS[pkg] },
    source: "exports",
    docs: homepageOf(manifest),
  };
}

/**
 * One import line per package, so a module that supplies another's option
 * (auth's `userTable` for chatbot) is imported once rather than twice.
 */
export function renderImports(
  modules: readonly Pick<ModuleRegistration, "pkg" | "register" | "options">[],
): string[] {
  const byPackage = new Map<string, Set<string>>();
  const add = (pkg: string, name: string) => {
    const names = byPackage.get(pkg) ?? new Set<string>();
    names.add(name);
    byPackage.set(pkg, names);
  };
  for (const m of modules) {
    add(m.pkg, m.register);
    for (const ref of Object.values(m.options)) {
      if (isOptionImport(ref)) add(ref.package, ref.export);
    }
  }
  return [...byPackage].map(([pkg, names]) => `import { ${[...names].sort().join(", ")} } from "${pkg}";`);
}

/** `registerX(app, { opt: value });` — the options object omitted when empty. */
export function renderRegisterCall(
  register: string,
  options: Readonly<Record<string, OptionRef>>,
  app = "app",
): string {
  const entries = Object.entries(options);
  const opts =
    entries.length === 0
      ? ""
      : `, { ${entries
          .map(([name, ref]) => `${name}: ${isOptionImport(ref) ? ref.export : JSON.stringify(ref.value)}`)
          .join(", ")} }`;
  return `${register}(${app}${opts});`;
}

/**
 * `xano/index.ts` for a project that has add-ons.
 *
 * A different file from the empty starter rather than a patched one. The
 * starter is a walkthrough — half of it is a commented example of the first
 * table and endpoint — and threading imports into prose is how you get a file
 * that reads like it was assembled by a machine. This one says what it is.
 */
export function renderXanoIndexWithModules(
  appName: string,
  modules: readonly ModuleRegistration[],
  unwired: readonly UnwiredModule[] = [],
  /**
   * Env names the registered add-ons read, declared in a `workspaceConfig` so
   * the project's strict check has no undeclared read to fail on. Values stay
   * empty: they are set in `xano/.env`, never in source.
   */
  env: readonly string[] = [],
): string {
  const imports = renderImports(modules).join("\n");

  const calls = modules
    .map((m) => {
      const call = renderRegisterCall(m.register, m.options);
      return m.binding === null ? call : `const ${m.binding} = ${call}`;
    })
    .join("\n");
  /*
   * The modules that installed but were not written, named HERE and not only in
   * the terminal. This is the file someone opens to ask where an add-on went,
   * and by then the scrollback from the one command that scaffolded the project
   * is gone.
   *
   * Commented rather than emitted with a TODO options object, because a
   * half-filled object does not compile either — and a fresh scaffold that
   * passes `npm run typecheck` is the whole point of leaving the module out.
   */
  const note: string[] = [];
  if (unwired.length > 0) {
    note.push(
      "Installed but NOT registered — each needs something this scaffold could",
      "not supply. Uncomment, fill in the options, and the module is live.",
    );
    for (const m of unwired) {
      note.push("", m.pkg, ...wrapAt(`${m.reason}.`, 72).map((line) => `  ${line}`), "");
      // Pointed at `marketplace details` rather than a README: it prints the
      // publisher's registration snippet (`--prompt` prints only the agent prompt).
      const details = `npx xanosdk marketplace details ${m.pkg}`;
      const lookup = m.readme === undefined ? `run \`${details}\`` : `see ${m.readme}`;
      if (m.register === undefined) {
        note.push(`  // ${lookup} for the export to call`);
      } else if (m.options !== undefined) {
        note.push(...renderImports([{ pkg: m.pkg, register: m.register, options: m.options }]).map((l) => `  ${l}`));
        note.push(`  ${renderRegisterCall(m.register, m.options)}`);
      } else {
        note.push(
          `  import { ${m.register} } from "${m.pkg}";`,
          `  ${m.register}(app, { ... }); // options: ${lookup}`,
        );
      }
    }
  }
  // The note IS a block comment, so a `*/` anywhere inside it — a reason
  // carrying a URL from a third party's manifest, say — would end it early and
  // leave a generated file that does not parse.
  const unwiredNote =
    note.length === 0
      ? ""
      : `/*\n${note.map((line) => (line === "" ? " *" : ` * ${line}`)).join("\n").replaceAll("*/", "* /")}\n */`;

  const envBlock =
    env.length === 0
      ? ""
      : `// Env vars the add-ons read. Set their values in xano/.env (see xano/.env.example).\n` +
        `app.registerWorkspace(workspaceConfig({ env: { ${env.map((name) => `${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}: ""`).join(", ")} } }));`;

  // Composed rather than interpolated: any block can be empty, and an empty
  // one interpolated on its own line is a stray blank line.
  const body = [calls, envBlock, unwiredNote].filter(Boolean).map((block) => `${block}\n\n`).join("");
  const importLines = imports === "" ? "" : `${imports}\n`;

  // "registered for you" over a file that registered nothing is the CLI
  // contradicting, in its first paragraph, what the rest of the file says.
  const opening = wrapAt(
    "A workspace is assembled by registering typed objects onto a workspace() instance and " +
      "default-exporting it. " +
      (modules.length === 0
        ? "The add-ons you picked were installed by `xanosdk init --marketplace`. None of them could be registered for you — the note below names what each one still needs."
        : "The add-ons below were installed by `xanosdk init --marketplace` and registered for you." +
          (unwired.length === 0 ? "" : " The ones that could not be registered are named under them.")),
    74,
  ).join("\n * ");

  const handles = modules.filter((m) => m.binding !== null);
  const handleNote =
    handles.length === 0
      ? ""
      : `\n *\n * ${handles
          .map((m) => `\`${m.binding}\` is ${m.pkg}'s handle — its endpoints and helpers.`)
          .join("\n * ")}`;

  return `import { ${env.length === 0 ? "workspace" : "workspace, workspaceConfig"} } from "@xano/sdk";
${importLines}
/**
 * The ${appName} backend.
 *
 * ${opening}
 *
 * Each register* call mutates the workspace, so the order does not matter and
 * the thing exported is the workspace itself. Add your own tables and endpoints
 * beside them — xano/EXAMPLE.md walks through the first one.${handleNote}
 */
const app = workspace("${appName}");

${body}export default app;
`;
}

/** What `--marketplace` did, for the epilogue. */
export interface ModuleOutcome {
  readonly installed: readonly string[];
  readonly failed: readonly string[];
  /**
   * npm's condensed reason for each failed install, as its `module.install-failed`
   * warning already printed it — so the project's own install, failing for the
   * SAME reason (a range npm has no version for, in the manifest both share),
   * is not a second warning of one failure.
   */
  readonly reported: readonly string[];
  /** Installed only after npm was told to ignore a peer conflict. */
  readonly legacyPeer: readonly string[];
  readonly registered: readonly ModuleRegistration[];
  readonly unwired: readonly UnwiredModule[];
  /**
   * Installed packages that extend the CLI rather than the workspace.
   *
   * Reported apart from `unwired` because there is nothing wrong with them.
   * A toolchain module has no `register*` to find, so the search that produces
   * `unwired` would report it as broken and tell the user to register it in
   * `xano/index.ts` — advice that cannot be followed for a package that adds
   * nothing to the workspace. See `module-manifest.ts` for the discriminator.
   */
  readonly toolchain: readonly string[];
}

/**
 * npm's "there is no such package" signature.
 *
 * Narrow on purpose. The pre-flight below refuses a run on this and on nothing
 * else, so every pattern here has to mean the registry answered and said the
 * name is not one of its own — never that it could not be asked. An offline
 * laptop, a proxy, an expired token: those are failures of the QUESTION, and
 * refusing a real package because of one would be a new way to break a valid
 * command.
 */
export function isMissingPackage(stderr: string): boolean {
  // npm's OWN spellings only. A bare "404 Not Found" was in this list and has
  // been taken out: it is what a captive portal or a misconfigured corporate
  // proxy puts in an HTML error body, and matching it would refuse a real
  // package because of an infrastructure problem — the exact false positive
  // this predicate exists to avoid.
  return /\bE404\b|is not in this registry/i.test(stderr);
}

/**
 * A `--marketplace` specifier that names a path on disk, as npm will read it
 * from inside the new project.
 *
 * npm resolves a relative path against the directory it runs in, and every
 * install `init` runs is inside the target — so `./mymod` typed beside the
 * target would name `<target>/mymod`. The path is rebased from `from` (where
 * `init` was typed) to `to` (the target), keeping a `file:` prefix. Registry
 * names, URLs, git specs, `~` and absolute paths come back unchanged.
 *
 * A path that is not on disk is refused before anything is written.
 */
export function rebaseLocalSpec(spec: string, from: string, to: string): string {
  const path = localPathOf(spec);
  if (path === undefined || isAbsolute(path)) return spec;
  const abs = resolve(from, path);
  if (!existsSync(abs)) {
    throw new UsageError(`\`--marketplace\`: ${spec} is not on disk (looked for ${abs}).`, {
      helpFor: { command: "init" },
    });
  }
  const rel = relative(resolve(to), abs).split(sep).join("/");
  const rebased = rel.startsWith("..") ? rel : `./${rel}`;
  return spec.startsWith("file:") ? `file:${rebased}` : rebased;
}


/**
 * Refuse `--marketplace` names the registry does not have, BEFORE anything is
 * written.
 *
 * `init` already resolves `--framework` and `--theme` up front so that
 * "a usage error must beat an environment one" — a mistyped flag costs nothing
 * and leaves nothing. `--marketplace` was the one flag outside that rule, and
 * the gap is not cosmetic: pass one writes a `package.json` and runs `npm
 * install` into the target, so a typo leaves a directory holding a manifest and
 * a `node_modules` — which `decideOverwrite` then reads as non-empty and
 * refuses the corrected re-run. The name is checkable without writing anything,
 * so it is checked without writing anything.
 *
 * Only a 404 is fatal. Any other failure — no network, no npm, a registry that
 * would not answer — falls through to the install, which reports it with npm's
 * own words. This step can only ever turn a "not found" into a cheaper "not
 * found"; it is not a second opinion on whether npm works.
 *
 * `view` is injected so the suite can exercise every branch without a registry.
 */
export function preflightPackages(
  specifiers: readonly string[],
  targetDir: string,
  view: (pkg: string, cwd: string) => NpmVersionResult = npmViewVersion,
): void {
  // A path, URL or git spec is not a registry name: nothing to ask the registry.
  const packages = specifiers.filter((p) => !isLocalSpecifier(p));
  if (packages.length === 0) return;
  // A `step` line rather than a spinner. `npm view` is `spawnSync`, which
  // blocks the event loop, so a spinner here could only ever draw one frozen
  // frame — an animation that cannot animate says LESS than a plain line.
  step(`Checking ${packages.join(", ")} on the npm registry`);
  // The directory the install will run in, so both ask the same npm. npm reads
  // `.npmrc` upward from its cwd, so asking from wherever the user happened to
  // be standing can consult a different registry than the install does — and a
  // scope mapped to a private registry in the TARGET's `.npmrc` would 404 on
  // the public one and be refused as a typo. The target may not exist yet, so
  // the nearest ancestor that does is the closest honest answer.
  const cwd = nearestExistingDir(targetDir);
  const missing: string[] = [];
  for (const specifier of packages) {
    // The NAME only. `npm view pkg@99.99.99` also answers 404, and refusing
    // that as "no such package" is a message that is simply false — the
    // package exists, the version does not. A version or tag that cannot be
    // resolved falls through to the install, whose error says which.
    const result = view(packageNameOf(specifier), cwd);
    if (!result.ok && isMissingPackage(result.stderr)) missing.push(packageNameOf(specifier));
  }
  if (missing.length === 0) return;
  const names = [...new Set(missing)].join(", ");
  throw new UsageError(
    `\`--marketplace\`: the npm registry has no ${missing.length === 1 ? "package" : "packages"} named ${names}. ` +
      `Check the name with \`xanosdk marketplace search\`, or list what is published with \`xanosdk marketplace list\`. ` +
      `(A package published in the last few minutes can 404 until the registry finishes replicating it — if the name is right, retry.)`,
    { helpFor: { command: "init" } },
  );
}

/**
 * `dir`, or the closest ancestor of it that exists.
 *
 * For handing npm a cwd that describes the project being created before that
 * project has a directory. Walks up rather than giving up: `init a/b/c` in an
 * empty repo has no `a` either, and the repo root's `.npmrc` is still the one
 * the install will end up reading through.
 */
function nearestExistingDir(dir: string): string {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    // `dirname("/")` is `"/"`. Reaching a fixed point means nothing on the path
    // exists, which cannot happen for an absolute path but is cheap to survive.
    if (parent === current) return process.cwd();
    current = parent;
  }
}

/**
 * Split read registrations into the ones that can be WRITTEN and the ones that
 * cannot, with a reason for each of the latter.
 *
 * Separate from `installModules` because this is the part worth testing. The
 * npm side needs a network and a registry; the decision made around it — given
 * what these modules say about themselves and what else is in the project, what
 * goes in the file — is entirely ours, and is where every way a scaffold can be
 * written broken lives.
 *
 * `present` is the set of package names the project has, which is what decides
 * whether an option pointing at another package can be imported. `@xano-sdk/chatbot`
 * wants `userTable` from `@xano-sdk/auth`; picked without auth, the generated file
 * would import from a package that is not there and the project would not
 * compile.
 *
 * It decides nothing about options on its own: `optionsVerdict` is read where
 * the module is, and this acts on it.
 */
/**
 * Where a refusal sends whoever reads it — the reader being, as often as not, a
 * coding agent.
 *
 * `marketplace details --prompt` first because it is the answer this CLI already
 * builds for exactly this question: the publisher's own wiring steps, in the
 * shape an agent can act on. It is what `marketplace install` points at when it
 * cannot wire something, and this path had been pointing at a README instead —
 * a document that may be marketing copy, and that a module naming no `homepage`
 * gives no address for at all.
 */
function wiringPointer(registration: ModuleRegistration): string {
  const details =
    registration.readme === undefined
      ? `run \`npx xanosdk marketplace details ${registration.pkg} --prompt\` for its wiring`
      : `see ${registration.readme} (from the project root) for its wiring`;
  return registration.docs === undefined ? details : `${details}, or see ${registration.docs}`;
}

export function partitionRegistrations(
  registered: readonly ModuleRegistration[],
  present: ReadonlySet<string>,
): { writable: readonly ModuleRegistration[]; unwired: readonly UnwiredModule[] } {
  const writable: ModuleRegistration[] = [];
  const unwired: UnwiredModule[] = [];
  for (const registration of registered) {
    const missingRefs = Object.entries(registration.options).filter(
      (entry): entry is [string, OptionImport] => isOptionImport(entry[1]) && !present.has(entry[1].package),
    );
    const missing = [...new Set(missingRefs.map(([, ref]) => ref.package))];

    let reason: string | null = null;
    // Every option is known, so the commented snippet can be the real call.
    let options: Readonly<Record<string, OptionRef>> | undefined;
    if (missing.length > 0) {
      const names = missingRefs.map(([name]) => `\`${name}\``).join(", ");
      reason =
        `${registration.register}() needs ${names} from ${missing.join(", ")}, which this project does not have — ` +
        `add it with ${missing.map((pkg) => `\`npx xanosdk marketplace install ${pkg}\``).join(", ")} and wire it as ` +
        `that prints, uncommenting the ${registration.register}() call in xano/index.ts before its last step; ` +
        `or pass your own value for ${names}`;
      if (registration.optionsVerdict.kind === "accounted") options = registration.options;
    } else if (registration.optionsVerdict.kind === "undeclared") {
      // Refused rather than guessed at: a value this CLI invents for a module
      // it does not know is a project that deploys cleanly and is wrong.
      reason = `${registration.register}() takes an options argument that ${registration.pkg} does not declare — ${wiringPointer(registration)}`;
    } else if (registration.optionsVerdict.kind === "unreadable") {
      reason = `${registration.pkg} names ${registration.register}() but ${registration.optionsVerdict.why}, so whether the call takes options could not be settled — ${wiringPointer(registration)}`;
    }

    if (reason === null) {
      writable.push(registration);
      continue;
    }
    unwired.push({
      pkg: registration.pkg,
      reason,
      ...(registration.readme === undefined ? {} : { readme: registration.readme }),
      register: registration.register,
      ...(options === undefined ? {} : { options }),
    });
  }
  return { writable, unwired };
}

/**
 * One sentence naming what npm refused, when its output says — the package and
 * range for a version that does not exist (`ETARGET`), the package for one the
 * registry does not have (`E404`). A range the project's own `package.json`
 * declares is said to be the project's, since that is where it is fixed.
 * `undefined` for anything else — a peer conflict (`ERESOLVE`) keeps the
 * peer wording, and npm's own lines follow either way.
 */
export function classifyNpmFailure(output: string, dir: string): string | undefined {
  const target = /No matching version found for (\S+)@(.+?)\.?\s*$/m.exec(output);
  if (/\bETARGET\b/.test(output) && target !== null) {
    const [, pkg, range] = target as unknown as [string, string, string];
    const own = declaredRange(dir, pkg) === range;
    return (
      `npm has no published ${pkg} matching ${range}` +
      (own
        ? ` — the range this project's package.json declares for it. Point it at a published version ` +
          `(\`npm view ${pkg} versions\`) and run \`npm install\` again.`
        : ` — a range this package, or one of its dependencies, asks for.`)
    );
  }
  const missing = /'((?:@[^/'\s]+\/)?[^@'\s]+)(?:@[^'\s]*)?' is not in (?:this|the npm) registry/.exec(output);
  if (/\bE404\b/.test(output)) {
    return missing === null
      ? `npm answered 404: a package this install needs is not in the registry.`
      : `npm answered 404: ${missing[1]} is not in the registry.`;
  }
  return undefined;
}

/** The range `dir/package.json` declares for `pkg`, in any dependency block. */
function declaredRange(dir: string, pkg: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    for (const block of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const range = (manifest[block] as Record<string, unknown> | undefined)?.[pkg];
      if (typeof range === "string") return range;
    }
  } catch {
    // No readable manifest: the range is not the project's to name.
  }
  return undefined;
}

/**
 * Install each package, then read how it registers.
 *
 * The retry is not defensive padding. Every module published today peers on
 * `@xano/sdk` with a range that names no prerelease, and npm excludes
 * prereleases from those — so a scaffold built by a PRERELEASE CLI fails every
 * module install, for a reason that has nothing to do with the module or with
 * what the user asked for. Retried rather than pre-empted with a flag on the
 * first attempt, because `--legacy-peer-deps` up front would also hide a
 * genuine incompatibility, and that is worth reporting.
 */
/** `cd <dir> && `, spelled from where `init` was typed — empty when that is `dir` itself. */
export function inProject(dir: string): string {
  const here = process.cwd();
  if (resolve(dir) === resolve(here)) return "";
  const rel = relative(here, resolve(dir));
  return `cd ${shellWord(rel === "" || rel.startsWith("..") ? resolve(dir) : rel)} && `;
}

export async function installModules(
  dir: string,
  packages: readonly string[],
): Promise<ModuleOutcome> {
  const installed: string[] = [];
  const failed: string[] = [];
  const reported: string[] = [];
  const legacyPeer: string[] = [];
  const registered: ModuleRegistration[] = [];
  const unwired: UnwiredModule[] = [];
  const toolchain: string[] = [];
  const present = new Set<string>();

  const { manager } = installSite(dir);
  for (const specifier of packages) {
    /*
     * One self-erasing line per package, and npm's own narration kept off the
     * screen.
     *
     * A successful `npm install` prints a tree summary, a funding pitch and an
     * audit count — twenty-odd lines that say nothing the `✓` does not, and
     * that land in the MIDDLE of the init questionnaire, pushing the question
     * the user is being asked off the top of the terminal. The output is
     * captured rather than silenced: a failure prints all of it, because that
     * is the one time those lines carry the reason.
     *
     * `stop()` in a `finally` — an escaping error must not leave a live
     * interval and a half-drawn frame behind.
     */
    const spin = spinner(`Installing ${specifier}`);
    let result: AddOutcome;
    try {
      result = await addDependency(dir, specifier, {
        onLink: (member) => spin.update(`Linking ${member} into the npm workspace`),
        onRetry: () => spin.update(`Installing ${specifier} (retrying with --legacy-peer-deps)`),
      });
    } finally {
      spin.stop();
    }
    const { site, installSpec } = result;
    // The first attempt's output, kept when the retry replaced it. Without it a
    // peer conflict whose retry ALSO fails reports only the second attempt's
    // error — which may not mention peers at all, so the one fact that explains
    // the whole episode is the one fact thrown away.
    const peerConflict = result.peerConflict;
    if (peerConflict !== null && result.status === 0) legacyPeer.push(specifier);

    if (result.status !== 0) {
      failed.push(specifier);
      // ONE warning per failed module, npm's reason its remedy lines — so the
      // `--json` entry carries the reason too, not only the stderr under it
      // (E2E pass 28: the entry said only "failed"). What npm's LAST answer was,
      // classified — the retry's output, when there was one. A retry that failed
      // on something else (no published version of a range) was reported as the
      // peer conflict that prompted it (E2E pass 25: ETARGET on the project's own
      // `@xano/sdk` range read as a peer problem).
      const cause = classifyNpmFailure(result.output, dir);
      // npm's own words, minus its stack frames, indented under the warning so a
      // failure reads as one block rather than as the wall of text this spinner
      // exists to prevent on the success path.
      const reason = condenseNpmError(result.output);
      if (reason !== "") reported.push(reason);
      warn(`${manager} ${[...addArgs(manager, installSpec), ...site.scope].join(" ")} failed — the module was not added.`, "module.install-failed", [
        ...(cause !== undefined
          ? [cause]
          : // Said even though the retry's own error follows, because the retry is
            // otherwise invisible: it was announced only in spinner text, which the
            // spinner erases. Only when the peer conflict is still what failed.
            peerConflict !== null
            ? [
                result.retried
                  ? `It declares a peer range this CLI does not satisfy; --legacy-peer-deps did not resolve it either.`
                  : `It declares a peer range this CLI does not satisfy, and the install ran out of time before --legacy-peer-deps could be tried.`,
              ]
            : []),
        ...(reason === "" ? [] : [reason]),
        // Named, so the line is a command to paste rather than a template — and
        // from inside the new project, since it is printed before the `cd`.
        `Add it with \`${inProject(dir)}xanosdk marketplace install ${specifier}\` once ${manager}'s error is fixed.`,
      ]);
      continue;
    }

    // The peer retry is reported here rather than where it happened: a warning
    // written while the spinner was live would have been erased by the next
    // frame.
    if (peerConflict !== null) {
      warn(
        `${specifier} declares a peer range this CLI does not satisfy — installed with --legacy-peer-deps.`,
        "module.legacy-peer-deps",
      );
    }
    // The NAME the manager recorded, which is what the backend imports — for a
    // path, the name in that directory's package.json, never the path. A
    // success the project's package.json and resolver do not show is no
    // success.
    const pkg = result.landed;
    if (pkg === undefined) {
      failed.push(specifier);
      warn(
        `${manager} reported ${specifier} installed, but ${result.recorded === undefined ? "it is not in this project's package.json" : `${result.recorded} does not resolve from this project`} — the module was not added.`,
        "module.install-failed",
        [`Add it with \`${inProject(dir)}xanosdk marketplace install ${shellWord(specifier)}\`.`],
      );
      continue;
    }

    // A module whose hooks were built against a contract this CLI does not have
    // would register and apply nothing, and the discovery that runs later in
    // this same `init` refuses it — which would fail the scaffold AFTER it had
    // written a project. Reported as a failed module and taken back off disk
    // instead: init's own contract is that a module it could not add is a
    // warning and a project that still works, never a half-built directory.
    //
    // npm's peer resolution does not settle this. It refuses the tree, then
    // `installWithPeerRetry` installs it anyway — deliberately, because npm
    // excludes prereleases from every range a module declares and a prerelease
    // CLI would otherwise fail every install. `sdkPeerSkew` is the reading that
    // tells the two apart.
    const skew = await sdkPeerSkewOf(dir, pkg);
    if (skew !== null) {
      failed.push(specifier);
      warn(
        `${specifier} requires \`@xano/sdk\` ${skew.range} — the module was not added.`,
        "module.sdk-skew",
        [
          `This CLI is ${skew.sdkVersion}, so its hooks were built against a contract this one ` +
            `does not have. Upgrade the CLI, or use a ${pkg} built for it.`,
        ],
      );
      await removeQuietly(dir, pkg);
      continue;
    }

    success(`Installed ${specifier}`);

    installed.push(specifier);
    present.add(pkg);
    const registration = await readRegistration(dir, pkg);
    // A module from a path is not a catalogue entry: its own README has its wiring.
    const readme = isLocalSpecifier(specifier) ? localReadme(dir, pkg) : undefined;
    const where = readme === undefined ? {} : { readme };
    if ("toolchain" in registration) toolchain.push(pkg);
    else if ("unwired" in registration) {
      const reason = readme === undefined ? registration.unwired : `${registration.unwired} — see ${readme} (from the project root) for its wiring`;
      unwired.push({ pkg, reason, ...where });
    }
    else registered.push({ ...registration, ...where });
  }

  // Everything installed. What can actually be written is decided next, and a
  // module that cannot be is still installed — adding it later is one line.
  const { writable, unwired: unwritable } = partitionRegistrations(registered, present);
  unwired.push(...unwritable);

  return { installed, failed, reported, legacyPeer, registered: writable, unwired, toolchain };
}

/** `pkg`'s README as the project resolves it, else its package directory — relative to `dir`, POSIX. */
function localReadme(dir: string, pkg: string): string | undefined {
  const at = installedPackageDir(dir, pkg);
  if (at === null) return undefined;
  const readme = ["README.md", "readme.md", "README"].map((name) => join(at, name)).find((path) => existsSync(path));
  // The resolver answers with real paths, so the project's is compared too.
  return relative(realpathSync(dir), readme ?? at).split(sep).join("/");
}

/** The declared SDK range this CLI is definitively outside of, with the version it compared. */
async function sdkPeerSkewOf(
  dir: string,
  pkg: string,
): Promise<{ range: string; sdkVersion: string } | null> {
  const manifest = readInstalledManifest(dir, pkg);
  if (manifest === null) return null;
  const [{ sdkPeerSkew }, { readVersion }] = await Promise.all([
    import("./toolchain-modules.js"),
    import("./cli.js"),
  ]);
  const sdkVersion = readVersion();
  const range = sdkPeerSkew(manifest, sdkVersion);
  return range === null ? null : { range, sdkVersion };
}

/**
 * Take a module back off disk, saying nothing unless it fails.
 *
 * The caller has already reported why, and a second line about the cleanup
 * would bury it. A FAILED removal is said, though: it leaves the package in
 * `dependencies` where every later command refuses it, which the reader can
 * only act on if they know.
 */
async function removeQuietly(dir: string, pkg: string): Promise<void> {
  const result = await removeDependency(dir, pkg);
  if (result.status === 0 && !result.stillListed) return;
  warn(
    `${pkg} could not be removed again — it is still in this project's dependencies.`,
    "module.uninstall-failed",
    [`Run \`${inProject(dir)}${removeCommandFor(dir, pkg)}\` to finish taking it out.`],
  );
}
