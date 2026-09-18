/**
 * The static price-book contract.
 *
 * The prices themselves are a deployment's commercial data and stay with it
 * (`src/data/commercePriceBook.ts`); the shape a quote port reads is the same
 * for every adopter, so it lives here and the data module re-exports it.
 */
import type { CatalogProductSlug } from "../catalog/types.js";
import type { CommerceCurrency, CommerceTaxProfile } from "./types.js";

export interface CommercePriceBookEntry {
  productSlug: CatalogProductSlug;
  unitPriceGrossMinor: number;
  currency: CommerceCurrency;
  tax: CommerceTaxProfile;
}

export type CommercePriceBook = Record<CatalogProductSlug, CommercePriceBookEntry>;
