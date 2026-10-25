export class CommerceRuntimeConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Commerce runtime conflict", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceRuntimeConflictError";
    this.details = details;
  }
}

export class CommerceRuntimePersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Commerce runtime persistence failed", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceRuntimePersistenceError";
    this.details = details;
  }
}
