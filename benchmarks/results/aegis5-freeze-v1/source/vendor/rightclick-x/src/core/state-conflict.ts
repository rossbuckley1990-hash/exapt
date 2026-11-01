/** The backing state changed or another writer owns its publication lock. */
export class StateConflictError extends Error {
  constructor(message: string) {
    super(`state conflict: ${message}`);
    this.name = "StateConflictError";
  }
}

/** A state commit was attempted, but its durable outcome cannot be established. */
export class StateCommitUnknownError extends Error {
  constructor(message: string) {
    super(`state commit outcome unknown: ${message}`);
    this.name = "StateCommitUnknownError";
  }
}
