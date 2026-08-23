/** WP-11 typed result version identity (minimal). */

export type ResultPublicationState =
  | "preparing"
  | "uploaded"
  | "verified"
  | "committed"
  | "published"
  | "invalid"
  | "superseded";

export interface JudgeResultVersion {
  id: string;
  runId: string;
  trackId: string;
  reportSha256: string;
  reportPath: string;
  archiveViewPath: string | null;
  publicationState: ResultPublicationState;
  schemaVersion: number;
  createdAt: string;
}
