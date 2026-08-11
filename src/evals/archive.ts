/** Quarantine reader for canonical eval ZIP and TAR archives. */

import { readFile } from "node:fs/promises";
import { list as listTar, type ReadEntry } from "tar";
import yauzl from "yauzl";
import type { EvalPackageUpload } from "./package.js";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 4096;

export type EvalArchiveFormat = "zip" | "tar" | "tar.gz";

/** Read archive entries without extracting them to the filesystem. */
export async function decodeEvalArchiveFile(
  archivePath: string,
  format: EvalArchiveFormat,
): Promise<EvalPackageUpload> {
  const archive = await readFile(archivePath);
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`eval archive exceeds ${MAX_ARCHIVE_BYTES} compressed bytes`);
  }
  const entries = format === "zip"
    ? await readZipEntries(archive)
    : await readTarEntries(archivePath, format === "tar.gz");
  const normalized = normalizeSingleRoot(entries);
  const files: EvalPackageUpload["files"] = {};
  for (const [path, content] of normalized) {
    files[path] = { encoding: "base64", content: content.toString("base64") };
  }
  return { files };
}

async function readZipEntries(archive: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error("unable to open ZIP archive"));
        return;
      }
      const files = new Map<string, Buffer>();
      let totalBytes = 0;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(files);
      });
      zip.on("entry", (entry) => {
        const name = entry.fileName.replaceAll("\\", "/");
        try {
          assertSafeArchivePath(name);
        } catch (error) {
          fail(error);
          return;
        }
        if (name.endsWith("/")) {
          zip.readEntry();
          return;
        }
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const fileType = unixMode & 0o170000;
        if (fileType === 0o120000) {
          fail(new Error(`eval ZIP contains a symlink: ${name}`));
          return;
        }
        if (fileType !== 0 && fileType !== 0o100000) {
          fail(new Error(`eval ZIP contains unsupported entry type ${fileType.toString(8)}: ${name}`));
          return;
        }
        if (files.size >= MAX_FILES) {
          fail(new Error(`eval archive exceeds ${MAX_FILES} files`));
          return;
        }
        if (entry.uncompressedSize > MAX_UNCOMPRESSED_BYTES - totalBytes) {
          fail(new Error(`eval archive exceeds ${MAX_UNCOMPRESSED_BYTES} uncompressed bytes`));
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            fail(streamErr ?? new Error(`unable to read ZIP entry ${name}`));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > entry.uncompressedSize || totalBytes + bytes > MAX_UNCOMPRESSED_BYTES) {
              stream.destroy(new Error(`ZIP entry exceeds declared or allowed size: ${name}`));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          stream.on("error", fail);
          stream.on("end", () => {
            if (files.has(name)) {
              fail(new Error(`eval ZIP contains duplicate path: ${name}`));
              return;
            }
            const content = Buffer.concat(chunks);
            totalBytes += content.length;
            files.set(name, content);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function readTarEntries(path: string, gzip: boolean): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const pending: Promise<void>[] = [];
  let totalBytes = 0;
  let terminalError: Error | null = null;
  await listTar({
    file: path,
    gzip,
    strict: true,
    preservePaths: false,
    onentry(entry: ReadEntry) {
      const name = entry.path.replaceAll("\\", "/");
      try {
        assertSafeArchivePath(name);
      } catch (error) {
        terminalError = error instanceof Error ? error : new Error(String(error));
        entry.resume();
        return;
      }
      if (entry.type === "Directory") {
        entry.resume();
        return;
      }
      if (!["File", "OldFile", "ContiguousFile"].includes(entry.type)) {
        terminalError = new Error(`eval TAR contains unsupported ${entry.type}: ${name}`);
        entry.resume();
        return;
      }
      if (files.size + pending.length >= MAX_FILES) {
        terminalError = new Error(`eval archive exceeds ${MAX_FILES} files`);
        entry.resume();
        return;
      }
      pending.push(new Promise<void>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        entry.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (totalBytes + bytes > MAX_UNCOMPRESSED_BYTES) {
            entry.destroy(new Error(`eval archive exceeds ${MAX_UNCOMPRESSED_BYTES} uncompressed bytes`));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        entry.on("error", reject);
        entry.on("end", () => {
          if (files.has(name)) {
            reject(new Error(`eval TAR contains duplicate path: ${name}`));
            return;
          }
          const content = Buffer.concat(chunks);
          totalBytes += content.length;
          files.set(name, content);
          resolve();
        });
      }));
    },
  });
  await Promise.all(pending);
  if (terminalError) throw terminalError;
  return files;
}

function assertSafeArchivePath(path: string): void {
  if (!path || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    throw new Error(`eval archive contains unsafe path: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`eval archive contains traversal path: ${path}`);
  }
}

function normalizeSingleRoot(entries: Map<string, Buffer>): Map<string, Buffer> {
  const names = [...entries.keys()].filter(Boolean);
  if (names.length === 0) throw new Error("eval archive contains no files");
  const roots = new Set(names.map((name) => name.split("/")[0]));
  const stripRoot = roots.size === 1 && !entries.has("instruction.md");
  const root = stripRoot ? [...roots][0]! : "";
  const normalized = new Map<string, Buffer>();
  for (const [rawPath, content] of entries) {
    const path = root && rawPath.startsWith(`${root}/`) ? rawPath.slice(root.length + 1) : rawPath;
    if (!path) continue;
    if (normalized.has(path)) throw new Error(`archive root normalization produced duplicate path: ${path}`);
    normalized.set(path, content);
  }
  return normalized;
}
