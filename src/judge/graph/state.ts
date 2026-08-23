/** Shared Phase-1 graph state (WP-8+). */

export interface Phase1GraphState {
  caseId: string;
  runId: string;
  archiveDir: string;
  workDir: string;
  node: "node0" | "node1" | "node2" | "node3" | "node4" | "done";
  round: number;
  paths: Record<string, string>;
  hashes: Record<string, string>;
}
