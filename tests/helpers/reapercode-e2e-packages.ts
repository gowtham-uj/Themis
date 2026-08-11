import type { EvalPackageUpload } from "../../src/evals/package.js";

interface CodingEvalInput {
  id: string;
  name: string;
  targetFile: string;
  instruction: string;
  source: string;
  visibleTest: string;
  hiddenAssertion: string;
  exportAssertion: string;
  patch: string;
  badPatch: string;
}

/** Build the canonical arithmetic package used by the real ReaperCode acceptance flow. */
export function evalOnePackage(): EvalPackageUpload {
  return codingEvalPackage({
    id: "repair-addition",
    name: "Repair addition and verify edge cases",
    targetFile: "src/math.js",
    instruction: `# Repair addition and verify edge cases

Fix \`/workspace/src/math.js\` so its exported \`add(a, b)\` function returns the numeric sum for positive, negative, zero, decimal, and mixed-sign inputs. Preserve the named export and its two-argument interface. Make the smallest general change, do not modify files outside \`/workspace/src/math.js\`, and run \`npm test\` after the final edit before claiming success.`,
    source: "export function add(a, b) { return a - b; }\n",
    visibleTest: `import test from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.js";
test("positive", () => assert.equal(add(2, 3), 5));
test("negative", () => assert.equal(add(-2, -3), -5));
test("zero", () => assert.equal(add(0, 7), 7));
`,
    hiddenAssertion: `const mod = await import(pathToFileURL(join(workspace, "src/math.js")).href + "?v=" + Date.now());
      assert.equal(mod.add(1.5, 2.25), 3.75);
      assert.equal(mod.add(-7, 3), -4);
      assert.equal(mod.add(0, 0), 0);`,
    exportAssertion: `assert.equal(typeof mod.add, "function");
      assert.equal(mod.add.length, 2);`,
    patch: `diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -1 +1 @@
-export function add(a, b) { return a - b; }
+export function add(a, b) { return a + b; }
`,
    badPatch: `diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -1 +1 @@
-export function add(a, b) { return a - b; }
+export function add(a, b) { return 5; }
`,
  });
}

/** Build the canonical string package used by the real ReaperCode acceptance flow. */
export function evalTwoPackage(): EvalPackageUpload {
  return codingEvalPackage({
    id: "repair-slugify",
    name: "Repair slugify without breaking punctuation behavior",
    targetFile: "src/slug.js",
    instruction: `# Repair slugify without breaking punctuation behavior

Fix \`/workspace/src/slug.js\` so the exported \`slugify(value)\` trims input, lowercases it, removes punctuation, collapses whitespace or repeated separators into one hyphen, and removes leading/trailing hyphens. Preserve the named one-argument export. Do not hard-code examples or modify files outside \`/workspace/src/slug.js\`. Run \`npm test\` after the final edit before claiming success.`,
    source: "export function slugify(value) { return value.trim().replace(/\\s+/g, '_'); }\n",
    visibleTest: `import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";
test("spaces", () => assert.equal(slugify("Hello World"), "hello-world"));
test("punctuation", () => assert.equal(slugify(" API, Design! "), "api-design"));
test("repeated separators", () => assert.equal(slugify("a---b   c"), "a-b-c"));
`,
    hiddenAssertion: `const mod = await import(pathToFileURL(join(workspace, "src/slug.js")).href + "?v=" + Date.now());
      assert.equal(mod.slugify(" --Hello,,, WORLD-- "), "hello-world");
      assert.equal(mod.slugify("one___two"), "one-two");
      assert.equal(mod.slugify("  Already-clean  "), "already-clean");`,
    exportAssertion: `assert.equal(typeof mod.slugify, "function");
      assert.equal(mod.slugify.length, 1);`,
    patch: `diff --git a/src/slug.js b/src/slug.js
--- a/src/slug.js
+++ b/src/slug.js
@@ -1 +1,5 @@
-export function slugify(value) { return value.trim().replace(/\\s+/g, '_'); }
+export function slugify(value) {
+  return value.trim().toLowerCase()
+    .replace(/[^a-z0-9]+/g, "-")
+    .replace(/^-+|-+$/g, "");
+}
`,
    badPatch: `diff --git a/src/slug.js b/src/slug.js
--- a/src/slug.js
+++ b/src/slug.js
@@ -1 +1 @@
-export function slugify(value) { return value.trim().replace(/\\s+/g, '_'); }
+export function slugify(value) { return value === "Hello World" ? "hello-world" : value; }
`,
  });
}

function codingEvalPackage(input: CodingEvalInput): EvalPackageUpload {
  const packageJson = `${JSON.stringify({
    name: input.id,
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`;
  const readme = `# ${input.name}\n\nRun the public tests with \`npm test\`.\n`;
  const testPath = `test/${input.id}.test.js`;
  return {
    files: {
      "instruction.md": `${input.instruction}\n`,
      "task.toml": taskToml(input),
      "README.md": `# ${input.id}\n\nCanonical API-only ReaperCode acceptance eval.\n`,
      "environment/Dockerfile": "FROM ${AGENTEVAL_AGENT_IMAGE}\nUSER root\nWORKDIR /workspace\n",
      "environment/entrypoint.sh": "#!/bin/bash\nset -euo pipefail\nexec \"$@\"\n",
      "environment/healthcheck.sh": "#!/bin/bash\nset -euo pipefail\nnode --version >/dev/null\n",
      "environment/setup.sh": "#!/bin/bash\nset -euo pipefail\ntest -n \"${AGENTEVAL_TRIAL_ID:-}\"\nprintf setup > \"/tmp/agenteval-${AGENTEVAL_TRIAL_ID}\"\n",
      "environment/cleanup.sh": "#!/bin/bash\nset -euo pipefail\ntest -n \"${AGENTEVAL_TRIAL_ID:-}\"\nrm -f \"/tmp/agenteval-${AGENTEVAL_TRIAL_ID}\"\ntest ! -e \"/tmp/agenteval-${AGENTEVAL_TRIAL_ID}\"\n",
      "environment/repo/package.json": packageJson,
      "environment/repo/README.md": readme,
      [`environment/repo/${input.targetFile}`]: input.source,
      [`environment/repo/${testPath}`]: input.visibleTest,
      "solution/reference.patch": input.patch,
      "solution/solve.sh": "#!/bin/bash\nset -euo pipefail\npatch -d /workspace -p1 < /solution/reference.patch\n",
      "tests/Dockerfile": "FROM node:22-alpine\nCOPY . /tests\nRUN chmod +x /tests/test.sh\n",
      "tests/test.sh": "#!/bin/sh\nset -eu\nnode /tests/run-checks.mjs\n",
      "tests/run-checks.mjs": verifierScript(input, packageJson, readme, testPath),
      "validation/known_bad_patches/hard-coded.patch": input.badPatch,
      "validation/expected_results.json": `${JSON.stringify({
        eval_id: input.id,
        version: 1,
        binary_reward: { oracle: 1, noop: 0, hard_coded: 0 },
      }, null, 2)}\n`,
      "validation/flake_report.json": `${JSON.stringify({
        eval_id: input.id,
        version: 1,
        status: "pending-live-acceptance",
        reference_oracle_runs: 0,
        note: "No pre-acceptance run is claimed; the API-only E2E performs the first real isolated-verifier run.",
      }, null, 2)}\n`,
    },
  };
}

function taskToml(input: Pick<CodingEvalInput, "id" | "name" | "targetFile">): string {
  return `[task]
id = "${input.id}"
version = 1
name = "${input.name}"
category = "reapercode-acceptance"
language = "javascript"
tags = ["javascript", "bugfix", "reapercode", "acceptance"]
profile = "bugfix"
agent_category = "coding"

[timeouts]
agent_seconds = 900
verifier_seconds = 300
build_seconds = 900

[resources]
cpu = 2
ram_mb = 2048
disk_mb = 4096
gpu = 0

[network]
policy = "allow"
allowlist = []

[artifacts]
allowlist = ["diff.patch", "verifier-results.json", "run-metrics.json", "evidence-integrity.json"]

[agent_env]
NODE_ENV = "test"

[verifier]
separate = true
dockerfile = "tests/Dockerfile"
command = ["/tests/test.sh"]
checks = [
  { id = "functional-public", kind = "functional" },
  { id = "hidden-edge", kind = "hidden_test" },
  { id = "regression-api", kind = "regression" },
  { id = "scope-integrity", kind = "security" }
]

[[requirements]]
id = "R1"
text = "The public tests for /workspace/${input.targetFile} must pass."
checks = ["functional-public"]
critical = true

[[requirements]]
id = "R2"
text = "Hidden edge cases for /workspace/${input.targetFile} must pass without hard-coding examples."
checks = ["hidden-edge"]
critical = true

[[requirements]]
id = "R3"
text = "The named export interface in /workspace/${input.targetFile} must remain compatible."
checks = ["regression-api"]
critical = true

[[requirements]]
id = "R4"
text = "Only /workspace/${input.targetFile} may change and protected verifier content must remain inaccessible."
checks = ["scope-integrity"]
critical = true

[lifecycle]
setup = "environment/setup.sh"
cleanup = "environment/cleanup.sh"
setup_timeout_seconds = 60
cleanup_timeout_seconds = 60

[explanations]
difficulty = "Requires a minimal general bug fix plus final verification."
reference_solution = "The reference changes only the target implementation."
verification = "A separate offline verifier runs public, hidden, API, and scope checks."
expert_minutes = 10

[digests]
environment = "sha256:acceptance-environment"
verifier = "sha256:acceptance-verifier"
dependencies = "sha256:no-external-dependencies"
`;
}

function verifierScript(
  input: Pick<CodingEvalInput, "id" | "targetFile" | "visibleTest" | "hiddenAssertion" | "exportAssertion">,
  packageJson: string,
  readme: string,
  testPath: string,
): string {
  const expectedFiles = JSON.stringify({
    "package.json": packageJson,
    "README.md": readme,
    [testPath]: input.visibleTest,
  });
  const expectedTarget = JSON.stringify(input.targetFile);
  return `import assert from "node:assert/strict";
import { readdir, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const workspace = process.env.AGENTEVAL_WORKSPACE ?? "/workspace";
const resultPath = process.env.AGENTEVAL_VERIFIER_RESULTS ?? "/workspace/.agenteval/verifier-results.json";
const checks = [];
async function check(id, kind, fn) {
  const started = Date.now();
  try {
    await fn();
    checks.push({ id, kind, status: "pass", duration_ms: Date.now() - started });
  } catch (error) {
    checks.push({ id, kind, status: "fail", duration_ms: Date.now() - started, detail: String(error?.stack ?? error) });
  }
}
await check("functional-public", "functional", async () => {
  const result = spawnSync("npm", ["test"], { cwd: workspace, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
await check("hidden-edge", "hidden_test", async () => {
  ${input.hiddenAssertion}
});
await check("regression-api", "regression", async () => {
  const mod = await import(pathToFileURL(join(workspace, ${expectedTarget})).href + "?api=" + Date.now());
  ${input.exportAssertion}
});
await check("scope-integrity", "security", async () => {
  const expected = ${expectedFiles};
  for (const [path, content] of Object.entries(expected)) {
    assert.equal(await readFile(join(workspace, path), "utf8"), content, path + " was modified");
  }
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // Agent-native harness bookkeeping (.reaper/.pi) is excluded the same way
      // the platform excludes it from diff.patch; it is not the agent's work product.
      if ([".git", ".agenteval", "node_modules", ".reaper", ".pi", ".agent"].includes(entry.name)) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(relative(workspace, absolute).replaceAll("\\\\", "/"));
    }
  }
  await walk(workspace);
  const allowed = new Set([...Object.keys(expected), ${expectedTarget}]);
  assert.deepEqual(files.filter((path) => !allowed.has(path)), []);
});
await mkdir(join(resultPath, ".."), { recursive: true });
const tmp = resultPath + ".tmp";
await writeFile(tmp, JSON.stringify({ checks }));
await rename(tmp, resultPath);
`;
}
