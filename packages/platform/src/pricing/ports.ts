import type { CommercePriceAuthorityQuery, CommercePriceAuthorityResult, CommercePriceAuthorityRefusal } from "./contracts/index.js";

/** Named refusal from the strict current-money authority. */
export class CommercePriceAuthorityError extends Error {
  constructor(readonly code: CommercePriceAuthorityRefusal) {
    super(code);
    this.name = "CommercePriceAuthorityError";
  }
}

/**
 * Resolves one current, exact base anchor and either a validated policy-derived
 * subscription amount or the narrowly permitted pre-cutover legacy observation.
 */
export interface CommercePriceAuthorityPort {
  resolvePrice(query: CommercePriceAuthorityQuery): Promise<CommercePriceAuthorityResult>;
}
