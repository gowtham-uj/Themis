/** Typed Phase-2 board failures — an interrupted board is not an empty verdict. */

/**
 * The PI board stopped before all four roles filed their record.
 *
 * This is the difference between "the board looked and found nothing" and "the
 * board was killed 45 seconds into its first role". Only the first may publish.
 * A pause SIGKILLs the process tree and freezes the session for resume; if that
 * missing YAML were read as an empty result, the campaign would publish an empty
 * developer pack over ten sealed archives and lock resume out behind the
 * published-campaign guard. The recorded session is still on disk, so the
 * pipeline parks the generation and the operator resumes exactly where it
 * stopped.
 */
export class Phase2BoardInterruptedError extends Error {
  readonly phase2Interrupted = true;
  constructor(
    message: string,
    /** Records the board did commit before it stopped, e.g. `phase2-hypotheses.yaml`. */
    readonly filed: readonly string[],
    /** True when this run was paused (its resume pointer was written mid-run). */
    readonly resumable: boolean,
  ) {
    super(message);
    this.name = "Phase2BoardInterruptedError";
  }
}

/** True for a board that stopped with work left to resume. Structural so a
 *  re-imported module copy cannot break the pipeline's parking decision. */
export function isPhase2BoardInterrupted(err: unknown): err is Phase2BoardInterruptedError {
  return Boolean(err) && (err as { phase2Interrupted?: boolean }).phase2Interrupted === true;
}
