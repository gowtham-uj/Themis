import type { EvalPackageUpload } from "../../src/evals/package.js";

/** Build a distinct valid suite-format eval package in the CURRENT platform schema. */
function codingPackage(input:{
  id:string;name:string;instruction:string;seedSource:string;seedTest:string;hiddenTest:string;
  solutionFiles:Record<string,string>;oraclePatch:string;badPatch:string;
}):EvalPackageUpload{
  const files:Record<string,string>={
    "instruction.md":input.instruction,
    "task.toml":`version = "1.0"
id = "${input.id}"
name = "${input.name}"
category = "simple_atomic"
primary_capability = "localized_bug_fix"
language = "javascript"
runtime = "node>=22"
difficulty = "medium"
official_reward = "binary"
internet = "disabled"
agent_timeout_seconds = 900
verifier_timeout_seconds = 120
cpu_cores = 2
memory_mb = 2048
disk_mb = 2048
public_test_command = "npm test"
`,
    "README.md":`# ${input.name}\n`,
    "seed_repo/package.json":"{\"name\":\""+input.id+"\",\"type\":\"module\",\"scripts\":{\"test\":\"node test.mjs\"}}",
    "seed_repo/src/value.js":input.seedSource,
    "seed_repo/test.mjs":input.seedTest,
    "environment/Dockerfile":"FROM node:24-bookworm-slim\nUSER root\nWORKDIR /workspace/task\nCOPY seed_repo/ /workspace/task/\nCOPY instruction.md /workspace/instruction.md\nUSER 10001\n",
    "environment/setup.sh":"#!/usr/bin/env bash\nset -euo pipefail\nDEST=\"${1:-/workspace/task}\"\nSEED=\"$(cd \"$(dirname \"$0\")/..\" && pwd)/seed_repo\"\nmkdir -p \"$DEST\"\ncp -a \"$SEED\"/. \"$DEST\"/\n",
    "environment/cleanup.sh":"#!/usr/bin/env bash\nset -euo pipefail\nrm -rf \"${1:-/workspace/task}\"\n",
    "environment/healthcheck.sh":"#!/usr/bin/env bash\nset -euo pipefail\ntest -f /workspace/task/src/value.js\n",
    "tests/Dockerfile":"FROM node:24-bookworm-slim\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*\nWORKDIR /verifier\nCOPY tests/ /verifier/\nRUN chmod +x /verifier/test.sh /verifier/verifier.py\nENTRYPOINT [\"/verifier/test.sh\"]\n",
    "tests/test.sh":"#!/usr/bin/env bash\nset -euo pipefail\npython3 \"$(dirname \"${BASH_SOURCE[0]}\")/verifier.py\" \"${1:-/workspace/task}\"\n",
    "tests/verifier.py":`import json,sys,subprocess
from pathlib import Path
sub=Path(sys.argv[1]).resolve()
def run(args,cwd):
    p=subprocess.run(args,cwd=cwd,text=True,capture_output=True)
    return p.returncode==0,p.stderr[-1000:]
pub,de=run(["node","test.mjs"],sub)
hid,hde=run(["node","/verifier/hidden.mjs",str(sub)],Path("/verifier"))
checks=[("public_tests",pub,de),("hidden_contract",hid,hde)]
reward=1 if all(c[1] for c in checks) else 0
print(json.dumps({"task_id":"${input.id}","reward":reward,"passed":reward==1,"checks":[{"name":n,"passed":b,"detail":d} for n,b,d in checks]}))
`,
    "tests/hidden.mjs":input.hiddenTest,
    "solution/solve.sh":"#!/usr/bin/env bash\nset -euo pipefail\ncp -a \"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/..\" && pwd)/solution/reference_files\"/. \"${1:-/workspace/task}\"/\n",
    "solution/reference.patch":input.oraclePatch,
    ...Object.fromEntries(Object.entries(input.solutionFiles).map(([k,v])=>[`solution/reference_files/${k}`,v])),
    "validation/expected.json":"{\"no_op_reward\":0,\"oracle_reward\":1,\"known_bad_reward\":0}",
    "validation/known_bad.patch":input.badPatch,
    "validation/known_bad/package.json":"{\"name\":\""+input.id+"\",\"type\":\"module\"}",
  };
  return {files};
}

/** Eval 1: repair addition and pass hidden edge cases. */
export function pipelineEvalOne():EvalPackageUpload{return codingPackage({
  id:"PIPELINE-ADD",name:"Repair addition and verify edge cases",
  instruction:"Fix /workspace/task/src/value.js so add(a,b) returns the numeric sum for positive, negative, zero, decimal and mixed-sign inputs. Preserve the named export and two-argument interface. Make the smallest general change and run npm test before claiming success.",
  seedSource:"export function add(a, b) { return a - b; }\n",
  seedTest:"import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from './src/value.js';\ntest('pos',()=>assert.equal(add(2,3),5));\ntest('neg',()=>assert.equal(add(-2,-3),-5));\ntest('zero',()=>assert.equal(add(0,7),7));\n",
  hiddenTest:"import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url'; import { join } from 'node:path';\nconst sub=process.argv[2];\nconst mod=await import(pathToFileURL(join(sub,'src/value.js')).href+'?v='+Date.now());\nassert.equal(typeof mod.add,'function'); assert.equal(mod.add.length,2);\nassert.equal(mod.add(1.5,2.25),3.75); assert.equal(mod.add(-7,3),-4); assert.equal(mod.add(0,0),0);\nconsole.log('hidden ok');\n",
  solutionFiles:{"src/value.js":"export function add(a, b) { return a + b; }\n"},
  oraclePatch:"--- a/src/value.js\n+++ b/src/value.js\n@@\n-return a - b\n+return a + b\n",
  badPatch:"--- a/src/value.js\n+++ b/src/value.js\n@@\n-return a - b\n+return 5\n",
})}

/** Eval 2: repair slugify without hard-coding examples. */
export function pipelineEvalTwo():EvalPackageUpload{return codingPackage({
  id:"PIPELINE-SLUG",name:"Repair slugify without breaking punctuation",
  instruction:"Fix /workspace/task/src/value.js so slugify(value) trims input, lowercases it, removes punctuation, collapses whitespace and repeated separators into one hyphen, and removes leading/trailing hyphens. Preserve the named one-argument export. Do not hard-code examples. Run npm test before claiming success.",
  seedSource:"export function slugify(value) { return value.trim().replace(/\\s+/g, '_'); }\n",
  seedTest:"import test from 'node:test'; import assert from 'node:assert/strict'; import { slugify } from './src/value.js';\ntest('spaces',()=>assert.equal(slugify('Hello World'),'hello-world'));\ntest('punct',()=>assert.equal(slugify(' API, Design! '),'api-design'));\ntest('rep',()=>assert.equal(slugify('a---b   c'),'a-b-c'));\n",
  hiddenTest:"import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url'; import { join } from 'node:path';\nconst sub=process.argv[2];\nconst mod=await import(pathToFileURL(join(sub,'src/value.js')).href+'?v='+Date.now());\nassert.equal(typeof mod.slugify,'function'); assert.equal(mod.slugify.length,1);\nassert.equal(mod.slugify(' --Hello,,, WORLD-- '),'hello-world'); assert.equal(mod.slugify('one___two'),'one-two'); assert.equal(mod.slugify('  Already-clean  '),'already-clean');\nconsole.log('hidden ok');\n",
  solutionFiles:{"src/value.js":"export function slugify(value){return value.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');}\n"},
  oraclePatch:"--- a/src/value.js\n+++ b/src/value.js\n@@\n-return value.trim().replace(/\\s+/g, '_');\n+return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n",
  badPatch:"--- a/src/value.js\n+++ b/src/value.js\n@@\n-return value.trim().replace(/\\s+/g, '_');\n+return value === 'Hello World' ? 'hello-world' : value;\n",
})}
