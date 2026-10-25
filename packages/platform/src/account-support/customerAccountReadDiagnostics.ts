export type CustomerAccountReadStage = "account_aggregate";

type DiagnosticRecord = Record<string, unknown>;

export class CustomerAccountReadModelError extends Error {
  readonly stage: CustomerAccountReadStage;
  readonly cause: unknown;

  constructor(stage: CustomerAccountReadStage, cause: unknown) {
    super(`Customer account read model failed at ${stage}`);
    this.name = "CustomerAccountReadModelError";
    this.stage = stage;
    this.cause = cause;
  }
}

export async function withCustomerAccountReadStage<T>(
  stage: CustomerAccountReadStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CustomerAccountReadModelError) throw error;
    throw new CustomerAccountReadModelError(stage, error);
  }
}

export function customerAccountReadFailureDetails(error: unknown): DiagnosticRecord {
  if (!(error instanceof CustomerAccountReadModelError)) {
    return { reason: "read_model_failed", stage: "unknown" };
  }
  return {
    reason: "read_model_failed",
    stage: error.stage,
    providerCode: diagnosticText(readRecord(error.cause).code),
  };
}

export function logCustomerAccountReadFailure(error: unknown): void {
  if (error instanceof CustomerAccountReadModelError) {
    console.error("[customer-account] read model failed:", JSON.stringify({
      stage: error.stage,
      cause: safeCause(error.cause),
    }));
    return;
  }

  console.error("[customer-account] read failed:", JSON.stringify({ cause: safeCause(error) }));
}

function safeCause(error: unknown): DiagnosticRecord {
  if (error instanceof Error) {
    const record = readRecord(error);
    return compact({
      name: error.name,
      message: error.message,
      code: diagnosticText(record.code),
      hint: diagnosticText(record.hint),
      details: diagnosticText(record.details),
    });
  }
  return compact({
    type: typeof error,
    code: diagnosticText(readRecord(error).code),
    message: diagnosticText(readRecord(error).message),
  });
}

function readRecord(value: unknown): DiagnosticRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DiagnosticRecord : {};
}

function diagnosticText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 300);
}

function compact(value: DiagnosticRecord): DiagnosticRecord {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
