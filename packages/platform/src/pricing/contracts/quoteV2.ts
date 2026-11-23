import type { CommerceMoneyBodyV2 } from "@openlup/core/pricing";

/** @experimental Shared quote money committed by the money digest. */
export type CommerceQuoteMoneyV2 = CommerceMoneyBodyV2;
/** @experimental Merchandise money for one source ordinal. */
export type MoneyLineV2 = CommerceQuoteMoneyV2["lines"][number];
/** @experimental One nonzero, evidenced adjustment share. */
export type DiscountAllocationV2 = MoneyLineV2["discountAllocations"][number];
/** @experimental One assessed position within a component state. */
export type TaxPositionV2 = MoneyLineV2["taxPositions"][number];
/** @experimental A delivery charge and its planned parts. */
export type DeliveryBucketV2 = CommerceQuoteMoneyV2["deliveryBuckets"][number];
/** @experimental One payable fee and its refund policy. */
export type FeeLineV2 = CommerceQuoteMoneyV2["feeLines"][number];
/** @experimental Estimate or final quote with separately committed money and quote digests. */
export type CommerceQuoteV2 = CommerceQuoteMoneyV2 & Readonly<{
  contractVersion: "commerce.v1"; schemaVersion: 2; quoteId: string;
  status: "estimate" | "final"; moneyDigest: string; quoteDigest: string;
}>;
