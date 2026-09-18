/**
 * The quote was valid when read, but the atomic order write could no longer
 * claim its promotion. Callers must re-quote and surface `price_changed`.
 */
export class CommerceOrderDraftPriceChangedError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    message = "Commerce order draft promotion changed",
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CommerceOrderDraftPriceChangedError";
    this.details = details;
  }
}

export type CommerceOrderDraftUnsupportedMoneyReason =
  | "line_promotion_unsupported"
  | "net_shipping_unsupported"
  | "zero_payable_unsupported";

export class CommerceOrderDraftUnsupportedMoneyError extends Error {
  constructor(readonly reason: CommerceOrderDraftUnsupportedMoneyReason) {
    super(`Commerce order draft money shape is unsupported: ${reason}`);
    this.name = "CommerceOrderDraftUnsupportedMoneyError";
  }
}
