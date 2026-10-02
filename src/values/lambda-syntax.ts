/**
 * The Node half of the lambda syntax check: parse a body with esbuild's
 * TypeScript loader (a body may carry type annotations and top-level `await`),
 * wrapped as the async function body it is. Installed by the CLI (which the
 * Node entry loads); without esbuild resolvable, nothing is installed and no body is judged.
 */
import { createRequire } from "node:module";
import { installLambdaFreeReads, installLambdaSyntaxCheck, type LambdaSyntaxError } from "./lambda.js";
import { freeReads } from "./lambda-scope.js";

interface EsbuildLike {
  transformSync(code: string, options: { loader: "ts"; format?: "esm" }): unknown;
}

function loadEsbuild(): EsbuildLike | undefined {
  try {
    return createRequire(import.meta.url)("esbuild") as EsbuildLike;
  } catch {
    return undefined;
  }
}

const PREFIX = "async function __xanosdk_lambda() {\n";

/**
 * Install the Node-side lambda checks: the scope-aware binding reader, and the
 * esbuild-backed parse once esbuild resolves from here.
 */
export function installNodeLambdaChecks(): void {
  installLambdaFreeReads(freeReads);
  const esbuild = loadEsbuild();
  if (esbuild === undefined) return;
  installLambdaSyntaxCheck((body: string): LambdaSyntaxError | undefined => {
    try {
      esbuild.transformSync(`${PREFIX}${body}\n}`, { loader: "ts" });
      return undefined;
    } catch (err) {
      const first = (err as { errors?: Array<{ text?: string; location?: { line?: number; column?: number; lineText?: string } | null }> }).errors?.[0];
      if (first?.location == null || typeof first.text !== "string") return undefined;
      // Line 1 is the wrapper; a line past the body is its closing brace, where an
      // unterminated body reports — shown as the body's last line.
      const lines = body.split("\n");
      const line = (first.location.line ?? 2) - 1;
      const past = line > lines.length;
      return {
        line: past ? lines.length : Math.max(line, 1),
        column: past ? (lines[lines.length - 1] ?? "").length + 1 : (first.location.column ?? 0) + 1,
        message: first.text,
        lineText: past ? (lines[lines.length - 1] ?? "") : (first.location.lineText ?? ""),
      };
    }
  });
}
