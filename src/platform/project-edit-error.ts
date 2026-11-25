/** A validation failure from the pure Project Graph editing boundary. */
export class ProjectEditError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown>) {
    super(message);
    this.name = "ProjectEditError";
  }
}
