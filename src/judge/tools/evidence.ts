/**
 * Mediated evidence read — catalog id + byte/line range only.
 * No arbitrary host paths (plan §6).
 */

import { open, readFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";

export class EvidenceAccessError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "denied" | "range" | "limit",
  ) {
    super(message);
    this.name = "EvidenceAccessError";
  }
}

export interface EvidenceCatalogItem {
  id: string;
  /** Archive-relative path. */
  path: string;
  bytes: number;
}

export interface EvidenceReadRequest {
  catalogId: string;
  /** Byte offset into the file. */
  offset?: number;
  /** Max bytes to return. */
  length?: number;
}

export interface EvidenceReadResult {
  catalogId: string;
  path: string;
  offset: number;
  length: number;
  content: string;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

/** Bound a catalog-relative path inside the archive root. */
export function resolveCatalogPath(archiveRoot: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\0")) {
    throw new EvidenceAccessError("absolute or corrupt path denied", "denied");
  }
  // Reject any .. segment before normalize can erase it into a false-safe path.
  // normalize("../etc/passwd") → "../etc/passwd"; stripping a leading "../"
  // would incorrectly accept "etc/passwd" inside the archive.
  const segments = relPath.split(/[/\\]/);
  if (segments.some((s) => s === "..")) {
    throw new EvidenceAccessError("path escapes archive root", "denied");
  }
  if (relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) {
    throw new EvidenceAccessError("absolute or corrupt path denied", "denied");
  }
  const normalized = normalize(relPath);
  const abs = resolve(archiveRoot, normalized);
  const root = resolve(archiveRoot);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new EvidenceAccessError("path escapes archive root", "denied");
  }
  return abs;
}

/** Build a simple path→id catalog from relative paths. */
export function buildEvidenceCatalog(
  paths: Array<{ path: string; bytes: number }>,
): Map<string, EvidenceCatalogItem> {
  const out = new Map<string, EvidenceCatalogItem>();
  paths.forEach((p, i) => {
    const id = `ev_${String(i).padStart(4, "0")}`;
    out.set(id, { id, path: p.path, bytes: p.bytes });
  });
  return out;
}

/** Read a bounded slice of a catalogued evidence file. */
export async function readEvidence(
  archiveRoot: string,
  catalog: Map<string, EvidenceCatalogItem>,
  req: EvidenceReadRequest,
  opts?: { maxBytes?: number },
): Promise<EvidenceReadResult> {
  const item = catalog.get(req.catalogId);
  if (!item) throw new EvidenceAccessError(`unknown catalog id ${req.catalogId}`, "not_found");
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const offset = req.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new EvidenceAccessError("offset must be a non-negative integer", "range");
  }
  const length = Math.min(req.length ?? maxBytes, maxBytes);
  if (!Number.isInteger(length) || length < 0) {
    throw new EvidenceAccessError("length must be a non-negative integer", "range");
  }
  if (length > maxBytes) throw new EvidenceAccessError("per-call byte cap exceeded", "limit");

  const abs = resolveCatalogPath(archiveRoot, item.path);
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return {
      catalogId: item.id,
      path: item.path,
      offset,
      length: bytesRead,
      content: buf.subarray(0, bytesRead).toString("utf8"),
    };
  } finally {
    await fh.close();
  }
}

/** Convenience: read entire small file when under cap (still catalog-mediated). */
export async function readEvidenceFileUtf8(
  archiveRoot: string,
  relPath: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<string> {
  const abs = resolveCatalogPath(archiveRoot, relPath);
  const raw = await readFile(abs);
  if (raw.length > maxBytes) {
    throw new EvidenceAccessError("file exceeds maxBytes", "limit");
  }
  return raw.toString("utf8");
}
