/**
 * Re-capture the README screenshots from the live console.
 *
 * Run with the API on :8080 and the built console on :5173 (`npm run preview`
 * inside `web/`). Every shot is a real page against real data; nothing here
 * seeds or mocks state.
 *
 *   node scripts/capture-docs-screenshots.mjs <projectId> <generationId> <runId>
 */
import { chromium } from "playwright-core";
import { join } from "node:path";

const [projectId, generationId, runId] = process.argv.slice(2);
if (!projectId || !generationId || !runId) {
  console.error("usage: capture-docs-screenshots.mjs <projectId> <generationId> <runId>");
  process.exit(2);
}

const BASE = process.env.THEMIS_CONSOLE ?? "http://127.0.0.1:5173";
const OUT = join(process.cwd(), "docs", "images");

const SHOTS = [
  { file: "01-projects.png", path: "/projects" },
  { file: "02-project.png", path: `/projects/${projectId}` },
  { file: "03-settings.png", path: `/projects/${projectId}/settings` },
  { file: "04-evals.png", path: `/projects/${projectId}/evals` },
  { file: "05-eval-store.png", path: "/eval-store" },
  { file: "06-queue.png", path: `/projects/${projectId}/queue` },
  { file: "07-run-panel.png", path: `/projects/${projectId}/runs/${generationId}` },
  { file: "08-archives.png", path: "/archives" },
  { file: "09-archive-detail.png", path: `/archives/${runId}` },
  { file: "10-models.png", path: "/models" },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

for (const shot of SHOTS) {
  await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle", timeout: 60_000 });
  // The console renders from react-query, so networkidle alone can catch a
  // skeleton. Wait until no loading placeholder is on screen.
  await page
    .waitForFunction(() => !/\bLoading\b|\bLoading…/.test(document.body.innerText), null, { timeout: 20_000 })
    .catch(() => problems.push(`${shot.file}: still showing a loading state`));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, shot.file), fullPage: true });
  const text = await page.evaluate(() => document.body.innerText);
  console.log(`${shot.file}  ${shot.path}  ${text.length} chars`);
  for (const bad of ["undefined", "NaN", "[object Object]"]) {
    if (text.includes(bad)) problems.push(`${shot.file}: page text contains ${bad}`);
  }
}

await browser.close();
if (problems.length) {
  console.error("\nproblems:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("\nall shots clean");
