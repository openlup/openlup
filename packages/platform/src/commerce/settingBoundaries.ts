/** @experimental Informational catalogue entries owned by commerce. */
export const commerceSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["returnReasons", "cap", "Choose the allowed return reasons.", "The native order service still enforces a fixed vocabulary."],
  ["multipleMarkets", "cap", "Serve several markets from one starter configuration.", "A starter configuration has one market and composes its own quote and checkout admission."],
  ["zeroPayableSettlements", "cap", "Settle orders and renewal cycles with zero payable.", "Native settlement requires a positive charge amount. Zero-payable fulfillment needs its own settlement path."],
  ["promotionCodeRedemption", "cap", "Redeem promotion codes in native checkout.", "The native checkout path lacks a promotion-code resolver."],
  ["manualHoldReasons", "cap", "Distinguish separate reasons for manually holding an order.", "Native order controls record a fixed manual hold reason."],
];
