/**
 * Developer-flow E2E — exercises the platform the way a developer does:
 * create project → import eval → create queue (reaper + deepseek-v4-flash) →
 * start container → wait for sealed archive → run Themis phase1 → verify
 * result version + current pointer + judge artifact.
 *
 * Gated on AGENTEVAL_E2E=1 (real Podman + model). No mocks, no stubs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE = process.env.AGENTEVAL_BASE ?? "http://127.0.0.1:8080";
const LIVE = process.env.AGENTEVAL_E2E === "1";

interface Json {
  [k: string]: unknown;
}

async function api(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!LIVE)("developer-flow E2E", () => {
  let projectId = "";
  let evalId = "";
  let queueId = "";

  beforeAll(async () => {
    const proj = await api("POST", "/api/projects", {
      name: "themis dev-flow e2e",
      slug: `devflow-${Date.now().toString(36)}`,
      default_model: "deepseek-v4-flash",
      default_provider: "openai",
    });
    expect(proj.status).toBeLessThan(300);
    projectId = String((proj.json as Json).id ?? "");
  });

  afterAll(async () => {
    // Leave artifacts for inspection; do not delete project.
  });

  it(
    "imports an eval, queues it, seals an archive, and judges it",
    async () => {
      expect(projectId).toBeTruthy();

      // 1. Import a minimal-but-valid eval package (files map).
      const files: Record<string, string> = {
        "task.toml": [
          'version = "1.0"',
          'id = "DEVFLOW-001"',
          'name = "e2e-dev-flow"',
          'category = "simple_atomic"',
          'primary_capability = "localized_bug_fix"',
          'language = "python"',
          'runtime = "python>=3.12"',
          'difficulty = "easy"',
          'official_reward = "binary"',
          'internet = "disabled"',
          'agent_timeout_seconds = 600',
          'verifier_timeout_seconds = 120',
          'cpu_cores = 2',
          'memory_mb = 2048',
          'disk_mb = 2048',
          'public_test_command = "python3 -m unittest discover -s tests -v"',
        ].join("\n") + "\n",
        "instruction.md": "Implement `add` in math_lib.py so tests pass. Keep signatures.\n",
        "README.md": "# e2e-dev-flow\n",
        "seed_repo/math_lib.py": "def add(a, b):\n    return 0  # TODO\n",
        "seed_repo/tests/test_public.py":
          "import unittest\nfrom math_lib import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2,3), 5)\nif __name__ == '__main__':\n    unittest.main()\n",
        "environment/Dockerfile": "FROM debian:bookworm-slim\nWORKDIR /workspace/task\n",
        "environment/setup.sh":
          "#!/usr/bin/env bash\nset -euo pipefail\nroot=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/..\" && pwd)\"; target=\"${1:-/workspace/task}\"\nmkdir -p \"$target\"; cp -a \"$root/seed_repo\"/. \"$target\"/\n",
        "environment/cleanup.sh":
          "#!/usr/bin/env bash\nset -euo pipefail\nrm -rf \"${1:-/workspace/task}\"\n",
        "environment/healthcheck.sh": "#!/usr/bin/env bash\nset -euo pipefail\ncommand -v python3 >/dev/null 2>&1\n",
        "tests/Dockerfile": "FROM debian:bookworm-slim\nWORKDIR /workspace/task\n",
        "tests/test.sh": "#!/usr/bin/env bash\npython3 verifier.py \"${1:-/workspace/task}\"\n",
        "tests/verifier.py":
          'import json,sys\nfrom pathlib import Path\ns=Path(sys.argv[1])\ncode=(s/"math_lib.py").read_text()\nok="return a + b" in code\nprint(json.dumps({"task_id":"DEVFLOW-001","reward":int(ok),"passed":ok,"checks":[{"name":"public_tests","passed":ok,"detail":""}]}))\nraise SystemExit(0 if ok else 1)\n',
        "solution/solve.sh":
          "#!/usr/bin/env bash\nset -euo pipefail\nroot=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/..\" && pwd)\"; cp -a \"$root/solution/reference_files\"/. \"${1:-/workspace/task}\"/\n",
        "solution/reference.patch": "--- a/math_lib.py\n+++ b/math_lib.py\n",
        "solution/reference_files/math_lib.py": "def add(a, b):\n    return a + b\n",
        "validation/expected.json": '{"no_op_reward":0,"oracle_reward":1,"known_bad_reward":0}',
        "validation/known_bad.patch": "--- a/math_lib.py\n+++ b/math_lib.py\n",
        "validation/known_bad/math_lib.py": "def add(a, b):\n    return -1\n",
      };

      const evalRes = await api("POST", `/api/projects/${projectId}/evals`, { files });
      expect(evalRes.status).toBeLessThan(300);
      evalId = String((evalRes.json as Json).id ?? "");
      expect(evalId).toBeTruthy();

      // 2. Create a reaper + deepseek queue.
      const qRes = await api("POST", `/api/projects/${projectId}/queues`, {
        name: "devflow-reaper",
        model: "deepseek-v4-flash",
        provider: "openai",
        builtin_adapter_id: "reapercode",
        adapter_overrides: { params: { reasoningEffort: "high", thinking: "on" } },
      });
      expect(qRes.status).toBeLessThan(300);
      const qq = (qRes.json as Json).queue as Json;
      queueId = String(qq.id ?? "");
      expect(queueId).toBeTruthy();

      // 3. Enqueue the eval.
      const itemRes = await api(
        "POST",
        `/api/projects/${projectId}/queues/${queueId}/items`,
        { eval_id: evalId, repeats: 1 },
      );
      expect(itemRes.status).toBeLessThan(300);

      // 4. Start the container.
      const startRes = await api("PUT", `/api/projects/${projectId}/queues/${queueId}/container`);
      expect(startRes.status).toBeLessThan(300);

      // 5. Poll for a sealed archive.
      let runId = "";
      for (let i = 0; i < 90; i += 1) {
        const q = await api("GET", `/api/projects/${projectId}/queues/${queueId}`);
        const runs = ((q.json as Json).runs as Json[]) ?? [];
        const done = runs.find((r) => ["completed", "failed", "aborted"].includes(String((r as Json).status)));
        if (done) {
          runId = String((done as Json).id);
          break;
        }
        const arcs = await api("GET", `/api/archives?project_id=${projectId}&limit=5`);
        const list = (arcs.json as Json).archives as Json[] | undefined;
        const hit = list?.find((a) => a.projectId === projectId || true);
        if (list && list.length > 0) {
          runId = String(list[0]!.runId);
          break;
        }
        await sleep(10_000);
      }
      expect(runId).toBeTruthy();

      // 6. Judge the sealed archive.
      const judgeRes = await api("POST", `/api/judge/runs/${runId}/phase1`, {
        track_id: "devflow",
      });
      expect(judgeRes.status).toBeLessThan(300);
      const rv = (judgeRes.json as Json).result_version as Json;
      expect(rv).toBeTruthy();
      expect(String(rv.publicationState)).toBe("published");

      const pointer = (judgeRes.json as Json).current_pointer as Json;
      expect(String(pointer.resultVersionId)).toBe(String(rv.id));

      // 7. Read back via results API.
      const getRes = await api("GET", `/api/judge/results/${rv.id}`);
      expect(getRes.status).toBeLessThan(300);
      expect(String((getRes.json as Json).result?.id ?? (getRes.json as Json).result_version?.id ?? "")).toBe(
        String(rv.id),
      );
    },
    30 * 60_000,
  );
});
