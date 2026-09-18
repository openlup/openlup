import { z } from "../../lib/validation/zod.js";
import {
  channelCountryCodeSchema,
  channelCurrencySchema,
  channelSlugSchema,
  externalRefSchema,
  SELLABLE_KIND_BUNDLE,
  SELLABLE_KIND_SKU,
} from "./contracts.js";

// channel.order.v1 — the normalized external-order contract every connector
// (direct marketplace or aggregator) emits and the ingest saga consumes.
//
// Money is CHANNEL-FINAL: the platform re-derives nothing; instead the hard
// refines below make lying about totals impossible, and the ingest RPC
// re-asserts the same identities SQL-side as a backstop. All amounts are
// integer minor units in the order's single open ISO-4217 currency.
//
// Correlation (B4) is a declared contract, never an inference:
// `externalOrderRef` is THE order correlation key and is never null;
// `buyer.externalCustomerRef === null` means the connector declared that no
// stable buyer identity exists (per-order identity downstream), and
// `buyer.emailIsMasked` is a connector-declared fact about relay/alias
// addresses — masked or not, buyer email is NEVER an identity key.

export const CHANNEL_ORDER_CONTRACT_VERSION = "channel.order.v1";

const timestampSchema = z.string().datetime({ offset: true });

/** Settlement state a connector may report; the wave-1 saga admits only this value. */
export const CHANNEL_ORDER_PAID_EXTERNALLY_STATE = "paid_externally";

const channelOrderBuyerSchema = z
  .object({
    externalCustomerRef: externalRefSchema.nullable(),
    email: z.string().trim().max(320).nullable(),
    emailIsMasked: z.boolean(),
    firstName: z.string().trim().max(120).nullable(),
    lastName: z.string().trim().max(120).nullable(),
    phone: z.string().trim().max(40).nullable(),
    taxId: z.string().trim().max(32).nullable(),
    companyName: z.string().trim().max(200).nullable(),
  })
  .strict();

const channelOrderShipToSchema = z
  .object({
    recipientName: z.string().trim().min(1).max(200),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).nullable(),
    postalCode: z.string().trim().min(1).max(20),
    city: z.string().trim().min(1).max(120),
    countryCode: channelCountryCodeSchema,
    phone: z.string().trim().max(40).nullable(),
    pickupPointRef: z.string().trim().max(120).nullable(),
  })
  .strict();

const minorAmountSchema = z.number().int().nonnegative();

const channelOrderLineSellableSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(SELLABLE_KIND_SKU),
      externalOfferRef: externalRefSchema.nullable(),
      skuCode: z.string().trim().min(1).max(64).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(SELLABLE_KIND_BUNDLE),
      externalOfferRef: externalRefSchema.nullable(),
      bundleCode: z.string().trim().min(1).max(64).nullable(),
    })
    .strict(),
]);

const channelOrderLineSchema = z
  .object({
    externalLineRef: externalRefSchema,
    sellable: channelOrderLineSellableSchema,
    quantity: z.number().int().positive(),
    unitGrossMinor: minorAmountSchema,
    /** Pre-discount line total; must equal unitGrossMinor × quantity exactly. */
    lineGrossMinor: minorAmountSchema,
    lineDiscountMinor: minorAmountSchema,
    vatRateBps: z.number().int().min(0).max(10000).nullable(),
  })
  .strict();

const channelOrderShippingSchema = z
  .object({
    grossMinor: minorAmountSchema,
    discountMinor: minorAmountSchema,
    methodLabel: z.string().trim().max(120).nullable(),
    carrierHint: z.string().trim().max(64).nullable(),
  })
  .strict();

const channelOrderTotalsSchema = z
  .object({
    itemsGrossMinor: minorAmountSchema,
    itemsDiscountMinor: minorAmountSchema,
    shippingGrossMinor: minorAmountSchema,
    shippingDiscountMinor: minorAmountSchema,
    grandTotalMinor: z.number().int().positive(),
  })
  .strict();

const channelOrderPaymentSchema = z
  .object({
    /** Open string; the wave-1 ingest saga admits only "paid_externally". */
    state: z.string().trim().min(1).max(32),
    /** Settlement evidence — an order without it must never be created. */
    externalPaymentRef: externalRefSchema,
    paidAt: timestampSchema,
    methodLabel: z.string().trim().max(64).nullable(),
  })
  .strict();

export const normalizedChannelOrderSchema = z
  .object({
    contractVersion: z.literal(CHANNEL_ORDER_CONTRACT_VERSION),
    channelSlug: channelSlugSchema,
    externalOrderRef: externalRefSchema,
    externalOrderRevision: z.string().trim().max(64).nullable(),
    /** Dedupe key for inbound_provider_events; byte-identical on redelivery (B5). */
    providerEventId: z.string().trim().min(1).max(200),
    placedAt: timestampSchema,
    currency: channelCurrencySchema,
    buyer: channelOrderBuyerSchema,
    shipTo: channelOrderShipToSchema,
    lines: z.array(channelOrderLineSchema).min(1),
    shipping: channelOrderShippingSchema,
    totals: channelOrderTotalsSchema,
    payment: channelOrderPaymentSchema,
    /** Connector-computed digest of the raw wire payload, for audit/replay. */
    payloadDigest: z.string().trim().min(1).max(128),
  })
  .strict()
  .superRefine((order, ctx) => {
    let itemsGross = 0;
    let itemsDiscount = 0;
    order.lines.forEach((line, index) => {
      if (line.unitGrossMinor * line.quantity !== line.lineGrossMinor) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "lineGrossMinor"],
          message: "lineGrossMinor must equal unitGrossMinor × quantity",
        });
      }
      if (line.lineDiscountMinor > line.lineGrossMinor) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "lineDiscountMinor"],
          message: "lineDiscountMinor must not exceed lineGrossMinor",
        });
      }
      itemsGross += line.lineGrossMinor;
      itemsDiscount += line.lineDiscountMinor;
    });
    if (order.totals.itemsGrossMinor !== itemsGross) {
      ctx.addIssue({
        code: "custom",
        path: ["totals", "itemsGrossMinor"],
        message: "itemsGrossMinor must equal the sum of lineGrossMinor",
      });
    }
    if (order.totals.itemsDiscountMinor !== itemsDiscount) {
      ctx.addIssue({
        code: "custom",
        path: ["totals", "itemsDiscountMinor"],
        message: "itemsDiscountMinor must equal the sum of lineDiscountMinor",
      });
    }
    if (order.shipping.grossMinor !== order.totals.shippingGrossMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["totals", "shippingGrossMinor"],
        message: "shippingGrossMinor must equal shipping.grossMinor",
      });
    }
    if (order.shipping.discountMinor !== order.totals.shippingDiscountMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["totals", "shippingDiscountMinor"],
        message: "shippingDiscountMinor must equal shipping.discountMinor",
      });
    }
    const grand =
      order.totals.itemsGrossMinor -
      order.totals.itemsDiscountMinor +
      order.totals.shippingGrossMinor -
      order.totals.shippingDiscountMinor;
    if (order.totals.grandTotalMinor !== grand) {
      ctx.addIssue({
        code: "custom",
        path: ["totals", "grandTotalMinor"],
        message:
          "grandTotalMinor must equal itemsGross − itemsDiscount + shippingGross − shippingDiscount",
      });
    }
  });

export type NormalizedChannelOrder = z.infer<typeof normalizedChannelOrderSchema>;
export type NormalizedChannelOrderLine = z.infer<typeof channelOrderLineSchema>;
export type NormalizedChannelOrderBuyer = z.infer<typeof channelOrderBuyerSchema>;

/**
 * A wire signal a connector could not map to the normalized contract (B3):
 * quarantined loudly and durably downstream, never dropped. `vocabulary` is
 * the WIRE token verbatim (API enum value), never a panel/UI label (B1).
 */
export const unmappedChannelSignalSchema = z
  .object({
    vocabulary: z.string().trim().min(1).max(200),
    externalOrderRef: externalRefSchema.nullable(),
    detail: z.string().trim().max(500).nullable(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type UnmappedChannelSignal = z.infer<typeof unmappedChannelSignalSchema>;
