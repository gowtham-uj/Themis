/**
 * Capture the console screenshots used by README.md and docs/.
 *
 * Point it at a running console and API that already hold real data; it does
 * not create any. Chromium comes from playwright-core, resolved through
 * CHROME_BIN or the default download cache.
 *
 * Usage:
 *   CHROME_BIN=/path/to/chrome node scripts/capture-screenshots.mjs \
 *     --base http://127.0.0.1:5173 --out docs/images
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg("base", "http://127.0.0.1:5173").replace(/\/+$/, "");
const outDir = arg("out", "docs/images");
const api = arg("api", "http://127.0.0.1:8080").replace(/\/+$/, "");

async function json(path) {
  const res = await fetch(`${api}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/** Resolve the ids the flow screenshots need from live API data. */
async function resolveTargets() {
  const { projects } = await json("/api/projects");
  const project = projects[0];
  if (!project) throw new Error("no project: run a pipeline before capturing");
  const runs = await json(`/api/projects/${project.id}/pipeline/runs`).catch(() => ({ runs: [] }));
  const generation = (runs.runs ?? []).at(0);
  const archives = await json("/api/archives?limit=1").catch(() => ({ archives: [] }));
  const archive = (archives.archives ?? []).at(0);
  return { projectId: project.id, generationId: generation?.id ?? null, runId: archive?.run_id ?? archive?.runId ?? null };
}

const SHOTS = (t) => [
  ["01-projects", "/projects", "Projects list"],
  ["02-project", `/projects/${t.projectId}`, "Project overview and run history"],
  ["03-settings", `/projects/${t.projectId}/settings`, "Agent, model stages, and judge prompts"],
  ["04-evals", `/projects/${t.projectId}/evals`, "Project eval packages"],
  ["05-eval-store", "/eval-store", "Canonical eval store"],
  ["06-queue", `/projects/${t.projectId}/queue`, "Queue blueprint"],
  t.generationId && ["07-run-panel", `/projects/${t.projectId}/runs/${t.generationId}`, "Live run panel"],
  ["08-archives", "/archives", "Archive catalog"],
  t.runId && ["09-archive-detail", `/archives/${t.runId}`, "Archive tree and file viewer"],
  ["10-models", "/models", "Deployment model defaults"],
].filter(Boolean);

const targets = await resolveTargets();
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

for (const [name, path, label] of SHOTS(targets)) {
  await page.goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
  console.log(`${name}.png  ${label}`);
}

await browser.close();
