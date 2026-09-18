import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { z } from "../../lib/validation/zod.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import {
  commerceMoneySchema,
  createQuoteResponseSchema,
  quoteContextSchema,
  quoteDiscountSchema,
  quoteLineSchema,
  type CreateQuoteResponse,
} from "./contracts.js";

export const ORDER_DRAFT_SNAPSHOT_SOURCE = "commerce.order_draft.bff.v0";

export const orderDraftSnapshotSchema = z
  .object({
    contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
    source: z.literal(ORDER_DRAFT_SNAPSHOT_SOURCE),
    status: z.literal("draft"),
    paymentStatus: z.literal("not_started"),
    currency: platformCurrencySchema,
    taxIncluded: z.literal(true),
    lines: z.array(quoteLineSchema).min(1).max(50),
    discounts: z.array(quoteDiscountSchema).max(20),
    context: quoteContextSchema.optional(),
    totals: z
      .object({
        subtotalGross: commerceMoneySchema,
        discountTotalGross: commerceMoneySchema,
        // Shipping lane (optional so pre-shipping snapshots stay valid). Mirrors the
        // quote contract: shipping is tracked separately from the order-total
        // discount so a free-shipping discount in `discounts[]` is not double-counted.
        shippingGross: commerceMoneySchema.optional(),
        shippingDiscountGross: commerceMoneySchema.optional(),
        totalGross: commerceMoneySchema,
        netTotal: commerceMoneySchema,
        taxTotal: commerceMoneySchema,
      })
      .strict(),
  })
  .strict()
  .refine(
    (snapshot) => {
      const lineSubtotal = snapshot.lines.reduce(
        (sum, line) => sum + line.lineSubtotalGross.amountMinor,
        0,
      );
      const discountTotal = snapshot.totals.discountTotalGross.amountMinor;
      // `discounts[]` carries both order-total and shipping discounts; account for
      // them in separate lanes (mirrors `quoteContracts`). Summing all of them and
      // comparing to `discountTotalGross` double-counts free shipping and rejects
      // every shipping-discounted cart.
      const orderDiscountSum = snapshot.discounts
        .filter((discount) => discount.appliesTo !== "shipping")
        .reduce((sum, discount) => sum + discount.amountOffMinor, 0);
      const shippingDiscountSum = snapshot.discounts
        .filter((discount) => discount.appliesTo === "shipping")
        .reduce((sum, discount) => sum + discount.amountOffMinor, 0);
      const shippingGross = snapshot.totals.shippingGross?.amountMinor ?? 0;
      const shippingDiscount = snapshot.totals.shippingDiscountGross?.amountMinor ?? 0;

      return (
        snapshot.totals.subtotalGross.amountMinor === lineSubtotal &&
        discountTotal >= 0 &&
        discountTotal <= lineSubtotal &&
        orderDiscountSum === discountTotal &&
        shippingGross >= 0 &&
        shippingDiscount >= 0 &&
        shippingDiscount <= shippingGross &&
        shippingDiscountSum === shippingDiscount &&
        snapshot.totals.totalGross.amountMinor ===
          lineSubtotal - discountTotal + shippingGross - shippingDiscount &&
        snapshot.totals.netTotal.amountMinor + snapshot.totals.taxTotal.amountMinor ===
          snapshot.totals.totalGross.amountMinor
      );
    },
    {
      message: "order draft snapshot totals must match quote lines",
      path: ["totals"],
    },
  );

export const orderDraftSnapshotFromQuoteSnapshotSchema = z
  .object({
    quoteSnapshot: createQuoteResponseSchema,
    orderDraftSnapshot: orderDraftSnapshotSchema,
  })
  .refine(
    ({ quoteSnapshot, orderDraftSnapshot }) =>
      orderDraftSnapshot.currency === quoteSnapshot.quote.currency &&
      orderDraftSnapshot.taxIncluded === quoteSnapshot.quote.taxIncluded &&
      orderDraftSnapshot.lines.length === quoteSnapshot.quote.lines.length &&
      JSON.stringify(orderDraftSnapshot.lines) ===
        JSON.stringify(quoteSnapshot.quote.lines) &&
      JSON.stringify(orderDraftSnapshot.discounts) ===
        JSON.stringify(quoteSnapshot.quote.discounts) &&
      JSON.stringify(orderDraftSnapshot.context ?? null) ===
        JSON.stringify(quoteSnapshot.quote.context ?? null) &&
      orderDraftSnapshot.totals.subtotalGross.amountMinor ===
        quoteSnapshot.quote.subtotalGross.amountMinor &&
      orderDraftSnapshot.totals.discountTotalGross.amountMinor ===
        quoteSnapshot.quote.discountTotalGross.amountMinor &&
      orderDraftSnapshot.totals.totalGross.amountMinor ===
        quoteSnapshot.quote.totalGross.amountMinor &&
      orderDraftSnapshot.totals.netTotal.amountMinor ===
        quoteSnapshot.quote.netTotal.amountMinor &&
      orderDraftSnapshot.totals.taxTotal.amountMinor ===
        quoteSnapshot.quote.taxTotal.amountMinor &&
      (orderDraftSnapshot.totals.shippingGross?.amountMinor ?? 0) ===
        (quoteSnapshot.quote.shippingGross?.amountMinor ?? 0) &&
      (orderDraftSnapshot.totals.shippingDiscountGross?.amountMinor ?? 0) ===
        (quoteSnapshot.quote.shippingDiscountGross?.amountMinor ?? 0),
    {
      message: "order draft snapshot must mirror the quote snapshot",
      path: ["orderDraftSnapshot"],
    },
  );

export type OrderDraftSnapshot = z.infer<typeof orderDraftSnapshotSchema>;

export function createOrderDraftSnapshotFromQuoteSnapshot(
  quoteSnapshot: CreateQuoteResponse,
): OrderDraftSnapshot {
  const { quote } = quoteSnapshot;

  return orderDraftSnapshotSchema.parse({
    contractVersion: COMMERCE_CONTRACT_VERSION,
    source: ORDER_DRAFT_SNAPSHOT_SOURCE,
    status: "draft",
    paymentStatus: "not_started",
    currency: quote.currency,
    taxIncluded: quote.taxIncluded,
    lines: quote.lines,
    discounts: quote.discounts,
    context: quote.context,
    totals: {
      subtotalGross: quote.subtotalGross,
      discountTotalGross: quote.discountTotalGross,
      ...(quote.shippingGross ? { shippingGross: quote.shippingGross } : {}),
      ...(quote.shippingDiscountGross
        ? { shippingDiscountGross: quote.shippingDiscountGross }
        : {}),
      totalGross: quote.totalGross,
      netTotal: quote.netTotal,
      taxTotal: quote.taxTotal,
    },
  });
}
