/**
 * Bring a scaffolded project up to the current lambda type-check layout: the
 * lambda modules under `xano/lambdas/` check under their own tsconfig (which
 * loads the lambda runtime's globals), the project tsconfig excludes that
 * directory, and every script that type-checks runs `tsc -p xano/lambdas`.
 *
 * Run by `xanosdk upgrade`. It touches only what it can recognise as the
 * scaffold's own rendering — a script still exactly as `init` writes it, minus
 * the lambda step — and names the exact step for anything customised instead
 * of rewriting it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { allFrontendPresets } from "./frontend-presets.js";
import { renderLambdaTsconfig, renderPackageJson } from "./init-templates.js";

const LAMBDAS_DIR = "xano/lambdas";
const LAMBDA_TSCONFIG = `${LAMBDAS_DIR}/tsconfig.json`;
const LAMBDA_STEP = ` && tsc -p ${LAMBDAS_DIR}`;

/** An earlier scaffold's lambda tsconfig: it named the declarations by a node_modules path a hoisted workspace does not have. */
const PATH_LISTED_FORM = {
  extends: "../../tsconfig.json",
  compilerOptions: { lib: ["ES2022"], types: [] },
  files: ["../../node_modules/@xano/sdk/types/lambda-globals.d.ts"],
  include: ["**/*.ts"],
  exclude: [],
};

export interface LambdaConfigReconcile {
  /** Project-relative paths written. */
  changed: string[];
  /** Steps left to the user, each runnable as written. */
  manual: string[];
}

/** Each scaffold script that type-checks, as `init` renders it now and as it rendered it before the lambda step. */
function scaffoldScripts(): Map<string, { current: string; before: string }[]> {
  const out = new Map<string, { current: string; before: string }[]>();
  for (const preset of allFrontendPresets()) {
    const scripts = (JSON.parse(renderPackageJson({ appName: "app", sdkVersion: "0.0.1" }, preset)) as {
      scripts: Record<string, string>;
    }).scripts;
    for (const [name, current] of Object.entries(scripts)) {
      if (!current.includes(LAMBDA_STEP)) continue;
      out.set(name, [...(out.get(name) ?? []), { current, before: current.split(LAMBDA_STEP).join("") }]);
    }
  }
  return out;
}

function indentOf(raw: string): string | number {
  return /^(\t+)"/m.exec(raw)?.[1] ?? /^( +)"/m.exec(raw)?.[1]?.length ?? 2;
}

function writeJsonLike(path: string, raw: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, indentOf(raw)) + (raw.endsWith("\n") ? "\n" : ""));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The lambda step for a customised script, worded by what the script holds: after its own `tsc`, or ahead of everything. */
function manualStep(name: string, script: string): string {
  const check = script
    .split("&&")
    .map((part) => part.trim())
    .find((part) => /^(npx\s+)?tsc\b/.test(part));
  return check !== undefined
    ? `add \`&& tsc -p ${LAMBDAS_DIR}\` after \`${check}\` in the "${name}" script of package.json`
    : `prepend \`tsc -p ${LAMBDAS_DIR} && \` to the "${name}" script of package.json`;
}

export function reconcileLambdaConfig(dir: string): LambdaConfigReconcile {
  const changed: string[] = [];
  const manual: string[] = [];
  const pkgPath = join(dir, "package.json");
  const tsconfigPath = join(dir, "tsconfig.json");
  if (!existsSync(pkgPath) || !existsSync(tsconfigPath) || !existsSync(join(dir, "xano"))) return { changed, manual };

  const pkgRaw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> };
  const scripts = pkg.scripts ?? {};
  const known = scaffoldScripts();
  const shapes = [...known].filter(([name, forms]) => {
    const script = scripts[name];
    return typeof script === "string" && forms.some((f) => f.current === script || f.before === script);
  });
  // Not a scaffold — or none of its type-checking scripts is still the scaffold's:
  // nothing here was written by `init`, so nothing is changed.
  if (shapes.length === 0) return { changed, manual };

  // The scripts: a scaffold rendering gains the step; a customised one is named.
  let scriptsChanged = false;
  for (const [name, forms] of known) {
    const script = scripts[name];
    if (typeof script !== "string" || script.includes(`tsc -p ${LAMBDAS_DIR}`)) continue;
    const form = forms.find((f) => f.before === script);
    if (form !== undefined) {
      scripts[name] = form.current;
      scriptsChanged = true;
    } else {
      manual.push(manualStep(name, script));
    }
  }
  if (scriptsChanged) {
    writeJsonLike(pkgPath, pkgRaw, pkg);
    changed.push("package.json");
  }

  // The lambdas' own config: written when absent, replaced when it is an earlier scaffold's.
  const lambdaPath = join(dir, LAMBDA_TSCONFIG);
  let lambdaCurrent: unknown;
  try {
    lambdaCurrent = existsSync(lambdaPath) ? JSON.parse(readFileSync(lambdaPath, "utf8")) : undefined;
  } catch {
    lambdaCurrent = null;
  }
  if (lambdaCurrent === undefined || sameJson(lambdaCurrent, PATH_LISTED_FORM)) {
    mkdirSync(dirname(lambdaPath), { recursive: true });
    writeFileSync(lambdaPath, renderLambdaTsconfig());
    changed.push(LAMBDA_TSCONFIG);
  }

  // The project config leaves that directory to it.
  const tsRaw = readFileSync(tsconfigPath, "utf8");
  let tsconfig: { exclude?: unknown } | undefined;
  try {
    tsconfig = JSON.parse(tsRaw) as { exclude?: unknown };
  } catch {
    tsconfig = undefined;
  }
  const exclude = tsconfig?.exclude;
  const excludes = Array.isArray(exclude) && exclude.some((e) => e === LAMBDAS_DIR || e === `${LAMBDAS_DIR}/`);
  if (!excludes) {
    if (tsconfig !== undefined && (exclude === undefined || Array.isArray(exclude))) {
      // An absent `exclude` defaults to node_modules; listing one replaces that default, so it is kept.
      tsconfig.exclude = [...(Array.isArray(exclude) ? exclude : ["node_modules"]), LAMBDAS_DIR];
      writeJsonLike(tsconfigPath, tsRaw, tsconfig);
      changed.push("tsconfig.json");
    } else {
      manual.push(`add "${LAMBDAS_DIR}" to the "exclude" list of tsconfig.json`);
    }
  }
  return { changed, manual };
}
