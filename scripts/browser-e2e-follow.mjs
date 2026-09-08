/*
 * Attach a real browser to a pipeline generation that was created through the
 * console. Exercise pause/resume in every live stage, watch through Phase 2,
 * then inspect and download the final archive views and developer pack.
 *
 * Usage:
 *   CHROME_BIN=/path/to/chrome node scripts/browser-e2e-follow.mjs \
 *     --project <id> --generation <id> --evals 10 --out /tmp/themis-release-e2e
 */
import { mkdir, stat } from "node:fs/promises";
import { chromium } from "playwright-core";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg("base", "http://127.0.0.1:5173").replace(/\/+$/, "");
const api = arg("api", "http://127.0.0.1:8080").replace(/\/+$/, "");
const outDir = arg("out", "/tmp/themis-release-e2e");
const projectId = arg("project", "");
const generationId = arg("generation", "");
const evalCount = Number(arg("evals", "10"));
const maxMinutes = Number(arg("max-minutes", "720"));
const evalPauseAlreadyChecked = arg("eval-pause-checked", "false") === "true";
const phase1PauseAlreadyChecked = arg("phase1-pause-checked", "false") === "true";
const phase2PauseAlreadyChecked = arg("phase2-pause-checked", "false") === "true";
if (!projectId || !generationId) throw new Error("--project and --generation are required");

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

let step = 20;
async function shot(label) {
  const name = `${String(step).padStart(2, "0")}-${label}`;
  step += 1;
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
  console.log(`shot ${name}.png`);
}

async function json(path) {
  let last;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const res = await fetch(`${api}${path}`);
      if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json();
    } catch (error) {
      last = error;
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw last;
}

async function generation() {
  return json(`/api/projects/${projectId}/pipeline/generation/${generationId}`);
}

async function exerciseStageControl(rowText, label) {
  const before = await generation();
  const activeBefore = (before.items ?? []).find((item) =>
    label === "eval" ? item.state === "eval_running" : item.state === "phase1_running",
  );
  const campaignBefore = before.campaign?.id ?? null;

  await page.goto(`${base}/projects/${projectId}/queue`, { waitUntil: "networkidle" });
  const row = page.locator(".stage-row").filter({ hasText: rowText });
  const pause = row.getByRole("button", { name: "Pause", exact: true });
  if (!(await pause.count()) || await pause.isDisabled()) return false;
  await pause.click();
  await page.waitForTimeout(5000);
  await shot(`${label}-paused`);
  await page.goto(`${base}/projects/${projectId}/runs/${generationId}`, { waitUntil: "networkidle" });
  await shot(`run-panel-${label}-paused`);

  await page.goto(`${base}/projects/${projectId}/queue`, { waitUntil: "networkidle" });
  const resumeRow = page.locator(".stage-row").filter({ hasText: rowText });
  const resume = resumeRow.getByRole("button", { name: "Resume", exact: true });
  if (!(await resume.count()) || await resume.isDisabled()) throw new Error(`${label} did not expose Resume after pause`);
  await resume.click();
  await page.waitForTimeout(8000);
  await shot(`${label}-resumed`);
  await page.goto(`${base}/projects/${projectId}/runs/${generationId}`, { waitUntil: "networkidle" });
  await shot(`run-panel-${label}-resumed`);

  const after = await generation();
  if (activeBefore) {
    const same = (after.items ?? []).find((item) => item.id === activeBefore.id);
    if (!same || (same.runId && activeBefore.runId && same.runId !== activeBefore.runId)) {
      throw new Error(`${label} resumed as different work instead of continuing the paused item`);
    }
  }
  if (campaignBefore && after.campaign?.id !== campaignBefore) {
    throw new Error("Phase 2 resume created a different campaign");
  }
  return true;
}

await page.goto(`${base}/projects/${projectId}/runs/${generationId}`, { waitUntil: "networkidle" });
await shot("attached-run-panel");

let evalPauseChecked = evalPauseAlreadyChecked;
let phase1PauseChecked = phase1PauseAlreadyChecked;
let phase2PauseChecked = phase2PauseAlreadyChecked;
let completed = false;
let lastState = "";

for (let minute = 0; minute <= maxMinutes; minute += 1) {
  const view = await generation();
  const state = view.generation?.state ?? "unknown";
  const itemStates = (view.items ?? []).map((item) => item.state);

  if (state !== lastState) {
    console.log("pipeline state", state, itemStates);
    lastState = state;
    await page.goto(`${base}/projects/${projectId}/runs/${generationId}`, { waitUntil: "networkidle" });
    await shot(`run-state-${state}`);
  } else if (minute > 0 && minute % 15 === 0) {
    await page.goto(`${base}/projects/${projectId}/runs/${generationId}`, { waitUntil: "networkidle" });
    await shot(`run-wait-${minute}m`);
  }

  if (state === "eval_running" && !evalPauseChecked) {
    evalPauseChecked = await exerciseStageControl("Run the agent", "eval");
  }
  if (state === "phase1_running" && !phase1PauseChecked) {
    await page.waitForTimeout(15_000);
    phase1PauseChecked = await exerciseStageControl("Judge each eval", "phase1");
  }
  if (state === "phase2_running" && !phase2PauseChecked) {
    await page.waitForTimeout(15_000);
    phase2PauseChecked = await exerciseStageControl("Look across evals", "phase2");
  }

  if (state === "completed") {
    if (itemStates.length !== evalCount || itemStates.some((s) => s !== "final_view_published")) {
      throw new Error(`pipeline completed with unexpected items: ${JSON.stringify(itemStates)}`);
    }
    completed = true;
    break;
  }
  if (["failed", "cancelled"].includes(state)) {
    throw new Error(`pipeline ended in ${state}: ${JSON.stringify(view.items)}`);
  }
  if (minute < maxMinutes) await page.waitForTimeout(60_000);
}

if (!completed) throw new Error(`pipeline did not finish within ${maxMinutes} minutes`);
if (!evalPauseChecked) throw new Error("eval stage completed without a verified pause/resume");
if (!phase1PauseChecked) throw new Error("Phase 1 completed without a verified pause/resume");
if (!phase2PauseChecked) throw new Error("Phase 2 completed without a verified pause/resume");

await page.goto(`${base}/projects/${projectId}/runs/${generationId}`, { waitUntil: "networkidle" });
await shot("run-completed");

const packButton = page.getByRole("button", { name: "Download developer pack", exact: true });
if (!(await packButton.count())) throw new Error("completed Phase 2 has no developer-pack download control");
const [packDownload] = await Promise.all([page.waitForEvent("download"), packButton.click()]);
const packPath = `${outDir}/developer-improvement-pack.zip`;
await packDownload.saveAs(packPath);
if ((await stat(packPath)).size === 0) throw new Error("developer pack download is empty");

await page.goto(`${base}/archives?pipeline_run_id=${generationId}`, { waitUntil: "networkidle" });
await shot("archives-final");
const archiveList = await json(`/api/archives?pipeline_run_id=${encodeURIComponent(generationId)}`);
const archives = archiveList.archives ?? [];
if (archives.length !== evalCount) throw new Error(`expected ${evalCount} archives, found ${archives.length}`);

for (let i = 0; i < archives.length; i += 1) {
  const archive = archives[i];
  const contents = await json(`/api/archives/${archive.runId}/contents`);
  const paths = (contents.files ?? []).map((file) => file.path);
  const layers = new Set(contents.layers ?? []);
  if (archive.phase?.sealed !== "phase2") throw new Error(`${archive.runId} is sealed at ${archive.phase?.sealed}`);
  for (const layer of ["judge", "phase1", "phase2"]) {
    if (!layers.has(layer)) throw new Error(`${archive.runId} is missing ${layer}/ from its layer history`);
  }
  if (!paths.includes("judge/evalJudge.yaml")) throw new Error(`${archive.runId} has no judge/evalJudge.yaml`);
  if (!paths.some((path) => path.startsWith("phase1/"))) throw new Error(`${archive.runId} has no phase1 artifacts`);
  if (!paths.some((path) => path.startsWith("phase2/"))) throw new Error(`${archive.runId} has no phase2 artifacts`);

  await page.goto(`${base}/archives/${archive.runId}`, { waitUntil: "networkidle" });
  await page.getByText("Phase 2 · phase2/", { exact: true }).waitFor();
  await page.getByText("Phase 1 · judge/ + phase1/", { exact: true }).waitFor();
  if (i === 0) {
    await shot("archive-detail-first");
    const phase2Folder = page.getByRole("button", { name: /^phase2\b/ }).first();
    if (!(await phase2Folder.count())) throw new Error("archive tree has no phase2 folder");
    await phase2Folder.click();
    await shot("archive-phase2-expanded");
    const [archiveDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download .tar.gz", exact: true }).click(),
    ]);
    const archivePath = `${outDir}/first-final-archive.tar.gz`;
    await archiveDownload.saveAs(archivePath);
    if ((await stat(archivePath)).size === 0) throw new Error("archive download is empty");
  }
  if (i === archives.length - 1) await shot("archive-detail-last");
}

if (consoleErrors.length > 0) throw new Error(`browser console errors: ${JSON.stringify(consoleErrors)}`);
console.log(JSON.stringify({ projectId, generationId, archives: archives.length, evalPauseChecked, phase1PauseChecked, phase2PauseChecked, consoleErrors }, null, 2));
await browser.close();
