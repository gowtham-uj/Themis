import type { EvalPackageUpload } from "../../src/evals/package.ts";

export function validEvalPackageUpload(overrides: Record<string, string> = {}): EvalPackageUpload {
  const files: Record<string, string> = {
    "instruction.md": "Update /workspace/src/value.js so exported value() returns 42. Do not change the public interface.",
    "task.toml": `[task]
id = "value-42"
version = 1
name = "Return 42"
category = "javascript-bugfix"
language = "javascript"
tags = ["javascript", "bugfix"]
profile = "bugfix"
agent_category = "coding"

[timeouts]
agent_seconds = 120
verifier_seconds = 120
build_seconds = 300

[resources]
cpu = 1
ram_mb = 512
disk_mb = 1024
gpu = 0

[network]
policy = "allow"

[artifacts]
allowlist = ["diff.patch", "verifier-results.json"]

[agent_env]
NODE_ENV = "test"

[verifier]
separate = true
dockerfile = "tests/Dockerfile"
command = ["/tests/test.sh"]
checks = [
  { id = "functional-value", kind = "functional" },
  { id = "hidden-edge", kind = "hidden_test" },
  { id = "regression-api", kind = "regression" }
]

[[requirements]]
id = "R1"
text = "Calling value() from /workspace/src/value.js must return 42."
checks = ["functional-value", "hidden-edge"]
critical = true

[[requirements]]
id = "R2"
text = "The exported interface in /workspace/src/value.js must remain compatible."
checks = ["regression-api"]
critical = true

[explanations]
difficulty = "Requires locating and repairing the implementation while preserving its interface."
reference_solution = "The reference changes only the return value implementation."
verification = "An isolated verifier runs functional, hidden edge, and regression checks."
expert_minutes = 5

[digests]
environment = "sha256:environment-placeholder"
verifier = "sha256:verifier-placeholder"
dependencies = "sha256:dependencies-placeholder"
`,
    "README.md": "# Return 42 eval\n",
    "environment/Dockerfile": "FROM ${AGENTEVAL_AGENT_IMAGE}\nUSER root\nRUN node --version\n",
    "environment/entrypoint.sh": "#!/bin/bash\nset -euo pipefail\nexec \"$@\"\n",
    "environment/healthcheck.sh": "#!/bin/bash\nset -euo pipefail\nnode --version >/dev/null\n",
    "environment/repo/package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n",
    "environment/repo/src/value.js": "export function value() { return 41; }\n",
    "solution/solve.sh": "#!/bin/bash\nset -euo pipefail\nprintf 'export function value() { return 42; }\\n' > /workspace/src/value.js\n",
    "solution/reference.patch": "--- a/src/value.js\n+++ b/src/value.js\n@@\n-return 41\n+return 42\n",
    "tests/Dockerfile": "FROM node:22-alpine\nCOPY . /tests\nRUN chmod +x /tests/test.sh\n",
    "tests/test.sh": "#!/bin/sh\nset -eu\nnode /tests/test_functional.js\n",
    "tests/test_functional.js": "import('/workspace/src/value.js').then(m => { if (m.value() !== 42) process.exit(1); });\n",
    "tests/test_regressions.js": "// hidden regression verifier\n",
    "tests/test_edge_cases.js": "// hidden edge verifier\n",
    "tests/fixtures/input.json": "{}\n",
    "tests/oracle/expected.json": "{\"value\":42}\n",
    "validation/known_bad_patches/returns-41.patch": "--- a/src/value.js\n+++ b/src/value.js\n",
    "validation/expected_results.json": "{\"oracle\":1,\"noop\":0}\n",
    "validation/flake_report.json": "{\"runs\":5,\"passes\":5,\"flake_rate\":0}\n",
    ...overrides,
  };
  return { files };
}
