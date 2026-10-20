import type { CreateQuoteRequest, CreateQuoteResponse } from "./contracts/quote.js";
import type { PricingPolicySnapshot } from "./contracts/offerPolicy.js";

/**
 * Server-resolved options for promo evaluation. Passed OUT-OF-BAND by the caller
 * (orchestration -> provisioned.clientId; preview -> session/null) — NEVER sourced
 * from the client request body — so `first_purchase` eligibility cannot be forged.
 */
export interface CreateQuoteOptions {
  clientId?: string | null;
  pricingPolicy?: PricingPolicySnapshot;
}

export interface CommerceQuotePort<Request = CreateQuoteRequest, Response = CreateQuoteResponse> {
  createQuote(request: Request, options?: CreateQuoteOptions): Promise<Response>;
  createServerAuthoritativeQuote?(request: Request, options?: CreateQuoteOptions): Promise<Response>;
}

export interface CommerceQuoteSnapshotVerifierPort<Response = CreateQuoteResponse> {
  verifyQuoteSnapshot(snapshot: Response): Promise<Response | void>;
}

export type CommerceQuoteSnapshotErrorCode = "QUOTE_SNAPSHOT_MISMATCH";

export class CommerceQuoteSnapshotError extends Error {
  readonly code: CommerceQuoteSnapshotErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: CommerceQuoteSnapshotErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CommerceQuoteSnapshotError";
    this.code = code;
    this.details = details;
  }
}

export type CommerceQuoteErrorCode =
  | "UNKNOWN_SKU"
  | "PRICE_NOT_CONFIGURED"
  | "UNSUPPORTED_TAX_PROFILE"
  | "PRICING_INVARIANT_VIOLATION";

export class CommerceQuoteError extends Error {
  readonly code: CommerceQuoteErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: CommerceQuoteErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceQuoteError";
    this.code = code;
    this.details = details;
  }
}

