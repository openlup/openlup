import { skuSchema } from "@openlup/core/catalog";

import { z } from "../../lib/validation/zod.js";
import { bundleCodeSchema, bundleCurrencySchema } from "./adminBundleContracts.js";

/**
 * The PUBLIC sellable-bundle feed — the one shape a storefront consumes.
 *
 * It is deliberately smaller than the admin detail and answers a different
 * question. An admin read shows the whole lifecycle; this shows only what may be
 * sold right now, and it carries no lifecycle field at all, so a draft cannot even
 * be expressed in it. `.strict()` everywhere: a field that leaks into this feed is
 * a field a storefront will start depending on.
 *
 * PER-COMPONENT MONEY IS DERIVED, NOT STORED. The operator sets ONE target price;
 * the per-line figures come from the pricing kernel's allocation over that price,
 * and their sum is the price to the last minor unit. The feed carries both halves
 * because a storefront that shows a bundle's parts must be able to show what each
 * part costs inside it — and because that identity is the only thing that makes
 * the derived figures checkable by whoever consumes them.
 *
 * `fulfillmentMode` is an OPEN validated string, never a `z.enum`: the stored
 * column already admits more than the exploded mode that has a runtime, and a
 * closed enum here would make every new mode a change in this contract.
 */

export const SELLABLE_BUNDLE_CONTRACT_VERSION = "catalog.sellable-bundle.v1";

const sellableBundleMoneySchema = z
  .object({
    amountMinor: z.number().int().nonnegative(),
    currency: bundleCurrencySchema,
  })
  .strict();

export const sellableBundleAvailabilitySchema = z
  .object({
    status: z.enum(["available", "low_stock", "out_of_stock", "unknown"]),
    /** Whole bundles that can ship now; `null` means unknown, never zero. */
    sellableNow: z.number().int().nonnegative().nullable(),
    /** The component that decided the answer, so a storefront can say which. */
    limitingSku: skuSchema.nullable(),
    reasonCode: z.string().trim().min(1).max(120),
  })
  .strict();

export const sellableBundleComponentSchema = z
  .object({
    sku: skuSchema,
    quantity: z.number().int().positive(),
    effectiveUnitPriceMinor: z.number().int().nonnegative(),
    lineSubtotalMinor: z.number().int().nonnegative(),
    /** How far this line sits below its own reference price, in basis points. */
    discountBps: z.number().int().nonnegative(),
  })
  .strict();

export const sellableBundleSchema = z
  .object({
    code: bundleCodeSchema,
    title: z.string().trim().min(1).max(160),
    fulfillmentMode: z.string().trim().min(1).max(40),
    price: sellableBundleMoneySchema,
    components: z.array(sellableBundleComponentSchema).min(1),
    availability: sellableBundleAvailabilitySchema,
  })
  .strict();

export const sellableBundleListResponseSchema = z
  .object({
    contractVersion: z.literal(SELLABLE_BUNDLE_CONTRACT_VERSION),
    bundles: z.array(sellableBundleSchema),
  })
  .strict();

export type SellableBundle = z.infer<typeof sellableBundleSchema>;
export type SellableBundleComponent = z.infer<typeof sellableBundleComponentSchema>;
export type SellableBundleAvailability = z.infer<typeof sellableBundleAvailabilitySchema>;
export type SellableBundleListResponse = z.infer<typeof sellableBundleListResponseSchema>;
