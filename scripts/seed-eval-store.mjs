/**
 * Upload eval packages from a directory of package trees into the global eval
 * store, one POST /api/eval-store per package. Skips packages whose name is
 * already in the store, so re-running it is safe.
 *
 * Usage:
 *   node scripts/seed-eval-store.mjs --dir /work/peak-evals-backup --api http://127.0.0.1:8080
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = arg("dir", "/work/peak-evals-backup");
const api = arg("api", "http://127.0.0.1:8080").replace(/\/+$/, "");

const TEXT = /\.(toml|md|json|sh|py|c|h|ts|js|go|rs|txt|patch|yaml|yml|cfg|mk)$|Makefile|Dockerfile/;

async function walk(root, base = root, out = new Map()) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else if (entry.isFile()) {
      const rel = relative(base, full);
      if (rel.startsWith(".agenteval-package")) continue;
      const buf = await readFile(full);
      out.set(
        rel,
        TEXT.test(entry.name)
          ? { encoding: "utf8", content: buf.toString("utf8") }
          : { encoding: "base64", content: buf.toString("base64") },
      );
    }
  }
  return out;
}

const existing = new Set(
  (await (await fetch(`${api}/api/eval-store`)).json()).evals.map((e) => e.name),
);

for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const pkg = join(dir, entry.name);
  if (!(await stat(join(pkg, "task.toml")).catch(() => null))) {
    console.log(`skip ${entry.name}: no task.toml`);
    continue;
  }
  const toml = await readFile(join(pkg, "task.toml"), "utf8");
  const name = /^\s*name\s*=\s*"(.*)"\s*$/m.exec(toml)?.[1] ?? entry.name;
  if (existing.has(name)) {
    console.log(`skip ${name}: already in store`);
    continue;
  }
  const files = Object.fromEntries(await walk(pkg));
  const res = await fetch(`${api}/api/eval-store`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });
  const body = await res.text();
  console.log(res.status, name, res.ok ? JSON.parse(body).id : body.slice(0, 300));
}
