export class OmnipackProviderError extends Error {
  readonly provider = "omnipack";
  readonly operation: string;
  readonly status: number | null;
  readonly code: string;
  readonly retryable: boolean;
  readonly mayHaveSucceeded: boolean;

  constructor(input: {
    operation: string;
    status: number | null;
    code: string;
    retryable: boolean;
    mayHaveSucceeded: boolean;
  }) {
    super(`OmniPack request failed: ${input.operation}`);
    this.name = "OmnipackProviderError";
    this.operation = input.operation;
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable;
    this.mayHaveSucceeded = input.mayHaveSucceeded;
  }
}

export interface SanitizedOmnipackProviderError {
  code: string;
  mayHaveSucceeded: boolean;
  message: string;
  operation: string | null;
  retryable: boolean;
  status: number | null;
}

export function sanitizeOmnipackProviderError(error: unknown): SanitizedOmnipackProviderError {
  if (error instanceof OmnipackProviderError) {
    return {
      code: error.code,
      mayHaveSucceeded: error.mayHaveSucceeded,
      message: error.message,
      operation: error.operation,
      retryable: error.retryable,
      status: error.status,
    };
  }
  return {
    code: "omnipack_provider_error",
    mayHaveSucceeded: true,
    message: "OmniPack request failed",
    operation: null,
    retryable: true,
    status: null,
  };
}

export function mayPostHaveSucceeded(method: string, status: number | null): boolean {
  if (method !== "POST") return false;
  return status === null
    || status === 408
    || status === 409
    || status === 425
    || status === 429
    || status >= 500;
}
