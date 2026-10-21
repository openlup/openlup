import type { CommerceQuoteCatalogItem as NeutralItem } from "../../src/pricing/index.js";
type CatalogCurrency = string;
type CatalogProductSlug = string;
type CatalogSegment = "segment_a" | "segment_b";
type CatalogPublicationStatus = "published" | "coming_soon";
type CatalogPackagingUnit = "unit_a" | "unit_b";
type CatalogPriceStatus = "not_configured" | "configured";
type CatalogAttributeSlug = string;
export interface CatalogMoney {
  amountMinor: number;
  currency: CatalogCurrency;
}

export interface CatalogPricingMetadata {
  status: CatalogPriceStatus;
  listPrice: CatalogMoney | null;
  taxCategory: "example_category" | null;
  externalRefs: {
    paymentProviderPriceId: string | null;
    inventoryProviderSku: string | null;
  };
}

export interface CatalogSku {
  sku: string;
  productSlug: CatalogProductSlug;
  variantId: string;
  publicationStatus: CatalogPublicationStatus;
  unit: CatalogPackagingUnit;
  netWeightGrams: number;
  /** Mirror of catalog_skus.is_addon: addon SKUs cannot be used as primary lines.
   *  Optional so existing fixtures default to a line (undefined = not an addon);
   *  the live read port always sets it. */
  isAddon?: boolean;
  /** The SKU's stored one-time and subscription sellability. Absent means
   *  sellable in both modes. Not part of the public product contract: its
   *  schema strips the field, so it never reaches a catalog response. */
  sellability?: { oneTime: boolean; subscription: boolean };
  pricing: CatalogPricingMetadata;
}

export interface CatalogComponentItem {
  name: string;
  pctText: string;
  percentage: number;
  role: string;
  body: string;
  attributeSlugs: CatalogAttributeSlug[];
  nameKey?: string;
  roleKey?: string;
  bodyKey?: string;
  claimPill?: string;
  claimPillKey?: string;
}

export interface CatalogComposition {
  rawComponents: string;
  rawComponentsQab: string | null;
  items: CatalogComponentItem[];
  attributeSlugs: CatalogAttributeSlug[];
  usagePer100Units: number | null;
}

export interface CatalogProduct {
  id: string;
  slug: CatalogProductSlug;
  displayName: string;
  lineName: string;
  segment: CatalogSegment;
  publicationStatus: CatalogPublicationStatus;
  route: {
    qaa: string;
    qab: string;
  };
  primarySku: CatalogSku;
  variants: CatalogSku[];
  composition: CatalogComposition;
  metadata: {
    format: string;
    usagePer100Units: number | null;
    legacyStatus: string | null;
  };
}


export interface CatalogReadPort {
  listProducts(): Promise<CatalogProduct[]>;
  getProductBySlug(slug: string): Promise<CatalogProduct | null>;
  listAttributes(): Promise<unknown[]>;
}
export interface CommerceQuoteCatalogItem extends NeutralItem {
  usagePer100Units: number | null;
  attributeSlugs?: readonly string[];
  segment?: CatalogSegment;
}
export interface CommerceQuoteCatalogReadPort {
  listQuoteCatalogItems(): Promise<CommerceQuoteCatalogItem[]>;
}
/** Legacy-only adapter for composition roots not yet cut over to D1. */
export function createLegacyCommerceQuoteCatalogReadPort(
  catalogReadPort: CatalogReadPort,
): CommerceQuoteCatalogReadPort {
  return {
    async listQuoteCatalogItems(): Promise<CommerceQuoteCatalogItem[]> {
      const products = await catalogReadPort.listProducts();
      return products.flatMap((product) => product.variants.map((sku) => ({
        skuId: sku.variantId,
        skuCode: sku.sku,
        variantId: sku.variantId,
        productSlug: product.slug,
        netWeightG: sku.netWeightGrams,
        usagePer100Units: product.composition?.usagePer100Units ?? null,
        attributeSlugs: product.composition?.attributeSlugs ?? [],
        segment: product.segment,
        isPrimarySku: sku.variantId === product.primarySku.variantId,
        isAddon: sku.isAddon ?? false,
        sellability: {
          oneTime: sku.sellability?.oneTime ?? true,
          subscription: sku.sellability?.subscription ?? true,
        },
        documentRevision: { id: null, digest: null },
      })));
    },
  };
}

export { CommerceQuoteCatalogReadError } from "../../src/pricing/index.js";
