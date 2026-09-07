/**
 * Drive a complete run through the console the way an operator would: create a
 * project, set its agent model, copy evals from the store, pick the built-in
 * ReaperCode agent, start the run, watch the run panel, pause it, resume it,
 * and screenshot every step.
 *
 * It clicks the console; it does not call the API to make state. The API is
 * read only here, and only to resolve the ids the URLs need.
 *
 * Usage:
 *   CHROME_BIN=/path/to/chrome node scripts/browser-e2e.mjs \
 *     --base http://127.0.0.1:5173 --api http://127.0.0.1:8080 --out /tmp/e2e-shots
 */
import { mkdir, stat } from "node:fs/promises";
import { chromium } from "playwright-core";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg("base", "http://127.0.0.1:5173").replace(/\/+$/, "");
const api = arg("api", "http://127.0.0.1:8080").replace(/\/+$/, "");
const outDir = arg("out", "/tmp/e2e-shots");
const projectName = arg("name", `Browser E2E ${new Date().toISOString().slice(11, 19)}`);
const evalCount = Number(arg("evals", "2"));
const agent = arg("agent", "reapercode");
const providerBase = arg("provider-base", "https://api.deepinfra.com/v1/openai");
const model = arg("model", "zai-org/GLM-5.3-Flash");
const keyEnv = arg("key-env", "AGENTEVAL_MODEL_API_KEY");
const webKeyEnv = arg("web-key-env", "SERPER_SEARCH_API_KEY");
const reasoningEffort = arg("reasoning", "max");
const modelTimeoutMs = arg("model-timeout-ms", "900000");
// Minutes to watch the run panel before exercising pause/resume.
const watchMinutes = Number(arg("watch", "4"));
// Full runs can take hours. The browser stays on the real run panel until the
// generation completes or reaches a terminal failure.
const maxMinutes = Number(arg("max-minutes", "720"));

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

let step = 0;
async function shot(label) {
  step += 1;
  const name = `${String(step).padStart(2, "0")}-${label}`;
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
  console.log(`shot ${name}.png`);
}

async function json(path) {
  const res = await fetch(`${api}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function clickTab(name) {
  await page.getByRole("tab", { name, exact: true }).click();
  await page.waitForTimeout(300);
}

async function configureStage(stage, tabName) {
  await clickTab(tabName);
  await page.locator(`#${stage}-url`).fill(providerBase);
  await page.locator(`#${stage}-keyenv`).fill(keyEnv);
  if (stage !== "eval") await page.locator(`#${stage}-web-keyenv`).fill(webKeyEnv);
  await page.locator(`#${stage}-model`).fill(model);
  await page.locator(`#${stage}-effort`).fill(reasoningEffort);
  await page.locator(`#${stage}-timeout`).fill(modelTimeoutMs);
}

// 1. Projects list, empty.
await page.goto(`${base}/projects`, { waitUntil: "networkidle" });
await shot("projects-empty");

// 2. Create the project through the form.
await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
await page.locator('input[name="name"]').fill(projectName);
await page.getByRole("button", { name: /^Create$/ }).click();
await page.waitForTimeout(1500);
await shot("project-created");

const { projects } = await json("/api/projects");
const project = projects.find((p) => p.name === projectName);
if (!project) throw new Error("project row never appeared in the API");
const projectId = project.id;
console.log("project", projectId);

// 3. Open it.
await page.goto(`${base}/projects/${projectId}`, { waitUntil: "networkidle" });
await shot("project-overview");

// 4. Configure the project through the console. Suite evals use allowlist with
//    0.0.0.0/0, so traffic stays filtered while the current suite allows full
//    egress. All three stages use the same real OpenAI-compatible provider.
await page.goto(`${base}/projects/${projectId}/settings`, { waitUntil: "networkidle" });
const networkField = page.locator(".field").filter({ hasText: /^Network/ });
await networkField.locator("select").selectOption("allowlist");
await page.getByRole("button", { name: "Save", exact: true }).first().click();
await page.waitForTimeout(1200);
await shot("settings-agent");

await clickTab("Models");
await configureStage("eval", "Agent");
const modelFlagField = page.locator(".field").filter({ hasText: /^Model flag/ });
await modelFlagField.locator("input").fill(model);
await configureStage("phase1", "Judge");
await configureStage("phase2", "Across");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.waitForTimeout(1600);
await shot("settings-models");

// Prove the saved configuration can reach the provider before queue creation.
await clickTab("Agent");
await page.getByRole("button", { name: "Health check", exact: true }).click();
await page.getByText(/Reached .* in .*ms|failure(?: \(HTTP|:)/i).first().waitFor({ timeout: 120_000 });
await shot("settings-health");

// 5. Eval store, and copy evals into the project.
await page.goto(`${base}/eval-store`, { waitUntil: "networkidle" });
await shot("eval-store");

const copyButtons = page.getByRole("button", { name: "Copy to project" });
const copyCount = await copyButtons.count();
console.log("store copy buttons", copyCount);
for (let i = 0; i < Math.min(evalCount, copyCount); i += 1) {
  await copyButtons.nth(i).click();
  const dialog = page.getByRole("dialog", { name: /^Copy .* to a project$/ });
  await dialog.waitFor({ state: "visible" });
  await dialog.locator("select").selectOption({ label: projectName });
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 120_000 });
}
await shot("eval-store-copied");

// 6. Project evals.
await page.goto(`${base}/projects/${projectId}/evals`, { waitUntil: "networkidle" });
await shot("project-evals");

// 7. Queue: pick the agent, add items, then start.
await page.goto(`${base}/projects/${projectId}/queue`, { waitUntil: "networkidle" });
await shot("queue-empty");

const agentSelect = page.getByLabel("Built-in agent");
if (await agentSelect.count()) {
  await agentSelect.selectOption(agent);
  await page.waitForTimeout(1200);
  console.log("built-in agent set to", agent);
} else {
  console.log("no built-in agent selector; the project has its own adapter");
}
await shot("queue-agent");

const addButtons = page.getByRole("button", { name: "Add to queue" });
const addCount = await addButtons.count();
console.log("queue add buttons", addCount);
for (let i = 0; i < Math.min(evalCount, addCount); i += 1) {
  await addButtons.nth(0).click();
  await page.waitForTimeout(900);
}
await page.reload({ waitUntil: "networkidle" });
const acrossRow = page.locator(".stage-row").filter({ hasText: "Look across evals" });
const acrossCheck = acrossRow.locator('input[type="checkbox"]');
if (!(await acrossCheck.isChecked())) {
  await acrossCheck.check();
  await page.waitForTimeout(1000);
}
await shot("queue-loaded");

await page.locator("#run-name").fill(`E2E ${new Date().toISOString().slice(11, 16)}`);
await page.getByRole("button", { name: /Start run|Finish starting run/ }).first().click();
await page.waitForTimeout(6000);
await shot("queue-started");

// 8. Run panel: watch real progress rather than one frozen frame.
const runs = await json(`/api/projects/${projectId}/pipeline/runs`).catch(() => ({ runs: [] }));
const generationId = (runs.runs ?? []).at(0)?.id ?? null;
if (!generationId) throw new Error("the pipeline generation never appeared");
console.log("generation", generationId);
await page.goto(`${base}/projects/${projectId}/runs/${generationId}`, { waitUntil: "networkidle" });
await shot("run-panel-early");
for (let m = 1; m <= watchMinutes; m += 1) {
  await page.waitForTimeout(60_000);
  await shot(`run-panel-min${m}`);
}

async function exerciseStageControl(rowText, label) {
  await page.goto(`${base}/projects/${projectId}/queue`, { waitUntil: "networkidle" });
  const row = page.locator(".stage-row").filter({ hasText: rowText });
  const pause = row.getByRole("button", { name: "Pause", exact: true });
  if (!(await pause.count()) || await pause.isDisabled()) {
    console.log(`${label} pause was not available`);
    return false;
  }
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
  await page.waitForTimeout(7000);
  await shot(`${label}-resumed`);
  await page.goto(`${base}/projects/${projectId}/runs/${generationId}`, { waitUntil: "networkidle" });
  await shot(`run-panel-${label}-resumed`);
  return true;
}

// 9. Pause and resume the live eval container first.
const evalPauseChecked = await exerciseStageControl("Run the agent", "eval");
if (!evalPauseChecked) throw new Error("the live eval stage could not be paused and resumed");

// 10. Stay on the browser run panel through Phase 1, Phase 2, final archive
//     resealing, and terminal completion. Exercise each PI stage while it is live.
let lastState = "";
let phase1PauseChecked = false;
let phase2PauseChecked = false;
let completed = false;
for (let minute = 0; minute <= maxMinutes; minute += 1) {
  const view = await json(`/api/projects/${projectId}/pipeline/generation/${generationId}`);
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
if (!phase1PauseChecked) throw new Error("Phase 1 completed without a verified pause/resume");
if (!phase2PauseChecked) throw new Error("Phase 2 completed without a verified pause/resume");

await page.goto(`${base}/projects/${projectId}/runs/${generationId}`, { waitUntil: "networkidle" });
await shot("run-completed");

// 11. Download the campaign handoff from the run panel.
const packButton = page.getByRole("button", { name: "Download developer pack", exact: true });
if (!(await packButton.count())) throw new Error("completed Phase 2 has no developer-pack download control");
const [packDownload] = await Promise.all([
  page.waitForEvent("download"),
  packButton.click(),
]);
const packPath = `${outDir}/developer-improvement-pack.zip`;
await packDownload.saveAs(packPath);
if ((await stat(packPath)).size === 0) throw new Error("developer pack download is empty");

// 12. Inspect the final archive catalog and every archive. API reads verify the
//     exact paths while the browser checks the catalog, identity, layer history,
//     collapsible tree, preview, and download flow a user sees.
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
console.log(JSON.stringify({
  projectId,
  generationId,
  archives: archives.length,
  phase1PauseChecked,
  phase2PauseChecked,
  consoleErrors,
}, null, 2));
await browser.close();
