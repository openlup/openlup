import { z } from "./validation.js";
import { SELLABLE_CATALOG_CONTRACT_VERSION } from "./contracts/sellable.js";
export { SELLABLE_CATALOG_CONTRACT_VERSION } from "./contracts/sellable.js";
export type { SellableCatalogItem, SellableCatalogProfile, SellableCatalogListResponse } from "./contracts/sellable.js";

/** Minimal neutral storefront wire schema. */
const sellableCatalogMoneySchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const sellableCatalogItemSchema = z.object({
  sku: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
  title: z.string().trim().min(1).max(160),
  unitPrice: sellableCatalogMoneySchema,
  permittedPurchaseModes: z.array(z.enum(["one_time", "subscription"])).min(1).max(2),
}).strict();

export const sellableCatalogProfileSchema = z.object({
  id: z.string().trim().min(1).max(120),
  brand: z.string().trim().min(1).max(160),
  country: z.string().regex(/^[A-Z]{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  locale: z.string().trim().min(2).max(35),
  timezone: z.string().trim().min(1).max(80),
}).strict();

export const sellableCatalogListResponseSchema = z.object({
  contractVersion: z.literal(SELLABLE_CATALOG_CONTRACT_VERSION),
  profile: sellableCatalogProfileSchema,
  items: z.array(sellableCatalogItemSchema).min(1),
}).strict();

