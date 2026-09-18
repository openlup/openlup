export type TpayTransactionFailurePhase = "oauth" | "transaction_dispatch" | "response_decode";
/**
 * What is known about the PROVIDER's side after a failed create-transaction.
 *
 * `not_dispatched` - the transaction POST was never invoked.
 * `refused` - it was invoked, and the provider's own answer proves it created
 *   nothing. Strictly weaker evidence than `not_dispatched`, and deliberately a
 *   separate value: the two are proved by different facts and are accepted by
 *   different control-plane reopen modes.
 * `unknown` - anything else. A transaction may exist.
 */
export type TpayTransactionDispatchState = "not_dispatched" | "refused" | "unknown";

export type TpayTransactionFailureCode =
  | "tpay_oauth_failed"
  | "tpay_oauth_timeout"
  | "tpay_oauth_invalid_response"
  | "tpay_request_encode_failed"
  | "tpay_request_deadline_exhausted"
  | "tpay_request_refused"
  | "tpay_request_timeout"
  | "tpay_request_failed"
  | "tpay_invalid_response"
  | "tpay_transport_failed";

export interface TpayTransactionDispatchFailure {
  phase: TpayTransactionFailurePhase;
  code: TpayTransactionFailureCode;
  dispatchState: TpayTransactionDispatchState;
  failureDiagnostic?: TpayHttpFailureDiagnostic | null;
}

export interface TpayTrustedPreDispatchFailure {
  phase: "oauth" | "transaction_dispatch";
  code: "tpay_oauth_failed" | "tpay_oauth_timeout" | "tpay_oauth_invalid_response" | "tpay_request_encode_failed" | "tpay_request_deadline_exhausted";
  dispatchState: "not_dispatched";
}

/**
 * The provider answered the create-transaction by refusing the request document
 * itself. One shape only, because only one thing is provable here: no
 * transaction was created.
 */
export interface TpayTrustedRefusalFailure {
  phase: "response_decode";
  code: "tpay_request_refused";
  dispatchState: "refused";
}

/**
 * Deliberately excludes the transport exception and provider response. This
 * crosses the money boundary, so consumers may log only the typed facts.
 */
export class TpayTransactionDispatchError extends Error {
  readonly phase: TpayTransactionFailurePhase;
  readonly code: TpayTransactionFailureCode;
  readonly dispatchState: TpayTransactionDispatchState;
  readonly failureDiagnostic: TpayHttpFailureDiagnostic | null;

  constructor(failure: TpayTransactionDispatchFailure) {
    super(`tpay_transaction_${failure.dispatchState}:${failure.phase}:${failure.code}`);
    this.name = "TpayTransactionDispatchError";
    this.phase = failure.phase;
    this.code = failure.code;
    this.dispatchState = failure.dispatchState;
    this.failureDiagnostic = tpayHttpFailureDiagnostic({ failureDiagnostic: failure.failureDiagnostic });
  }
}

export function tpayTransactionFailureCode(
  error: unknown,
  fallback: TpayTransactionFailureCode,
): TpayTransactionFailureCode {
  const candidate = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return isTpayTransactionFailureCode(candidate) ? candidate : fallback;
}

/**
 * Reads back the refusal the dispatch boundary already decided rather than
 * re-deriving it: by this point the raw body is gone and only the typed verdict
 * survives, which is exactly what may cross the money boundary.
 */
export function tpayTrustedRefusalFailure(error: unknown): TpayTrustedRefusalFailure | null {
  if (!(error instanceof TpayTransactionDispatchError)) return null;
  return error.dispatchState === "refused"
      && error.phase === "response_decode"
      && error.code === "tpay_request_refused"
    ? { phase: "response_decode", code: "tpay_request_refused", dispatchState: "refused" }
    : null;
}

export function tpayTrustedPreDispatchFailure(error: unknown): TpayTrustedPreDispatchFailure | null {
  if (!(error instanceof TpayTransactionDispatchError) || error.dispatchState !== "not_dispatched") return null;
  const validPhase = error.phase === "oauth" || error.phase === "transaction_dispatch";
  const validCode = error.code === "tpay_oauth_failed" || error.code === "tpay_oauth_timeout" || error.code === "tpay_oauth_invalid_response" ||
    error.code === "tpay_request_encode_failed" || error.code === "tpay_request_deadline_exhausted";
  return validPhase && validCode ? { phase: error.phase, code: error.code, dispatchState: error.dispatchState } : null;
}

export async function tpayTransactionDispatchBoundary<Token, Request, Response, Result>(input: {
  authenticate: () => Promise<Token>;
  prepare: (token: Token) => Request;
  dispatch: (request: Request) => Promise<Response>;
  decode: (response: Response) => Promise<Result>;
}): Promise<Result> {
  let token: Token;
  try {
    token = await input.authenticate();
  } catch (error) {
    throw new TpayTransactionDispatchError({
      phase: "oauth",
      code: tpayOAuthFailureCode(error),
      dispatchState: "not_dispatched",
    });
  }

  let request: Request;
  try {
    request = input.prepare(token);
  } catch (error) {
    throw new TpayTransactionDispatchError({
      phase: "transaction_dispatch",
      code: tpayTransactionFailureCode(error, "tpay_request_encode_failed"),
      dispatchState: "not_dispatched",
    });
  }

  let response: Response;
  try {
    response = await input.dispatch(request);
  } catch (error) {
    throw new TpayTransactionDispatchError({
      phase: "transaction_dispatch",
      code: tpayTransactionFailureCode(error, "tpay_transport_failed"),
      dispatchState: "unknown",
    });
  }

  try {
    return await input.decode(response);
  } catch (error) {
    // A refusal of the request document is the one answer that proves the
    // provider created nothing. Everything else reaching here - an unparseable
    // 200, a 5xx, a 409, an opaque 400 - may sit on a real transaction and
    // stays `unknown`, which keeps the attempt fenced until reconciliation.
    if (error instanceof TpayHttpError && error.refusedBeforeTransaction) {
      throw new TpayTransactionDispatchError({
        phase: "response_decode",
        code: "tpay_request_refused",
        dispatchState: "refused",
        failureDiagnostic: tpayHttpFailureDiagnostic(error),
      });
    }
    throw new TpayTransactionDispatchError({
      phase: "response_decode",
      code: tpayTransactionFailureCode(error, "tpay_invalid_response"),
      dispatchState: "unknown",
      failureDiagnostic: tpayHttpFailureDiagnostic(error),
    });
  }
}

function isTpayTransactionFailureCode(value: unknown): value is TpayTransactionFailureCode {
  return value === "tpay_oauth_failed" ||
    value === "tpay_oauth_timeout" ||
    value === "tpay_oauth_invalid_response" ||
    value === "tpay_request_encode_failed" ||
    value === "tpay_request_deadline_exhausted" ||
    value === "tpay_request_refused" ||
    value === "tpay_request_timeout" ||
    value === "tpay_request_failed" ||
    value === "tpay_invalid_response" ||
    value === "tpay_transport_failed";
}

function tpayOAuthFailureCode(error: unknown): TpayTransactionFailureCode {
  const code = tpayTransactionFailureCode(error, "tpay_oauth_failed");
  return code === "tpay_invalid_response" ? "tpay_oauth_invalid_response" : code;
}
import {
  tpayHttpFailureDiagnostic,
  TpayHttpError,
  type TpayHttpFailureDiagnostic,
} from "./tpayHttpFailure.js";
