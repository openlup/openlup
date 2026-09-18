import {
  loggableProviderErrorCode,
  loggableProviderFieldName,
  loggableProviderRequestId,
} from "../../shared/providerAttemptFailureDiagnostic.js";

export interface TpayHttpFailureDiagnostic {
  httpStatus: number;
  requestId: string | null;
  providerErrorCodes: string[];
  fieldNames: string[];
}

/**
 * The provider answered, and its answer is read for two independent things: the
 * sanitized diagnostic that may be logged, and whether the refusal PROVES no
 * transaction was created.
 */
export interface TpayHttpFailure {
  diagnostic: TpayHttpFailureDiagnostic;
  /**
   * Tpay rejected the request document itself, so no transaction row can exist.
   * `false` is the fail-closed answer and the only one any ambiguity produces.
   */
  refusedBeforeTransaction: boolean;
}

/**
 * Tpay error codes that describe the REQUEST DOCUMENT — a missing field, a wrong
 * type, an out-of-range or malformed value, an unknown field, an unparseable
 * body, a wrong content type. Every one of them is decided by request validation
 * and therefore cannot be produced once a transaction row exists.
 *
 * Deliberately excluded, and each for a reason: `crc_not_unique` names an
 * ALREADY EXISTING transaction; `transaction_lock`, `transaction_blocked`,
 * `payment_failed` and `ts:transaction:*` describe a transaction's outcome or a
 * partially completed insert; `cannot_create_transaction`,
 * `partner_cannot_create_transaction` and every channel/merchant availability
 * code refuse for reasons whose ordering against creation we cannot prove from
 * here; `general` and `internal_server_error` are opaque. A refusal carrying any
 * of them keeps today's behavior and defers to reconciliation.
 *
 * ⚠️ This list is matched against the RAW body, never against
 * `TpayHttpFailureDiagnostic.providerErrorCodes` — that projection drops any code
 * outside the loggable set, which would turn a mixed body into a uniformly safe
 * one.
 */
export const TPAY_PRE_TRANSACTION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "country_not_valid",
  "field_required",
  "incorrect_content_type",
  "invalid_request_body",
  "is_required",
  "not_array",
  "not_natural_int",
  "not_string",
  "not_valid",
  "too_low",
  "ts:country:not_valid",
  "ts:payer:phone:not_valid",
  "unexpected_field",
]);

/** The one HTTP status on which Tpay reports request validation. */
const TPAY_REQUEST_VALIDATION_STATUS = 400;

const MAX_FAILURE_BODY_BYTES = 16_384;
const MAX_DIAGNOSTIC_ITEMS = 5;

export async function readTpayHttpFailure(response: {
  status: number;
  text(): Promise<string>;
}): Promise<TpayHttpFailure> {
  const base = emptyDiagnostic(response.status);
  try {
    const body = await response.text();
    if (body.length > MAX_FAILURE_BODY_BYTES) return unreadableFailure(base);
    const parsed = JSON.parse(body) as unknown;
    const root = asRecord(parsed);
    const payment = asRecord(root.payments);
    const errors = [...readArray(root.errors), ...readArray(payment.errors)];
    const rawErrorCodes = errors.map((entry) => asRecord(entry).errorCode);
    return {
      diagnostic: {
        ...base,
        requestId: loggableProviderRequestId(root.requestId) ? root.requestId : null,
        providerErrorCodes: allowedValues(errors.map((entry) => asRecord(entry).errorCode), loggableProviderErrorCode),
        fieldNames: allowedValues(errors.map((entry) => asRecord(entry).fieldName), loggableProviderFieldName),
      },
      refusedBeforeTransaction: refusedBeforeTransaction(response.status, rawErrorCodes),
    };
  } catch {
    return unreadableFailure(base);
  }
}

/**
 * Whether this answer proves Tpay created nothing.
 *
 * Three conditions, all required. The status must be exactly the validation
 * status: a 409 may name an existing transaction, a 429 or any 5xx may follow
 * one that was created before the response was lost. The body must have yielded
 * at least one error code, so an opaque refusal from an edge proxy — which we
 * cannot attribute to Tpay's validator — releases nothing. And EVERY raw code
 * must be allow-listed, including codes this repository does not otherwise
 * recognize, so one unknown code in a mixed body is enough to refuse.
 */
function refusedBeforeTransaction(status: number, rawErrorCodes: unknown[]): boolean {
  return status === TPAY_REQUEST_VALIDATION_STATUS
    && rawErrorCodes.length > 0
    && rawErrorCodes.every((code) =>
      typeof code === "string" && TPAY_PRE_TRANSACTION_REFUSAL_CODES.has(code)
    );
}

function unreadableFailure(diagnostic: TpayHttpFailureDiagnostic): TpayHttpFailure {
  return { diagnostic, refusedBeforeTransaction: false };
}

export function tpayHttpFailureDiagnostic(error: unknown): TpayHttpFailureDiagnostic | null {
  if (!error || typeof error !== "object") return null;
  const value = asRecord((error as { failureDiagnostic?: unknown }).failureDiagnostic);
  const httpStatus = value.httpStatus;
  const requestId = value.requestId;
  const providerErrorCodes = value.providerErrorCodes;
  const fieldNames = value.fieldNames;
  if (!Number.isInteger(httpStatus) || (httpStatus as number) < 100 || (httpStatus as number) > 599) return null;
  if (requestId !== null && !loggableProviderRequestId(requestId)) return null;
  if (!validAllowedValues(providerErrorCodes, loggableProviderErrorCode)
    || !validAllowedValues(fieldNames, loggableProviderFieldName)) return null;
  return {
    httpStatus: httpStatus as number,
    requestId: requestId as string | null,
    providerErrorCodes: [...providerErrorCodes],
    fieldNames: [...fieldNames],
  };
}

export class TpayHttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly failureDiagnostic: TpayHttpFailureDiagnostic | null;
  /**
   * Set only from a body this client actually parsed. It never crosses a
   * boundary as a claim on its own — the dispatch boundary turns it into typed
   * evidence, and the control-plane RPC re-proves the attempt independently.
   */
  readonly refusedBeforeTransaction: boolean;

  constructor(
    code: string,
    status: number,
    failureDiagnostic: TpayHttpFailureDiagnostic | null = null,
    refusedBeforeTransaction = false,
  ) {
    super(code);
    this.name = "TpayHttpError";
    this.code = code;
    this.status = status;
    this.failureDiagnostic = failureDiagnostic;
    this.refusedBeforeTransaction = refusedBeforeTransaction;
  }
}

function emptyDiagnostic(httpStatus: number): TpayHttpFailureDiagnostic {
  return { httpStatus, requestId: null, providerErrorCodes: [], fieldNames: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function allowedValues(values: unknown[], allowed: (value: unknown) => value is string): string[] {
  return [...new Set(values.filter(allowed))].slice(0, MAX_DIAGNOSTIC_ITEMS);
}

function validAllowedValues(value: unknown, allowed: (item: unknown) => item is string): value is string[] {
  return Array.isArray(value) && value.length <= MAX_DIAGNOSTIC_ITEMS
    && value.every(allowed);
}
