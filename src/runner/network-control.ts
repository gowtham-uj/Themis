/**
 * Live network-cutoff control for a running sandbox.
 *
 * Spec: plan/execution.md §Live control (API client → sandbox).
 *
 * Cutoff is a **live OVERRIDE** that supersedes the static per-task network policy
 * (`allow` | `allowlist` | `offline`) for the duration of the run. It does not
 * restart the container: flipping the flag refuses new outbound connections at
 * the edge and models killing in-flight ones.
 *
 * Integration contract for live container runtimes:
 * before allowing a network attempt, the runtime calls
 * {@link NetworkCutoffController.isBlocked} (or consults
 * {@link NetworkCutoffController.policyFor} with the static policy). When
 * blocked, the attempt must not leave the container and should be reported to
 * the exec/net recorder as `net{blocked:true, blockedReason:"live-cutoff"}`.
 *
 * The interface is exported so runtime and API layers can share the contract
 * without a circular import on the concrete class.
 */

/** Static per-task network policy (distinct from live cutoff). */
export type StaticNetworkPolicy = "allow" | "allowlist" | "offline";

/**
 * Seam the container runtime checks before allowing egress.
 * Implemented by {@link NetworkCutoff} without coupling callers to its class.
 */
export interface NetworkCutoffController {
  /** True when live cutoff is active (egress disabled). */
  isBlocked(): boolean;
  /** Effective policy: under live cutoff always `"offline"`, else the static policy. */
  policyFor(staticPolicy: StaticNetworkPolicy): StaticNetworkPolicy;
  /** ISO-8601 timestamp of the most recent cutoff(), or null if never cut. */
  cutoffAt(): string | null;
}

/**
 * Mutable live network-cutoff state for one run.
 *
 * Default: egress enabled. `cutoff()` disables; `restore()` re-enables without
 * a container restart.
 */
export class NetworkCutoff implements NetworkCutoffController {
  /** Current edge state — false means new outbound connections are refused. */
  private state: { egressEnabled: boolean } = { egressEnabled: true };

  /** ISO timestamp of the most recent `cutoff()` call, for the run timeline. */
  private _cutoffAt: string | null = null;

  /** Disable egress immediately. Records the cutoff moment for the timeline. */
  cutoff(): void {
    this.state.egressEnabled = false;
    this._cutoffAt = new Date().toISOString();
  }

  /**
   * Re-enable egress without restarting the container.
   * Does not clear the historical cutoff timestamp (timeline still shows when
   * cutoff first happened for this run).
   */
  restore(): void {
    this.state.egressEnabled = true;
  }

  /** True when live cutoff is active. */
  isBlocked(): boolean {
    return !this.state.egressEnabled;
  }

  /**
   * Effective network policy given a static per-task policy and the live flag.
   * Live cutoff supersedes: when blocked, always `"offline"`.
   */
  policyFor(staticPolicy: StaticNetworkPolicy): StaticNetworkPolicy {
    if (this.isBlocked()) return "offline";
    return staticPolicy;
  }

  /**
   * Timestamp string of when cutoff was last applied, or null if never cut.
   * Used to mark the cutoff moment on the run timeline.
   */
  cutoffAt(): string | null {
    return this._cutoffAt;
  }

  /** Snapshot of the internal state (read-only). */
  getState(): Readonly<{ egressEnabled: boolean }> {
    return { egressEnabled: this.state.egressEnabled };
  }
}
