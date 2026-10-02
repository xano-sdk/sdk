/**
 * Minimal YAML-subset parser for the Xano engine's statement schema files.
 *
 * The schema YAMLs are regular, 2-space-indented, and use custom tags
 * (`!class`, `!function`, `!kinds`, `!assign`, `static:text`, …) as scalar
 * value prefixes. A general YAML library would need every tag registered and
 * would still parse far more than the codegen needs; this purpose-built parser
 * keeps custom tags as raw scalar strings and produces a generic tree the
 * generator walks. Anything it cannot parse cleanly surfaces downstream as a
 * skip-with-reason (never a silent wrong encoding).
 */

/** A parsed YAML node: scalar string, ordered map, or list. */
export type YamlNode = string | YamlMap | YamlList;
export interface YamlMap {
  [key: string]: YamlNode;
}
export type YamlList = YamlNode[];

interface Line {
  indent: number;
  text: string;
}

function tokenize(src: string): Line[] {
  const out: Line[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    out.push({ indent: raw.length - raw.trimStart().length, text: trimmed });
  }
  return out;
}

/** Split `key: value` on the first ": " (colon-space). A bare trailing ":" means a nested block. */
function splitKeyValue(text: string): { key: string; value: string | null } {
  const sep = text.indexOf(": ");
  if (sep !== -1) {
    return { key: text.slice(0, sep), value: text.slice(sep + 2).trim() };
  }
  if (text.endsWith(":")) {
    return { key: text.slice(0, -1), value: null };
  }
  // A scalar with no mapping — treat the whole thing as a key with empty value.
  return { key: text, value: "" };
}

function parseNode(lines: Line[], start: number, indent: number): [YamlNode, number] {
  let i = start;
  // List block: lines at this indent beginning with "- ".
  if (lines[start]!.text.startsWith("- ")) {
    const list: YamlList = [];
    let line: Line | undefined;
    while ((line = lines[i]) && line.indent === indent && line.text.startsWith("- ")) {
      list.push(line.text.slice(2).trim());
      i++;
    }
    return [list, i];
  }
  // Map block.
  const map: YamlMap = {};
  let line: Line | undefined;
  while ((line = lines[i]) && line.indent === indent && !line.text.startsWith("- ")) {
    const { key, value } = splitKeyValue(line.text);
    i++;
    if (value === null) {
      const next = lines[i];
      // A nested block is either more-indented, or a same-indent list (YAML allows
      // `key:` followed by `- item` lines at the parent's own indentation).
      if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith("- ")))) {
        const [child, after] = parseNode(lines, i, next.indent);
        map[key] = child;
        i = after;
      } else {
        map[key] = "";
      }
    } else {
      map[key] = value;
    }
  }
  return [map, i];
}

/** Parse a statement schema YAML string into a generic tree (top level is a map). */
export function parseYaml(src: string): YamlMap {
  const lines = tokenize(src);
  if (lines.length === 0) return {};
  const [node] = parseNode(lines, 0, lines[0]!.indent);
  return typeof node === "object" && !Array.isArray(node) ? node : {};
}
