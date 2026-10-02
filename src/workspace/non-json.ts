/**
 * Finding a value JSON cannot carry in an encoded object, and the refusal that
 * names it.
 *
 * A leaf module (no imports) so the export guard (`checkNonJsonValues`), the
 * bundle writer's backstop and the free-form config merge share one reading
 * and one path spelling — `example.input.f`, `settings.hook`, `list[2]`.
 */

/**
 * What a value is when JSON cannot carry it as written, or undefined when it can
 * (a primitive JSON writes, an array, or a plain record — their members are
 * checked on their own).
 *
 * A function becomes `null` or vanishes; a symbol vanishes; a bigint throws; a
 * Date is written as an ISO string and a Map, a Set or any class instance as
 * whatever enumerable keys it happens to have — `{}` for the collections. Each
 * one deploys something other than what was written, and only the function
 * used to be caught.
 */
export function nonJsonKind(value: unknown): string | undefined {
  switch (typeof value) {
    case "function":
      return "a function";
    case "symbol":
      return "a symbol";
    case "bigint":
      return `a bigint (${String(value)}n)`;
    case "object": {
      if (value === null || Array.isArray(value)) return undefined;
      const proto = Object.getPrototypeOf(value) as object | null;
      if (proto === null || proto === Object.prototype) return undefined;
      const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
      if (typeof name !== "string" || name === "") return "a class instance";
      return ["Date", "Map", "Set", "RegExp"].includes(name) ? `a ${name}` : `a ${name} instance`;
    }
    default:
      return undefined;
  }
}

/** The first value under `root` JSON cannot carry, in source order, with its path (`""` for `root`). */
export function findNonJson(root: unknown): { path: string; value: unknown } | undefined {
  const stack: Array<[unknown, string]> = [[root, ""]];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const [node, path] = stack.pop()!;
    if (nonJsonKind(node) !== undefined) return { path, value: node };
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], `${path}[${i}]`]);
      continue;
    }
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      stack.push([(node as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`]);
    }
  }
  return undefined;
}

/** What JSON does to each kind {@link nonJsonKind} names, and what to write instead. */
function jsonFate(value: unknown): [fate: string, instead: string] {
  if (typeof value === "symbol") return ["JSON drops it", "a string"];
  if (typeof value === "bigint") return ["`JSON.stringify` throws on it", "`Number(big)` or `String(big)`"];
  if (value instanceof Date) return ["JSON rewrites it as an ISO string", "`date.toISOString()` or its epoch ms"];
  if (value instanceof Map) return ["JSON writes it as `{}`", "`Object.fromEntries(map)`"];
  if (value instanceof Set) return ["JSON writes it as `{}`", "`[...set]`"];
  if (value instanceof RegExp) return ["JSON writes it as `{}`", "its `.source` string"];
  return ["JSON keeps only its own enumerable fields", "a plain record"];
}

/**
 * The refusal for a value JSON cannot carry, named where it sits. `location` is
 * a field path (`example.input.f`), or the export guard's `<owner>, at <path>`
 * — whose repeated owner is dropped, so the path reads once.
 */
export function nonJsonMessage(owner: string, location: string, value: unknown): string {
  if (location.startsWith(`${owner}, at `)) location = location.slice(owner.length + ", at ".length);
  if (typeof value !== "function") {
    const [fate, instead] = jsonFate(value);
    return (
      `${owner}: ${nonJsonKind(value) ?? "a value JSON cannot carry"} is stored at ${location}. ${fate}, so the ` +
      `bundle would not hold the value you wrote, and the next pull could not read it back. Write plain JSON ` +
      `there — ${instead}.`
    );
  }
  const tagged =
    typeof (value as { tag?: unknown }).tag === "string" && Array.isArray((value as { filters?: unknown }).filters);
  const input = (value as { value?: unknown }).value;
  return (
    `${owner}: ${tagged ? "a callable tagged value (a trigger input accessor such as `t.action`)" : "a function"} ` +
    `is stored as a function at ${location}. JSON writes a function as \`null\` (or drops it), so the bundle ` +
    `would carry a hole where the value was, and the next pull could not read it back.` +
    (tagged && typeof input === "string"
      ? ` Spell the input by name in this position — \`inp(${JSON.stringify(input)})\`.`
      : " Pass a tagged value (`c.*`, `ref()`, `inp()`, …) or a plain JSON value instead.")
  );
}
