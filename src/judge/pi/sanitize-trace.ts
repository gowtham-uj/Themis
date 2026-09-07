import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_JSON_BYTES = 16 * 1024 * 1024;

/** Remove provider-private reasoning fields from an arbitrary JSON value. */
export function stripReasoningContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripReasoningContent);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "reasoning_content") continue;
    out[key] = stripReasoningContent(child);
  }
  return out;
}

function sanitizeJsonLine(line: string): string {
  if (line.trim() === "") return line;
  try {
    return JSON.stringify(stripReasoningContent(JSON.parse(line) as unknown));
  } catch (error) {
    if (/"reasoning_content"\s*:/.test(line)) {
      throw new Error(`refusing to publish an unparseable trace row containing reasoning_content: ${error instanceof Error ? error.message : String(error)}`);
    }
    return line;
  }
}

/** Streaming JSONL transform used before PI traces enter a published archive. */
export function createReasoningContentStripper(): Transform {
  let pending = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) this.push(`${sanitizeJsonLine(line)}\n`);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        if (pending !== "") this.push(sanitizeJsonLine(pending));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

async function copySanitizedJson(source: string, destination: string): Promise<void> {
  const info = await stat(source);
  if (info.size > MAX_JSON_BYTES) {
    throw new Error(`refusing to publish oversized PI JSON trace ${source}`);
  }
  const raw = await readFile(source, "utf8");
  const sanitized = JSON.stringify(stripReasoningContent(JSON.parse(raw) as unknown), null, 2);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${sanitized}\n`, "utf8");
}

/** Copy a PI trace entry while stripping reasoning_content from JSON and JSONL. */
export async function copySanitizedPiTraceEntry(source: string, destination: string): Promise<void> {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source)) {
      await copySanitizedPiTraceEntry(join(source, name), join(destination, name));
    }
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  const extension = extname(source).toLowerCase();
  if (extension === ".jsonl") {
    await pipeline(createReadStream(source), createReasoningContentStripper(), createWriteStream(destination));
    return;
  }
  if (extension === ".json") {
    await copySanitizedJson(source, destination);
    return;
  }
  await pipeline(createReadStream(source), createWriteStream(destination));
}
