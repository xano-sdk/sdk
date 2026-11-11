/**
 * `xanosdk ai models` — the live Xano AI model catalog: which models each AI
 * statement takes, which one is suggested, where each runs, and what each
 * allows. Read live, so a model added on the Xano side shows up here without an
 * SDK release; there is no bundled fallback, and every state where the live
 * answer is not usable fails as itself.
 *
 * Tokenless, for any credential state: a stored OAuth profile only decides
 * WHICH sign-in server answers (and carries the instance gateway it was told
 * about at login). A meta-token profile or an environment credential has no
 * sign-in server, so it reads the default one.
 *
 * Node-only (the credential file) and lazily imported from cli.ts.
 */
import type { ParsedArgs } from "./cli.js";
import { unknownSubcommand } from "./errors.js";
import { isMachineOutput, writeJson } from "./output.js";
import { printHuman, safeText, stdoutStyle } from "./ui.js";
import {
  AI_STATEMENTS,
  assertAiCatalogReady,
  fetchAiCatalog,
  resolveAiCatalogHost,
  type AiCatalog,
  type AiCatalogEntry,
  type AiStatement,
} from "./ai-catalog.js";
import { readCredentialFile, readProfile, resolveAuthFilePath } from "../auth/store.js";
import { resolveActiveProfile } from "../auth/profile-select.js";
import { findProjectPointer } from "../auth/profile-pointer.js";
import { environmentCredentialVars } from "../auth/token.js";

/** The `ai` family's verbs. */
export async function runAiCommand(args: ParsedArgs): Promise<void> {
  switch (args.subcommand) {
    case "models":
      return runAiModelsCommand(args);
    default:
      throw unknownSubcommand("ai", args.subcommand, args.positionals);
  }
}

/**
 * What the active credential says about Xano AI: the sign-in server it was
 * minted at, and the instance gateway login was told about. Both only for an
 * OAuth profile that is actually the active credential.
 *
 * Best effort: the read is public, so an unreadable credential file must not
 * stop it. The host the answer came from is printed either way.
 */
function activeOAuthHints(args: ParsedArgs): { authHost?: string; gatewayUrl?: string } {
  try {
    // An environment credential outranks every stored profile, and has no sign-in server.
    if (environmentCredentialVars().vars.length > 0) return {};
    const path = resolveAuthFilePath(args);
    const file = readCredentialFile(path);
    if (file === null) return {};
    const selection = resolveActiveProfile({
      flag: args.profile,
      fileDefault: file.default,
      readPointer: () => findProjectPointer(process.cwd())?.profile,
    });
    const record = readProfile(file, selection.name, path);
    if (record?.type !== "oauth") return {};
    return { authHost: record.auth_host, gatewayUrl: record.ai_gateway_url };
  } catch {
    return {};
  }
}

/** The catalog with unlisted entries dropped, unless `all`. */
function visible(catalog: AiCatalog, all: boolean): Record<AiStatement, AiCatalogEntry[]> {
  return Object.fromEntries(
    AI_STATEMENTS.map((s) => [s, all ? catalog.statements[s] : catalog.statements[s].filter((e) => e.listed)]),
  ) as Record<AiStatement, AiCatalogEntry[]>;
}

/** `xanosdk ai models [--all] [--json]`. */
export async function runAiModelsCommand(args: ParsedArgs): Promise<void> {
  const hints = activeOAuthHints(args);
  const host = resolveAiCatalogHost(hints.authHost);
  const catalog = await fetchAiCatalog(host);
  assertAiCatalogReady(catalog, host);
  const statements = visible(catalog, args.all);

  if (isMachineOutput(args)) {
    writeJson({
      version: 1,
      source: "live",
      host,
      generated_at: catalog.generated_at ?? null,
      available: catalog.available,
      ...(hints.gatewayUrl === undefined ? {} : { gateway_url: hints.gatewayUrl }),
      statements,
      agent: { default: catalog.agent.default ?? null, models: catalog.agent.models },
    });
    return;
  }

  printHuman(renderCatalog(catalog, statements, host, hints.gatewayUrl, args.all));
}

/** A scalar or a list of scalars as one short value; anything nested is left out of the terminal view. */
function optionValue(v: unknown): string | undefined {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v.join(", ");
  return undefined;
}

function renderEntry(e: AiCatalogEntry, s: ReturnType<typeof stdoutStyle>): string[] {
  const marks = [e.suggested ? s.green("suggested") : undefined, e.listed ? undefined : s.yellow("unlisted")]
    .filter((m): m is string => m !== undefined)
    .join(" ");
  const out = [`    ${s.bold(safeText(e.model))}  ${safeText(e.label)}${marks === "" ? "" : `  ${marks}`}`];
  const facts = [
    e.tier !== "" ? `tier ${e.tier}` : undefined,
    e.stage !== "" ? `stage ${e.stage}` : undefined,
    e.location !== "" ? `runs at ${e.location}` : undefined,
    e.locations.length > 0 ? `locations ${e.locations.join(", ")}` : undefined,
  ].filter((f): f is string => f !== undefined);
  if (facts.length > 0) out.push(`      ${s.dim(safeText(facts.join(" · ")))}`);
  const options = Object.entries(e.options).flatMap(([k, v]) => {
    const value = optionValue(v);
    return value === undefined ? [] : [`${k} ${value}`];
  });
  if (options.length > 0) out.push(`      ${s.dim(safeText(`options: ${options.join(" · ")}`))}`);
  if (e.price !== "") out.push(`      ${s.dim(safeText(`list price: ${e.price}`))}`);
  return out;
}

function renderCatalog(
  catalog: AiCatalog,
  statements: Record<AiStatement, AiCatalogEntry[]>,
  host: string,
  gatewayUrl: string | undefined,
  all: boolean,
): string {
  const s = stdoutStyle();
  const out: string[] = [""];
  out.push(`  ${s.bold("Xano AI models")} ${s.dim(`· the hub catalog from ${safeText(host)}`)}`);
  if (gatewayUrl !== undefined) out.push(`  ${s.dim(`Your instance's gateway: ${safeText(gatewayUrl)}`)}`);
  if (catalog.generated_at !== undefined) out.push(`  ${s.dim(`Generated ${safeText(catalog.generated_at)}`)}`);

  for (const statement of AI_STATEMENTS) {
    out.push("", `  ${s.bold(s.cyan(statement))}`);
    const entries = statements[statement];
    if (entries.length === 0) out.push(`    ${s.dim("(no models)")}`);
    for (const e of entries) out.push(...renderEntry(e, s));
  }

  if (catalog.agent.models.length > 0 || catalog.agent.default !== undefined) {
    out.push("", `  ${s.bold(s.cyan("agent"))}`);
    if (catalog.agent.default !== undefined) out.push(`    default  ${safeText(catalog.agent.default)}`);
    if (catalog.agent.models.length > 0) out.push(`    models   ${safeText(catalog.agent.models.join(", "))}`);
  }

  const hidden = AI_STATEMENTS.reduce((n, st) => n + catalog.statements[st].filter((e) => !e.listed).length, 0);
  if (!all && hidden > 0) {
    out.push("", `  ${s.dim(`${hidden} unlisted model${hidden === 1 ? "" : "s"} hidden. xanosdk ai models --all shows them.`)}`);
  }
  return out.join("\n") + "\n\n";
}
