/** Platform-owned per-eval metrics derived only from canonical evidence. */

import type { CanonicalEvent, RunStatus } from "../schema/events.js";

export const RUN_METRICS_SCHEMA_VERSION = 1 as const;

export type MetricProvenance = "exact" | "derived" | "unknown";
export interface MetricRef {
  kind: "trace" | "diff" | "artifact";
  runId?: string;
  seqs?: [number, number];
  file?: string;
  hunk?: number;
  path?: string;
}

export interface MetricMeasurement {
  value: number | boolean | null;
  unit: string;
  provenance: MetricProvenance;
  refs: MetricRef[];
  note?: string;
}

export interface RunMetrics {
  schemaVersion: typeof RUN_METRICS_SCHEMA_VERSION;
  eventCount: number;
  toolCallCount: number;
  toolResultCount: number;
  messageCount: number;
  duplicateFullMessageCount: number;
  mutationCount: number;
  verificationCount: number;
  ambiguousActionCount: number;
  lastMutationSeq: number | null;
  lastVerificationSeq: number | null;
  verificationAfterLastMutation: boolean | null;
  verifiedCompletion: boolean;
  terminalStatus: RunStatus | null;
  measurements: Record<string, MetricMeasurement>;
}

export interface DeriveRunMetricsOptions {
  diffText?: string;
  totalCost?: number | null;
  /**
   * The verifier's authoritative official reward (0|1), when known. When present,
   * `false_success` is classified against it (the agent claiming success that
   * the verifier did not confirm) instead of fragile shell-command heuristics — the
   * independent verifier is the ground truth for "did it actually pass".
   */
  officialReward?: number | null;
}

const MUTATION_TOOLS = new Set([
  "edit", "write", "multiedit", "apply_patch", "applypatch", "notebookedit",
  "create_file", "delete_file", "write_file", "edit_file",
]);
const READ_TOOLS = new Set(["read", "read_file", "open", "view", "notebookread"]);
const VERIFICATION_TOOLS = new Set(["test", "verify", "check", "build", "lint", "typecheck"]);
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "run_command", "terminal"]);

interface PendingAction {
  kind: "test" | "compile" | "other";
  seq: number;
}

/** Derive reproducible run facts without trusting adapter-native summaries. */
export function deriveRunMetrics(
  events: readonly CanonicalEvent[],
  options: DeriveRunMetricsOptions = {},
): RunMetrics {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const runId = ordered[0]?.runId ?? "unknown";
  const mutationSeqs: number[] = [];
  const verificationSeqs: number[] = [];
  const fullMessages = new Set<string>();
  const filesOpened = new Map<string, number>();
  const filesModified = new Set<string>();
  const pending = new Map<string, PendingAction>();
  let duplicateFullMessageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let messageCount = 0;
  let commandCount = 0;
  let ambiguousActionCount = 0;
  let terminalStatus: RunStatus | null = null;
  let wallClockMs: number | null = null;
  let testAttempts = 0;
  let failedTests = 0;
  let recoveredTests = 0;
  let awaitingTestRecovery = false;
  let compileAttempts = 0;
  let compileErrors = 0;
  let recoveredCompileErrors = 0;
  let awaitingCompileRecovery = false;
  let stallLoops = 0;
  let previousSignature: string | null = null;
  let repeatedSignatureCount = 0;
  let totalTokens = 0;
  let sawRunUsageTotal = false;
  let lastMessage = "";

  for (const event of ordered) {
    if (event.type === "message") {
      messageCount += 1;
      lastMessage = event.text;
      if (event.mode === "full") {
        const key = `${event.turn}\0${event.text}`;
        if (fullMessages.has(key)) duplicateFullMessageCount += 1;
        else fullMessages.add(key);
      }
      continue;
    }
    if (event.type === "usage") {
      if (!sawRunUsageTotal) totalTokens += event.totalTokens ?? event.inputTokens + event.outputTokens;
      continue;
    }
    if (event.type === "run.end") {
      terminalStatus = event.status;
      wallClockMs = event.durationMs;
      if (event.usageTotal) {
        totalTokens = event.usageTotal.totalTokens ??
          event.usageTotal.inputTokens + event.usageTotal.outputTokens +
          (event.usageTotal.reasoningTokens ?? 0) +
          (event.usageTotal.cacheReadTokens ?? 0) +
          (event.usageTotal.cacheWriteTokens ?? 0);
        sawRunUsageTotal = true;
      }
      continue;
    }
    if (event.type === "tool.result") {
      toolResultCount += 1;
      const action = pending.get(event.id);
      if (!action) continue;
      const failed = event.isError || outputLooksFailed(event.output);
      if (action.kind === "test") {
        if (failed) {
          failedTests += 1;
          awaitingTestRecovery = true;
        } else if (awaitingTestRecovery) {
          recoveredTests += 1;
          awaitingTestRecovery = false;
        }
      } else if (action.kind === "compile") {
        if (failed) {
          compileErrors += 1;
          awaitingCompileRecovery = true;
        } else if (awaitingCompileRecovery) {
          recoveredCompileErrors += 1;
          awaitingCompileRecovery = false;
        }
      }
      continue;
    }
    if (event.type === "exec") {
      if (event.actor === "operator") continue;
      commandCount += 1;
      const command = event.argv.join(" ");
      const classification = classifyCommand(command);
      if (classification === "mutation") mutationSeqs.push(event.seq);
      else if (classification === "verification") verificationSeqs.push(event.seq);
      else if (classification === "ambiguous") ambiguousActionCount += 1;
      if (isTestCommand(command)) testAttempts += 1;
      if (isCompileCommand(command)) compileAttempts += 1;
      continue;
    }
    if (event.type !== "tool.call") continue;

    toolCallCount += 1;
    const name = event.name.toLowerCase();
    const command = SHELL_TOOLS.has(name) ? commandFromArgs(event.args) : "";
    const file = pathFromArgs(event.args);
    if (READ_TOOLS.has(name) && file) filesOpened.set(file, (filesOpened.get(file) ?? 0) + 1);
    if (MUTATION_TOOLS.has(name)) {
      mutationSeqs.push(event.seq);
      if (file) filesModified.add(file);
    } else if (VERIFICATION_TOOLS.has(name)) {
      verificationSeqs.push(event.seq);
    } else if (SHELL_TOOLS.has(name)) {
      commandCount += 1;
      const classification = classifyCommand(command);
      if (classification === "mutation") mutationSeqs.push(event.seq);
      else if (classification === "verification") verificationSeqs.push(event.seq);
      else if (classification === "ambiguous") ambiguousActionCount += 1;
    }

    const actionKind = isTestTool(name, command)
      ? "test"
      : isCompileTool(name, command)
        ? "compile"
        : "other";
    if (actionKind === "test") testAttempts += 1;
    if (actionKind === "compile") compileAttempts += 1;
    pending.set(event.id, { kind: actionKind, seq: event.seq });

    const signature = `${name}:${stableArgs(event.args)}`;
    if (signature === previousSignature) {
      repeatedSignatureCount += 1;
      if (repeatedSignatureCount >= 2) stallLoops += 1;
    } else {
      previousSignature = signature;
      repeatedSignatureCount = 0;
    }
  }

  const lastMutationSeq = mutationSeqs.at(-1) ?? null;
  const lastVerificationSeq = verificationSeqs.at(-1) ?? null;
  const verificationAfterLastMutation =
    lastMutationSeq === null
      ? null
      : lastVerificationSeq !== null && lastVerificationSeq > lastMutationSeq;
  const repeatedFileReads = [...filesOpened.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const patch = patchStats(options.diffText);
  const editChurn = mutationSeqs.length === 0
    ? 0
    : Math.max(0, mutationSeqs.length - filesModified.size) / mutationSeqs.length;
  const successClaim = /\b(done|complete[sd]?|fixed|pass(?:ed)?|success)\b/i.test(lastMessage);
  // When the verifier's authoritative reward is known, judge false_success against
  // it (the agent claimed success the verifier did NOT confirm) instead of fragile
  // shell-command heuristics — the independent verifier is ground truth. Without a
  // verifier reward, fall back to the verification-ordering heuristic.
  const falseSuccess =
    options.officialReward == null
      ? successClaim && terminalStatus === "completed" && verificationAfterLastMutation !== true
      : successClaim && terminalStatus === "completed" && options.officialReward !== 1;
  const traceRange = (start: number | null, end: number | null): MetricRef[] =>
    start === null || end === null ? [] : [{ kind: "trace", runId, seqs: [start, end] }];

  const measurements: Record<string, MetricMeasurement> = {
    tokens_used: exact(totalTokens, "tokens", traceRange(0, ordered.at(-1)?.seq ?? null)),
    cost_usd: options.totalCost == null
      ? unknown("usd", "Provider cost was not available on the finalized run.")
      : exact(options.totalCost, "usd", []),
    wall_clock_ms: wallClockMs === null ? unknown("ms", "No canonical run.end duration.") : exact(wallClockMs, "ms", []),
    tool_calls: exact(toolCallCount, "calls", []),
    files_opened: exact(filesOpened.size, "files", []),
    files_modified: exact(filesModified.size, "files", []),
    commands_executed: exact(commandCount, "commands", []),
    test_attempts: exact(testAttempts, "attempts", []),
    failed_test_recovery_rate: failedTests === 0
      ? unknown("ratio", "No failed test attempt required recovery.")
      : derived(recoveredTests / failedTests, "ratio", []),
    compile_error_recovery_rate: compileErrors === 0
      ? unknown("ratio", "No observed compile error required recovery.")
      : derived(recoveredCompileErrors / compileErrors, "ratio", []),
    context_tokens_used: exact(totalTokens, "tokens", []),
    context_discarded: unknown("tokens", "Canonical events do not yet expose discarded-context token counts."),
    repeated_file_reads: exact(repeatedFileReads, "reads", []),
    patch_bytes: options.diffText === undefined ? unknown("bytes", "No source patch for this eval category.") : exact(patch.bytes, "bytes", []),
    patch_added_lines: options.diffText === undefined ? unknown("lines", "No source patch for this eval category.") : exact(patch.added, "lines", []),
    patch_removed_lines: options.diffText === undefined ? unknown("lines", "No source patch for this eval category.") : exact(patch.removed, "lines", []),
    edit_churn: derived(editChurn, "ratio", traceRange(mutationSeqs[0] ?? null, lastMutationSeq)),
    agent_crashes: exact(terminalStatus === "failed" ? 1 : 0, "count", []),
    timeouts: exact(terminalStatus === "timeout" ? 1 : 0, "count", []),
    stalls_or_loops: derived(stallLoops, "count", []),
    verification_rate: lastMutationSeq === null
      ? unknown("ratio", "No recognized mutation made verification-after-mutation inapplicable.")
      : derived(verificationAfterLastMutation === true ? 1 : 0, "ratio", traceRange(lastMutationSeq, lastVerificationSeq ?? lastMutationSeq)),
    false_success: derived(falseSuccess, "boolean", []),
    planner_accuracy: unknown("ratio", "Requires evidence-linked judgement against the executed plan."),
    localization_accuracy: unknown("ratio", "Requires expected target locations or evidence-linked judge attribution."),
    first_edit_accuracy: unknown("ratio", "Requires outcome attribution for the first mutation."),
    unnecessary_changes: unknown("count", "Requires diff/rubric judgement rather than event counting."),
    regressions_introduced: unknown("count", "Requires deterministic regression checks or cross-run judgement."),
  };

  return {
    schemaVersion: RUN_METRICS_SCHEMA_VERSION,
    eventCount: ordered.length,
    toolCallCount,
    toolResultCount,
    messageCount,
    duplicateFullMessageCount,
    mutationCount: mutationSeqs.length,
    verificationCount: verificationSeqs.length,
    ambiguousActionCount,
    lastMutationSeq,
    lastVerificationSeq,
    verificationAfterLastMutation,
    verifiedCompletion: terminalStatus === "completed" && verificationAfterLastMutation === true,
    terminalStatus,
    measurements,
  };
}

type CommandClassification = "mutation" | "verification" | "ambiguous" | "neutral";

function classifyCommand(command: string): CommandClassification {
  const text = command.trim().toLowerCase();
  if (text.length === 0) return "ambiguous";
  if (isTestCommand(text) || isCompileCommand(text)) return "verification";
  // Strip heredoc bodies before classification: a `<<'EOF' ... EOF` block is
  // code the interpreter consumes, not a shell command. Its `>` / `>=`
  // comparisons and `->` arrows are NOT shell redirects — counting them as
  // mutations was the `mutationCount=2 vs files_modified=1` false positive the
  // courtroom flagged on the circuit-breaker run.
  const shellOnly = text.replace(/<<[-]?['"]?\w+['"]?\s*[\s\S]*?\n\w+\s*$/m, "").trim();
  if (shellOnly.length === 0) return "verification"; // pure heredoc run (probe/harness)
  if (isTestCommand(shellOnly) || isCompileCommand(shellOnly)) return "verification";
  // Redirect writes into scratch paths (/tmp, /dev, /proc, /var/tmp, dot-scratch)
  // are scratch files (test harnesses, probes, logs), NOT submission mutations.
  // The agent writes a throwaway test harness to /tmp before verifying; counting
  // that as a mutation-after-verification would wrongly flag false_success.
  if (/(^|[^<])\>{1,2}\s*(?:[^&;|]*\/)?(tmp|var\/tmp|dev|proc|sys)\b/.test(shellOnly)) {
    // Write to a scratch path — treat as neutral/verification scaffolding, not a submission mutation.
    return "neutral";
  }
  if (
    /(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|install)\b/.test(shellOnly) ||
    /(^|[;&|]\s*)(sed|perl)\s+[^;&|]*\s-i\b/.test(shellOnly) ||
    /(^|[;&|]\s*)git\s+(apply|checkout|restore|reset|clean)\b/.test(shellOnly) ||
    /(^|[^<])>{1,2}\s*[^&]/.test(shellOnly)
  ) return "mutation";
  if (/^(pwd|ls|find|rg|grep|cat|head|tail|git\s+(status|diff|log|show))\b/.test(shellOnly)) return "neutral";
  return "ambiguous";
}

function isTestCommand(command: string): boolean {
  const text = command.trim().toLowerCase();
  // Common declarative test runners.
  if (/(^|[;&|]\s*)((npm|pnpm|yarn)\s+(run\s+)?test\b|pytest\b|vitest\b|jest\b|cargo\s+test\b|go\s+test\b|make\s+test\b|mvn\s+test\b|gradle\s+test\b)/i.test(text)) return true;
  // Interpreter running a test file: node/python/deno/bun/perl/ruby <...test...> / run a *_test.* / test_* file.
  if (/(^|[;&|]\s*)(node|nodejs|deno|bun|python3?|python|pypy|perl|ruby|php)\s+[^;&|]*(\/|^|\s)[^;&|]*(test|spec|_test\.|test_)(\.|[/\s]|$)/i.test(text)) return true;
  // Running a local test script directly: ./script, ./run-tests.sh, ./*test*, "make test", a bare test binary.
  if (/(^|[;&|]\s*)(\.\/[^;&|]*(test|spec|check)|\.\/run[_-]?(test|spec|check)|\.\/[^;&|]*\.(sh|py|js|ts|mjs)\s+[^;&|]*test)/i.test(text)) return true;
  if (/^\.\/(test|spec)\b/i.test(text)) return true;
  return false;
}

function isCompileCommand(command: string): boolean {
  const text = command.trim().toLowerCase();
  if (/(^|[;&|]\s*)((npm|pnpm|yarn)\s+(run\s+)?(build|typecheck|lint)\b|tsc\b|cargo\s+(build|check)\b|go\s+build\b|make\s+(build|check)\b|cmake\s+--build\b)/i.test(text)) return true;
  // Compiler invocation: gcc/g++/cc/clang/clang++/cl with -c (compile) or explicit build.
  if (/(^|[;&|]\s*)(gcc|g\+\+|cc|clang|clang\+\+|cl)\b[^;&|]*(-c\b|\.(c|cpp|cc|cxx|h)\b)/i.test(text)) return true;
  return false;
}

function isTestTool(name: string, command: string): boolean {
  return name === "test" || isTestCommand(command);
}

function isCompileTool(name: string, command: string): boolean {
  return ["build", "typecheck", "lint", "check"].includes(name) || isCompileCommand(command);
}

function outputLooksFailed(output: unknown): boolean {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  return /\b(fail(?:ed|ure)?|error|exception|not ok)\b/i.test(text) &&
    !/\b0\s+(failed|errors?)\b/i.test(text);
}

function commandFromArgs(args: unknown): string {
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const object = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) if (typeof object[key] === "string") return object[key];
  if (Array.isArray(object.argv)) return object.argv.map(String).join(" ");
  return "";
}

function pathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const object = args as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "filename"]) {
    if (typeof object[key] === "string" && object[key].trim()) return object[key].trim();
  }
  return null;
}

function stableArgs(args: unknown): string {
  try {
    return JSON.stringify(args, Object.keys((args && typeof args === "object" && !Array.isArray(args)) ? args as object : {}).sort());
  } catch {
    return String(args);
  }
}

function patchStats(text: string | undefined): { bytes: number; added: number; removed: number } {
  if (text === undefined) return { bytes: 0, added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { bytes: Buffer.byteLength(text), added, removed };
}

function exact(value: number | boolean, unit: string, refs: MetricRef[]): MetricMeasurement {
  return { value, unit, provenance: "exact", refs };
}

function derived(value: number | boolean, unit: string, refs: MetricRef[]): MetricMeasurement {
  return { value, unit, provenance: "derived", refs };
}

function unknown(unit: string, note: string): MetricMeasurement {
  return { value: null, unit, provenance: "unknown", refs: [], note };
}
