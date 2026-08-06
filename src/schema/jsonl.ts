/**
 * Append-only JSONL I/O for canonical event streams.
 *
 * Writers are fsync-safe (durable after each append). Readers skip a truncated
 * trailing line so a crash mid-write never poisons a replay / SSE resume.
 *
 * Spec: plan/event-schema.md + P1 capture foundations.
 */

import { open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

/**
 * Append one object as a single JSON line (plus newline) and fsync.
 * Creates parent directories and the file if missing.
 */
export async function appendJsonl(
  path: string,
  obj: unknown,
): Promise<void> {
  const line = `${JSON.stringify(obj)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.write(line, undefined, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Yield each complete JSON object from a JSONL file.
 * A truncated last line (no trailing newline / incomplete JSON) is ignored.
 * Missing files yield an empty stream.
 */
export async function* readJsonl(path: string): AsyncIterable<unknown> {
  // open() fails synchronously-ish with ENOENT; createReadStream only errors async.
  let file;
  try {
    file = await open(path, "r");
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }

  const stream = file.createReadStream({ encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      // Empty lines (e.g. blank between records) are skipped.
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Incomplete / corrupt line — skip. Common when a writer crashed mid-line.
        continue;
      }
      yield parsed;
    }
  } finally {
    rl.close();
    stream.destroy();
    await file.close().catch(() => undefined);
  }
}

/**
 * Yield objects whose numeric `seq` is greater than `sinceSeq`.
 * Used by SSE resume: clients pass the last received seq and get the tail.
 * Non-object lines and objects without a finite `seq` are skipped.
 */
export async function* readFromSeq(
  path: string,
  sinceSeq: number,
): AsyncIterable<unknown> {
  for await (const obj of readJsonl(path)) {
    if (!isRecord(obj)) continue;
    const seq = obj.seq;
    if (typeof seq !== "number" || !Number.isFinite(seq)) continue;
    if (seq > sinceSeq) yield obj;
  }
}

/** Serialize one value as a single JSONL line (no trailing newline). */
export function toJsonlLine(value: unknown): string {
  return JSON.stringify(value);
}

/** Parse a single JSONL line; returns null for blank/whitespace-only lines. */
export function parseJsonlLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  return JSON.parse(trimmed) as unknown;
}

/**
 * Split a byte/string chunk stream into complete lines, yielding each full line
 * (without the trailing newline). Carries incomplete trailing data across chunks.
 * Does NOT yield a final incomplete buffer without a newline (truncation-safe).
 */
export async function* linesFromStream(
  stream: AsyncIterable<string | Buffer>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  }
  // Intentionally drop a trailing partial line (no terminating newline).
}

/** Parse a full JSONL string into an array of objects (skipping blank lines). */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  // Only complete lines: split and drop the final segment if text has no trailing \n
  // and the last piece is incomplete JSON. Simpler: process complete newline-delimited
  // segments; if the text ends without \n, try parse last — skip on failure.
  const endsWithNewline = text.endsWith("\n") || text.endsWith("\r\n");
  const parts = text.split(/\r?\n/);
  if (!endsWithNewline && parts.length > 0) {
    // Last segment may be truncated — attempt parse, drop on failure.
    const last = parts[parts.length - 1] ?? "";
    const head = parts.slice(0, -1);
    for (const line of head) {
      pushParsed(out, line);
    }
    if (last.length > 0) {
      try {
        const parsed = parseJsonlLine(last);
        if (parsed !== null) out.push(parsed);
      } catch {
        // truncated trailing line — ignore
      }
    }
    return out;
  }
  for (const line of parts) {
    pushParsed(out, line);
  }
  return out;
}

function pushParsed(out: unknown[], line: string): void {
  try {
    const parsed = parseJsonlLine(line);
    if (parsed !== null) out.push(parsed);
  } catch {
    // skip unparseable complete lines (corrupt)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
