/**
 * Stubs for deleted judge subsystem. These exist so API routes that referenced
 * judge functionality compile. The judge is completely removed from the codebase.
 */

export type ReleaseVerdict = Record<string, any> | null;
export type BatchClaimStore = { claim: (...a: any[]) => boolean; release: any; [k: string]: any };
export type BuildReleaseVerdictOptions = Record<string, any>;
export type EvalBundle = Record<string, any>;
export type JudgeRunner = any;
export type JudgeRunContext = any;

export function createBatchClaimStore(): BatchClaimStore {
  return { claim: () => false, release: null };
}
export function batchProgress(_runs: readonly any[], _batchId: string): any {
  return { completed: 0, total: 0, failed: 0, passedEvals: 0, releasePublished: false };
}
export async function buildReleaseVerdict(..._args: any[]): Promise<ReleaseVerdict | null> {
  return null;
}
export function renderReleaseReport(_verdict: ReleaseVerdict): string {
  return "<p>Judge subsystem removed.</p>";
}
export function renderEvalReport(_report: unknown): string {
  return "<p>Judge subsystem removed.</p>";
}
export async function collectBatchBundles(_queries: unknown, _dataDir: string, _batchId: string): Promise<EvalBundle[]> {
  return [];
}
export function summarizeBundles(_bundles: EvalBundle[]): Record<string, unknown> {
  return {};
}
export async function buildEvalReport(_queries: unknown, _dataDir: string, _batchId: string): Promise<any> {
  return { evals: [] };
}
export function prepareQueueAnalysis(_dataDir?: unknown, _queries?: unknown, _input?: unknown): { analysis: Record<string, unknown> } {
  return { analysis: {} };
}
export async function executeQueueAnalysis(_dataDir?: unknown, _queries?: unknown, _input?: unknown, _analysis?: unknown): Promise<never> {
  throw new Error("judge subsystem removed");
}
export async function judgeRun(..._args: any[]): Promise<never> {
  throw new Error("judge subsystem removed");
}
export function claimBatchIfComplete(..._args: any[]): boolean {
  return false;
}
