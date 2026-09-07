# Research: Developer Brief — Remediation Guidance for agent zai-org/GLM-5.3-Flash (eval py-tx-ledger-peak-v2, reward 0)

## Summary
The agent lost the eval to one design flaw (no pending buffer → uncommitted ledger entries visible in `history()`) that its own verification pass could never catch, plus two process failures (a 43-call no-new-information read loop; mid-transaction visibility never tested). The brief below converts each CONFIRMED finding (a)–(d) into imperative, developer-usable remedies, with published backing where real sources were found.

## Findings

### Finding (a) — CORRECTNESS/high: `commit()` publishes nothing; uncommitted work leaks into `history()`

**Failure pattern (generalized):** Classic "observable-before-committed" defect: global mutable state is mutated eagerly during an in-flight transaction, and readers (and the published surface) cannot distinguish committed from speculation. This is the transaction-isolation class of bug: any task asking for begin/commit/rollback semantics over an append-only log fails if the agent mutates the durable structure in place instead of staging. Models implement rollback/truncation well (it passed) but under-engineer the *write path* (publish-on-success), because eager mutation makes the happy path trivially work and only defers the failure to reads that occur mid-operation.

**Concrete remedy:**
1. Add a single `self._pending: list[HistoryEntry]` buffer created lazily on `begin()`. All history-appending operations during an open transaction append to `_pending` (nested savepoints copy/alias the current `_pending` snapshot, so partial rollback truncates `_pending` to the savepoint mark).
2. `commit()` (and every nested `commit()`/`release()` that closes the outermost savepoint) does exactly one publish: `self._history.extend(self._pending); self._pending = None`. `rollback()` discards `_pending`. `history()` must return only `_history` — never `_pending`.
3. If you keep the savepoint-stack implementation, the invariant is: the outermost frame holds a "not yet published" marker; the bare pop is a bug, not an implementation detail. Publish-on-commit is the standard isolation contract — cf. TigerBeetle's stated guarantee that "a client session never observes uncommitted updates" [web:https://docs.tigerbeetle.com/single-page/].
4. **Contract-derived self-test that catches it:** for every explicit contract sentence of the form "X must never appear in Y while a transaction is open", write the read *inside* the transaction:
   ```python
   led.transfer(...)            # enters+commits internally or half of a manual tx
   led.begin(); led.transfer(a, b, 1)
   assert led.history() == baseline_snapshot  # mid-transaction read
   led.commit()
   assert led.history() == baseline_snapshot + [op]
   ```

**Expected impact:** Jointly with (c), would have flipped reward 0 → pass (yes).

### Finding (b) — PROCESS/high: 43 identical `file_view` calls on the same file window (~42 wasted requests, 241.9k/270k tokens)

**Failure pattern:** No-new-information repetition loop — the agent re-issued byte-identical tool calls (same file, same args, same truncated 51-of-97-line window) expecting the loop to eventually yield new information. The alternative tool (`file_scroll`) existed and worked (t44). This is the well-documented agentic-loop failure class in which a feedback path repeats LLM/tool invocations without progress [web:https://arxiv.org/html/2607.01641v1].

**Concrete remedy (operative policy):**
1. **Fingerprint every read call:** hash `(tool, arg1..argN)`. Keep the last N (e.g. 5) fingerprints in-context.
2. **Result-hash comparison:** also hash the rendered result. If the *result* hash is unchanged from the previous identical call, the call is guaranteed no-new-information — do not repeat it.
3. **Escalation rule:** after ≥2 identical (call,result) pairs, switching strategy is mandatory, not optional: (a) change the tool (scroll/paginate/grep for the specific target), (b) change the query window or argument, or (c) state in plain text what information you are looking for before the next read. After ≥3, stop re-reading and either act on what you have or ask a human.
4. **Never re-read to "re-check"** — state tracking of already-seen content is the fix; the agent breaking its own loop at t44 proves the escape hatch was available from t2, not t44. Operator-side mitigations that mirror this: call fingerprinting and identical-result detection [web:https://www.reddit.com/r/LLMDevs/comments/1v8z0ju/loop_detection_for_llm_agents_what_a_toolcall/]; treating same-tool-same-args-no-change as a loop signal [web:https://dev.to/aws/how-to-prevent-ai-agent-reasoning-loops-from-wasting-tokens-2652].

**Expected impact:** Alone: no (reward unchanged) — but cuts ~15% of run duration and ~similar tokens, which materially raises the odds the agent has budget for (c).

### Finding (c) — PROCESS/high: verification checks (t60–t62) never read `history()` mid-transaction; success declared on structurally insufficient coverage

**Failure pattern:** "Happy-path-adjacent" self-verification: the agent tested cross-cutting invariants (rollback truncation, op_id dedup, NoTransaction guards, balance invariant) but only invoked `history()` at states where the contract's visibility clause could not fail. The hidden test targeted the one explicit "must never" bullet, and no self-check mapped to it.

**Concrete remedy (contract-letter extraction method):**
1. Before writing verification checks, enumerate every normative sentence in the task contract: every "must never", "must", "only after", "while a transaction is open/open", "at any point".
2. Convert each sentence 1:1 into a check, and — critically — evaluate state-dependent clauses **at the state they constrain** ("while open" ⇒ read at open, not after close/rollback; "after rollback" ⇒ read after rollback). Aim for at least one check per clause; 5 checks for a 9-clause contract is a coverage deficit, not thoroughness.
3. Property-based framing of contract clauses into executable properties is a validated technique for surfacing exactly this class of miss ([web:https://arxiv.org/html/2506.18315v1] — PBT to validate program behavior against stated properties; [web:https://arxiv.org/html/2510.25297v1] — LLM-generated property tests as input-space invariants).
4. For nested/savepoint systems, include one two-level probe: outer-rollback must wipe *and* make unpublished inner work invisible (`history()` empty between `begin()` and any `commit()`).

**Expected impact:** Jointly with (a) implements/detects the leak before submission → flips reward 0 → pass (yes).

### Finding (d) — TOOLING/medium: four `__pycache__/*.pyc` binaries entered the archived diff

**Failure pattern:** Artifact bycatch: legitimate test execution produced untracked, un-ignored binary files that a diff-capture harness swept into the archived change set. Not integrity-relevant (ruling: integrity=clean) — a hygiene gap.

**Concrete remedy:**
1. Before finishing any task that ran code, inspect the change set for non-source files: `git status --porcelain` (piercing `.pyc`, `.log`, caches) — this agent issued zero git commands.
2. Fix once per environment: add `__pycache__/`, `*.pyc`, `.pytest_cache/`, `*.log` to `.gitignore`, then delete stray `__pycache__` directories before handoff. Commit only source + intentional artifacts.
3. Self-check one-liner: "would every file in this diff survive review as a *change I meant to make*?" If a file is a binary interpreter artifact, it excluded — not committed.

**Expected impact:** Alone: no (reward unchanged); keeps archives clean so reviewer signal is not diluted.

## Sources
- Kept: TigerBeetle docs (https://docs.tigerbeetle.com/single-page/) — authoritative statement of the never-observe-uncommitted-updates invariant the design fix implements.
- Kept: Infinite Agentic Loops in LLM Agents, arXiv (https://arxiv.org/html/2607.01641v1) — frames (b) as a named agentic failure class.
- Kept: r/LLMDevs tool-call fingerprint loop detection (https://www.reddit.com/r/LLMDevs/comments/1v8z0ju/loop_detection_for_llm_agents_what_a_toolcall/) — practitioner loop-break policy matching remedy (b).
- Kept: Prevent AI agent reasoning loops, AWS dev.to (https://dev.to/aws/how-to-prevent-ai-agent-reasoning-loops-from-wasting-tokens-2652) — corroboration for identical-call repetition signals.
- Kept: Property-Based Testing to Bridge LLM Code Generation, arXiv 2506.18315 (https://arxiv.org/html/2506.18315v1) — supports contract-derived property/self-test method in (c).
- Kept: Characteristics of LLM-Generated property-based tests, arXiv 2510.25297 (https://arxiv.org/html/2510.25297v1) — supports invariant-per-clause test generation.
- Dropped: openlayer.com blog, meritshot, nhimg, Oracle blogs — SEO/commentary redundancy; no unique content beyond kept refs.
- Dropped: ai-native.build — irrelevant serper noise from a malformed query.

## Gaps
- No primary research found specific to "diff-capture hygiene for agent artifacts" — remedy (d) is engineering practice, not research-backed; no invented citation used.
- I could not verify GLM-5.3-Flash-specific tool definitions (file_view/file_scroll); remedy (b) assumes generic read tools with pagination alternatives.

## Supervisor coordination
No decision or interview needed; brief returned as artifact. Note: the task's requested `write_to_yaml_template` (template 'developer-brief') tool is not available in this runtime; per instructions the complete brief is returned here, persisted to the authoritative path `/work/agenteval/research.md`. No changes to the minos ruling; official reward untouched.

## Acceptance contract (attested)
- Path honored: /work/agenteval/research.md written via write tool.
```
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete per-finding remedies with files/severity: ledger/core.py _pending buffer + history() publish-on-commit fix (CORRECTNESS/high); tests/test_ledger.py hidden.py:81 failing clause; repetition-loop policy for the 43-call file_view spam (PROCESS/high); contract-clause→self-check method for t60-t62 gap (PROCESS/high); __pycache__ diff hygiene (TOOLING/medium)"
    }
  ],
  "changedFiles": [
    "/work/agenteval/research.md"
  ],
  "commandsRun": [],
  "validationOutput": [],
  "residualRisks": [
    "Remedies for (b) and (d) are backed by practitioner sources only; (d) has no directly citable published technique",
    "write_to_yaml_template tool unavailable; brief delivered as research.md artifact instead of templated YAML"
  ],
  "noStagedFiles": true,
  "diffSummary": "Added research brief file only; no code changes",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "Official reward 0 and minos ruling (approach=narrow, integrity=clean, competence=3, reconciliation=consistent) untouched; brief builds remedies only on CONFIRMED findings (a)-(d)."
}
```