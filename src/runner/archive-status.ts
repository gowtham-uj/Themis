/** Prefix persisted on a run when platform archive publication fails. */
export const ARCHIVE_SEAL_ERROR_PREFIX = "archive seal failed: ";

/** Build the explicit platform error stored on a run after archive publication fails. */
export function archiveSealFailureMessage(detail: string): string {
  return `${ARCHIVE_SEAL_ERROR_PREFIX}${detail}`;
}

/** Distinguish a platform archive failure from an evaluated agent's own failure. */
export function isArchiveSealFailure(error: string | null | undefined): boolean {
  return Boolean(error?.includes(ARCHIVE_SEAL_ERROR_PREFIX));
}
