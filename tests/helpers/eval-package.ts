import type { EvalPackageUpload } from "../../src/evals/package.js";

/**
 * Build a valid suite-format eval package (the format the platform now accepts):
 * flat task.toml, seed_repo workspace, environment/{setup,cleanup,healthcheck},
 * separate verifier in tests/verifier.py, solution/ + validation/.
 */
export function validEvalPackageUpload(overrides: Record<string, string> = {}): EvalPackageUpload {
  const files: Record<string, string> = {
    "instruction.md":
      "Fix /workspace/task/src/value.js so value() returns 42. Do not change the public interface.",
    "task.toml": `version = "1.0"
id = "SIMPLE-TEST"
name = "value-42"
category = "simple_atomic"
primary_capability = "localized_bug_fix"
language = "javascript"
runtime = "node>=22"
difficulty = "easy"
official_reward = "binary"
internet = "disabled"
agent_timeout_seconds = 900
verifier_timeout_seconds = 120
cpu_cores = 2
memory_mb = 2048
disk_mb = 2048
public_test_command = "npm test"
`,
    "README.md": "# Return 42 eval\n",
    "seed_repo/package.json": "{\"name\":\"value42\",\"type\":\"module\",\"scripts\":{\"test\":\"node test.mjs\"}}",
    "seed_repo/src/value.js": "export function value() { return 41; }\n",
    "seed_repo/test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from './src/value.js'; test('value', () => assert.equal(value(), 42));\n",
    "environment/Dockerfile": "FROM node:24-bookworm-slim\nUSER root\nWORKDIR /workspace/task\nCOPY seed_repo/ /workspace/task/\nCOPY instruction.md /workspace/instruction.md\nUSER 10001\n",
    "environment/setup.sh": "#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p \"${1:-/workspace/task}\"\n",
    "environment/cleanup.sh": "#!/usr/bin/env bash\nset -euo pipefail\nrm -rf \"${1:-/workspace/task}\"\n",
    "environment/healthcheck.sh": "#!/usr/bin/env bash\nset -euo pipefail\ntest -f /workspace/task/src/value.js\n",
    "tests/Dockerfile": "FROM node:24-bookworm-slim\nWORKDIR /verifier\nCOPY tests/ /verifier/\nENTRYPOINT [\"/verifier/test.sh\"]\n",
    "tests/test.sh": "#!/usr/bin/env bash\nset -euo pipefail\npython3 \"$(dirname \"${BASH_SOURCE[0]}\")/verifier.py\" \"${1:-/workspace/task}\"\n",
    "tests/verifier.py": `import json,sys
from pathlib import Path
sub=Path(sys.argv[1]).resolve()
checks=[]
p=__import__("subprocess").run(["node","test.mjs"],cwd=sub,text=True,capture_output=True)
checks.append(("public_tests",p.returncode==0,p.stderr[-1000:]))
checks.append(("hidden_contract",True,""))
print(json.dumps({"task_id":"SIMPLE-TEST","reward":1 if all(c[1] for c in checks) else 0,"passed":all(c[1] for c in checks),"checks":[{"name":n,"passed":b,"detail":d} for n,b,d in checks]}))
`,
    "solution/solve.sh": "#!/usr/bin/env bash\nset -euo pipefail\ncp -a \"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/..\" && pwd)/solution/reference_files\"/. \"${1:-/workspace/task}\"/\n",
    "solution/reference.patch": "--- a/src/value.js\n+++ b/src/value.js\n@@\n-return 41\n+return 42\n",
    "solution/reference_files/package.json": "{\"name\":\"value42\",\"type\":\"module\"}",
    "validation/expected.json": "{\"no_op_reward\":0,\"oracle_reward\":1,\"known_bad_reward\":0}",
    "validation/known_bad.patch": "--- a/src/value.js\n+++ b/src/value.js\n@@\n-return 41\n+return 99\n",
    "validation/known_bad/package.json": "{\"name\":\"value42\",\"type\":\"module\"}",
    ...overrides,
  };
  return { files };
}
