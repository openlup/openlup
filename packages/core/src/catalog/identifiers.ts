import { z } from "zod";

/**
 * Open-but-validated catalog identifier primitives.
 *
 * These schemas validate shape only; membership belongs to the host
 * application's catalog read port. A runtime-editable catalog must accept new
 * slugs, SKUs, product ids, and variant ids without requiring a package release.
 * Keep these primitives format-bound, not enum-bound.
 */
/** @beta */
export const catalogSlugFormat = /^[a-z0-9][a-z0-9_-]*$/;
/** @beta */
export const slugSchema = z.string().min(1).max(64).regex(catalogSlugFormat);

/**
 * A purchasable SKU. Charset and length are bounded, but the schema does not
 * encode packaging, weight, brand, or merchant-specific prefixes.
 */
/** @beta */
export const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * A catalog product id. Accepts static ids and database ids as long as their
 * shape is bounded; existence is checked by the host catalog data source.
 */
/** @beta */
export const catalogProductIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

/**
 * A variant id. Accepts static ids and database ids without requiring a literal
 * prefix owned by the package.
 */
/** @beta */
export const variantIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
