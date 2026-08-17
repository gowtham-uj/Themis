/**
 * Run artifacts: files the agent produced as evidence — screenshots of a page it
 * drove, exported data, generated reports.
 *
 * The canonical location is `<runDir>/workspace/outputs`, the same directory the
 * `outputs` diff kind hashes into a manifest (see diff-category.ts). Reusing it
 * means a browser/data/research run has exactly one place to write. Captured
 * output paths are recorded relative to that directory.
 *
 * This module is pure filesystem: no HTTP and no database access. Its inventory
 * feeds retention and immutable eval archives.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/** One artifact under a run's outputs dir. */
export interface RunArtifact {
  /** Path relative to the outputs dir, always with `/` separators. */
  path: string;
  sizeBytes: number;
  sha256: string;
  /** Best-effort content type from the extension. */
  contentType: string;
  /** True for image output types. */
  isImage: boolean;
  /** Last-modified time, ISO-8601. */
  modifiedAt: string;
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
};

const TEXT_TYPES: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  html: "text/html; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  yaml: "application/yaml; charset=utf-8",
  yml: "application/yaml; charset=utf-8",
  patch: "text/plain; charset=utf-8",
  diff: "text/plain; charset=utf-8",
};

const OTHER_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  webm: "video/webm",
  mp4: "video/mp4",
};

/** Lowercase extension without the dot, or "" when there is none. */
function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Best-effort content type for an artifact path. Unknown → octet-stream. */
export function artifactContentType(p: string): string {
  const ext = extOf(p);
  return (
    IMAGE_TYPES[ext] ??
    TEXT_TYPES[ext] ??
    OTHER_TYPES[ext] ??
    "application/octet-stream"
  );
}

/** True when an artifact path has a recognized image extension. */
export function isImageArtifact(p: string): boolean {
  return extOf(p) in IMAGE_TYPES;
}

/**
 * The outputs directory for a run — where the sandbox writes screenshots and
 * other generated outputs before the eval archive is sealed.
 */
export function artifactsDir(runDir: string): string {
  return join(runDir, "workspace", "outputs");
}

/** sha256 of a file, streamed (artifacts can be large screenshots/videos). */
function sha256File(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

/**
 * List every artifact a run produced, sorted by path for stable rendering.
 * A run with no outputs dir yields an empty list rather than an error — most
 * coding runs never write one.
 */
export async function listArtifacts(runDir: string): Promise<RunArtifact[]> {
  const root = resolve(artifactsDir(runDir));
  const files = await walk(root);
  const out: RunArtifact[] = [];
  for (const abs of files) {
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const rel = relative(root, abs).split(sep).join("/");
    out.push({
      path: rel,
      sizeBytes: st.size,
      sha256: await sha256File(abs),
      contentType: artifactContentType(rel),
      isImage: isImageArtifact(rel),
      modifiedAt: new Date(st.mtimeMs).toISOString(),
    });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
