import type { CommerceMoneyBodyV2 } from "@openlup/core/pricing";

/** @experimental Original order money and its quote or cycle origin. */
export type OrderMoneyV2 = CommerceMoneyBodyV2 & Readonly<{
  orderId: string; moneyVersion: "commerce.order-money.v2"; schemaVersion: 2; acceptedMoneyDigest: string;
}> & (
  | { acceptedQuoteRef: { quoteId: string; quoteDigest: string; acceptanceRef: string; tokenDigest: string }; cycleBindingRef?: never }
  | { cycleBindingRef: string; acceptedQuoteRef?: never }
);

/** @experimental Original order money with verified capture coordinates. */
export type PaidOrderMoneyV2 = OrderMoneyV2 & Readonly<{
  intentId: string; captureEvidenceRef: string; capturedAt: string; paidMinor: number;
}>;
