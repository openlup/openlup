export class CommerceNotEnabledError extends Error {
  constructor(feature: "cart" | "checkout" | "order draft" | "order" | "payment") {
    super(`Commerce ${feature} is not enabled yet`);
    this.name = "CommerceNotEnabledError";
  }
}

export class CommerceOrderDraftConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    message = "Commerce order draft idempotency conflict",
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CommerceOrderDraftConflictError";
    this.details = details;
  }
}


export class CommerceOrderDraftInvalidResponseError extends Error {
  constructor() {
    super("Commerce order draft returned invalid response");
    this.name = "CommerceOrderDraftInvalidResponseError";
  }
}

export class CommerceOrderDraftPersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    message = "Commerce order draft persistence failed",
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CommerceOrderDraftPersistenceError";
    this.details = details;
  }
}

export class CommerceCheckoutResumePersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    message = "Commerce checkout resume persistence failed",
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CommerceCheckoutResumePersistenceError";
    this.details = details;
  }
}
