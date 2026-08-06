/**
 * Minimal, zero-dep YAML frontmatter splitter + subset parser.
 *
 * Choice: hand-rolled (no gray-matter / js-yaml) so ingest stays dependency-free
 * and avoids native/native-ish transitive deps. Supports a safe subset of YAML:
 * scalars (string/number/bool/null), arrays of scalars or objects, and nested
 * plain objects. Does not throw on malformed input — returns partial results
 * and records warnings for callers to surface via TaskSource.validate.
 */

export interface SplitFrontmatterResult {
  /** Parsed frontmatter; empty record when no `---` fence is present. */
  frontmatter: Record<string, unknown>;
  /** Markdown body after the closing fence (or the whole text if none). */
  body: string;
  /** Non-fatal parse issues (malformed lines, unknown tokens). */
  warnings: string[];
}

/**
 * Split a markdown document into YAML frontmatter + body.
 * Tolerant: files without a leading `---` fence yield `{ frontmatter: {}, body: text }`.
 */
export function splitFrontmatter(text: string): SplitFrontmatterResult {
  const warnings: string[] = [];
  const normalized = text.replace(/^﻿/, "");
  const lines = normalized.split(/\r?\n/);

  if (lines.length === 0 || lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: normalized, warnings };
  }

  // Find closing fence.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]?.trim();
    if (t === "---" || t === "...") {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    // Unclosed fence: treat whole file as body, warn.
    warnings.push("frontmatter: opening --- without closing fence; treating as plain body");
    return { frontmatter: {}, body: normalized, warnings };
  }

  const yamlText = lines.slice(1, closeIdx).join("\n");
  const body = lines.slice(closeIdx + 1).join("\n").replace(/^\n/, "");
  const { value, warnings: yamlWarnings } = parseYamlSubset(yamlText);
  warnings.push(...yamlWarnings);

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (yamlText.trim().length > 0) {
      warnings.push("frontmatter: root is not a mapping; ignoring");
    }
    return { frontmatter: {}, body, warnings };
  }

  return { frontmatter: value as Record<string, unknown>, body, warnings };
}

/** Parse a safe YAML subset into a JS value. Never throws. */
export function parseYamlSubset(text: string): { value: unknown; warnings: string[] } {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  try {
    const value = parseBlock(lines, 0, 0, warnings).value;
    return { value: value ?? {}, warnings };
  } catch (err) {
    warnings.push(
      `frontmatter: parse failed (${err instanceof Error ? err.message : String(err)}); returning empty`,
    );
    return { value: {}, warnings };
  }
}

interface ParseResult {
  value: unknown;
  nextIndex: number;
}

function parseBlock(
  lines: string[],
  start: number,
  minIndent: number,
  warnings: string[],
): ParseResult {
  // Peek first non-empty, non-comment line to decide mapping vs sequence.
  let i = start;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    break;
  }
  if (i >= lines.length) {
    return { value: {}, nextIndex: i };
  }

  const first = lines[i] ?? "";
  const indent = leadingSpaces(first);
  if (indent < minIndent) {
    return { value: {}, nextIndex: i };
  }

  const trimmed = first.trim();
  if (trimmed.startsWith("- ")) {
    return parseSequence(lines, i, indent, warnings);
  }
  return parseMapping(lines, i, indent, warnings);
}

function parseMapping(
  lines: string[],
  start: number,
  indent: number,
  warnings: string[],
): ParseResult {
  const obj: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const lineIndent = leadingSpaces(raw);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      // Orphan indented line — skip with warning.
      warnings.push(`frontmatter: unexpected indent at line ${i + 1}: ${raw.trim()}`);
      i++;
      continue;
    }

    const trimmed = raw.trim();
    if (trimmed.startsWith("- ")) {
      // Sequence item at mapping indent — end mapping.
      break;
    }

    const colonIdx = findKeyColon(trimmed);
    if (colonIdx === -1) {
      warnings.push(`frontmatter: malformed mapping line ${i + 1}: ${trimmed}`);
      i++;
      continue;
    }

    const key = unquote(trimmed.slice(0, colonIdx).trim());
    const rest = trimmed.slice(colonIdx + 1).trim();
    i++;

    if (rest === "" || rest === "|" || rest === ">") {
      // Nested block (mapping or sequence) at greater indent.
      const nested = parseBlock(lines, i, indent + 1, warnings);
      obj[key] = nested.value;
      i = nested.nextIndex;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      obj[key] = parseFlowSequence(rest, warnings);
    } else if (rest.startsWith("{") && rest.endsWith("}")) {
      obj[key] = parseFlowMapping(rest, warnings);
    } else {
      obj[key] = parseScalar(rest);
    }
  }

  return { value: obj, nextIndex: i };
}

function parseSequence(
  lines: string[],
  start: number,
  indent: number,
  warnings: string[],
): ParseResult {
  const arr: unknown[] = [];
  let i = start;

  while (i < lines.length) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const lineIndent = leadingSpaces(raw);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      warnings.push(`frontmatter: unexpected indent at line ${i + 1}: ${raw.trim()}`);
      i++;
      continue;
    }

    const trimmed = raw.trim();
    if (!trimmed.startsWith("- ")) {
      // Not a sequence item at this indent — end sequence.
      break;
    }

    const rest = trimmed.slice(2).trim();
    i++;

    if (rest === "" || rest === "|" || rest === ">") {
      const nested = parseBlock(lines, i, indent + 2, warnings);
      arr.push(nested.value);
      i = nested.nextIndex;
    } else {
      // Inline key: value after `- ` → object item, possibly with nested fields.
      const colonIdx = findKeyColon(rest);
      if (colonIdx !== -1) {
        const key = unquote(rest.slice(0, colonIdx).trim());
        const valuePart = rest.slice(colonIdx + 1).trim();
        const item: Record<string, unknown> = {};

        if (valuePart === "" || valuePart === "|" || valuePart === ">") {
          const nested = parseBlock(lines, i, indent + 2, warnings);
          item[key] = nested.value;
          i = nested.nextIndex;
        } else if (valuePart.startsWith("[") && valuePart.endsWith("]")) {
          item[key] = parseFlowSequence(valuePart, warnings);
        } else if (valuePart.startsWith("{") && valuePart.endsWith("}")) {
          item[key] = parseFlowMapping(valuePart, warnings);
        } else {
          item[key] = parseScalar(valuePart);
        }

        // Consume subsequent mapping keys nested under this list item.
        while (i < lines.length) {
          const nextRaw = lines[i] ?? "";
          if (nextRaw.trim() === "" || nextRaw.trimStart().startsWith("#")) {
            i++;
            continue;
          }
          const nextIndent = leadingSpaces(nextRaw);
          if (nextIndent <= indent) break;
          // Nested mapping under the list item.
          if (nextRaw.trim().startsWith("- ")) {
            // Nested sequence under key — rare; parse as block under current item? stop and let outer handle.
            break;
          }
          const nestedMap = parseMapping(lines, i, nextIndent, warnings);
          Object.assign(item, nestedMap.value as Record<string, unknown>);
          i = nestedMap.nextIndex;
          break;
        }

        arr.push(item);
      } else if (rest.startsWith("[") && rest.endsWith("]")) {
        arr.push(parseFlowSequence(rest, warnings));
      } else if (rest.startsWith("{") && rest.endsWith("}")) {
        arr.push(parseFlowMapping(rest, warnings));
      } else {
        arr.push(parseScalar(rest));
      }
    }
  }

  return { value: arr, nextIndex: i };
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return "";

  // Quoted strings.
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return unquote(s);
  }

  // Inline comment strip for unquoted scalars: `value # comment`
  const hashIdx = s.indexOf(" #");
  const bare = (hashIdx >= 0 ? s.slice(0, hashIdx) : s).trim();

  if (bare === "true" || bare === "True" || bare === "TRUE") return true;
  if (bare === "false" || bare === "False" || bare === "FALSE") return false;
  if (bare === "null" || bare === "Null" || bare === "NULL" || bare === "~") return null;

  // Numbers (int / float), reject leading-zero ints that look like versions? accept simple.
  if (/^-?\d+$/.test(bare)) {
    const n = Number(bare);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(bare) || /^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(bare)) {
    const n = Number(bare);
    if (!Number.isNaN(n)) return n;
  }

  return bare;
}

function parseFlowSequence(text: string, warnings: string[]): unknown[] {
  // Very small subset: [a, b, c] with scalar items.
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  const parts = splitTopLevel(inner, ",");
  return parts.map((p) => {
    const t = p.trim();
    if (t.startsWith("{") && t.endsWith("}")) return parseFlowMapping(t, warnings);
    if (t.startsWith("[") && t.endsWith("]")) return parseFlowSequence(t, warnings);
    return parseScalar(t);
  });
}

function parseFlowMapping(text: string, warnings: string[]): Record<string, unknown> {
  const inner = text.slice(1, -1).trim();
  const obj: Record<string, unknown> = {};
  if (inner === "") return obj;
  const parts = splitTopLevel(inner, ",");
  for (const part of parts) {
    const colonIdx = findKeyColon(part.trim());
    if (colonIdx === -1) {
      warnings.push(`frontmatter: malformed flow mapping entry: ${part.trim()}`);
      continue;
    }
    const t = part.trim();
    const key = unquote(t.slice(0, colonIdx).trim());
    const val = t.slice(colonIdx + 1).trim();
    if (val.startsWith("{") && val.endsWith("}")) {
      obj[key] = parseFlowMapping(val, warnings);
    } else if (val.startsWith("[") && val.endsWith("]")) {
      obj[key] = parseFlowSequence(val, warnings);
    } else {
      obj[key] = parseScalar(val);
    }
  }
  return obj;
}

/** Split by delimiter only at top-level (not inside quotes/brackets/braces). */
function splitTopLevel(text: string, delim: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      buf += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      buf += ch;
      continue;
    }
    if (ch === delim && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0 || text.endsWith(delim)) out.push(buf);
  return out;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  // Tabs count as 2 for a soft tolerance.
  if (n === 0 && line.startsWith("\t")) {
    let t = 0;
    while (t < line.length && line[t] === "\t") t++;
    return t * 2;
  }
  return n;
}

/** Find the colon separating key from value, ignoring colons inside quotes. */
function findKeyColon(text: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":") {
      // YAML requires space after colon for mapping, or end of string / start of nested.
      const next = text[i + 1];
      if (next === undefined || next === " " || next === "\t" || next === "\n") {
        return i;
      }
      // Also accept `key:` at end (nested block).
      if (i === text.length - 1) return i;
    }
  }
  return -1;
}

function unquote(s: string): string {
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      const inner = s.slice(1, -1);
      if (s.startsWith('"')) {
        return inner
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
      return inner.replace(/''/g, "'");
    }
  }
  return s;
}
