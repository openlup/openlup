import { COMMERCE_CONTRACT_VERSION } from "@/domains/commerce/types";
import type {
  GetCatalogProductResponse,
  ListCatalogProductsResponse,
} from "@/domains/commerce/adminCatalogReadContracts";
import type {
  BundleDetailView,
  BundlePricePreview,
  BundleSummaryView,
  GetBundleResponse,
  ListBundlesResponse,
  PreviewBundlePriceResponse,
} from "@/domains/bundle/adminBundleReadContracts";
import {
  SELLABLE_BUNDLE_CONTRACT_VERSION,
  type SellableBundleListResponse,
} from "@/domains/bundle/sellableBundleContracts";

/**
 * Shared fixtures for the admin bundle configurator specs.
 *
 * DELIBERATELY VOCABULARY-NEUTRAL. These live under `src/`, which the OSS surface
 * ratchet measures for brand, country, currency and category terms, and a fixture
 * is exactly the kind of file where an incidental national currency code or a
 * product noun slips a counted token into a publishable family. So the codes are abstract, the money is
 * denominated in the currency the RESPONSE carries (`EUR` here — the UI never
 * names one), and nothing describes what is in the box.
 */

const CURRENCY = "EUR";

export function bundleSummary(overrides: Partial<BundleSummaryView> = {}): BundleSummaryView {
  return {
    code: "starter-set",
    title: "Zestaw startowy",
    status: "draft",
    fulfillmentMode: "virtual",
    componentCount: 2,
    hasActiveTargetPrice: true,
    updatedAt: "2026-08-12T10:00:00.000Z",
    ...overrides,
  };
}

export function listResponse(bundles: BundleSummaryView[]): ListBundlesResponse {
  return { contractVersion: COMMERCE_CONTRACT_VERSION, bundles, total: bundles.length };
}

export function bundleDetail(overrides: Partial<BundleDetailView> = {}): GetBundleResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    bundle: {
      ...bundleSummary(),
      compositionConstraint: null,
      metadata: {},
      resolvedCurrency: CURRENCY,
      components: [
        {
          sku: "UNIT-ALPHA-001",
          title: "Alpha",
          productSlug: "alpha",
          quantity: 2,
          isAddon: false,
          sortOrder: 0,
          referenceUnitPriceMinor: 1000,
        },
        {
          sku: "UNIT-BETA-002",
          title: "Beta",
          productSlug: "beta",
          quantity: 1,
          isAddon: true,
          sortOrder: 1,
          referenceUnitPriceMinor: 500,
        },
      ],
      prices: [
        {
          mode: "any",
          targetPriceMinor: 2000,
          currency: CURRENCY,
          amountKind: "gross",
          active: true,
          validFrom: "2026-08-01T00:00:00.000Z",
          validTo: null,
        },
      ],
      ...overrides,
    },
  };
}

export function pricePreview(
  overrides: Partial<BundlePricePreview> = {},
): PreviewBundlePriceResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    preview: {
      bundleCode: "starter-set",
      priceListId: "list-1",
      mode: "any",
      currency: CURRENCY,
      referenceTotalMinor: 2500,
      targetPriceMinor: 2000,
      discountTotalMinor: 500,
      discountBps: 2000,
      floorApplied: false,
      componentTargets: [
        {
          sku: "UNIT-ALPHA-001",
          quantity: 2,
          referenceUnitPriceMinor: 1000,
          referenceSubtotalMinor: 2000,
          targetSubtotalMinor: 1600,
          discountAllocatedMinor: 400,
          discountBps: 2000,
          hasSplitPricing: true,
        },
        {
          sku: "UNIT-BETA-002",
          quantity: 1,
          referenceUnitPriceMinor: 500,
          referenceSubtotalMinor: 500,
          targetSubtotalMinor: 400,
          discountAllocatedMinor: 100,
          discountBps: 2000,
          hasSplitPricing: false,
        },
      ],
      allocatedLines: [
        { sku: "UNIT-ALPHA-001", quantity: 2, effectiveUnitPriceMinor: 800, lineSubtotalMinor: 1600 },
        { sku: "UNIT-BETA-002", quantity: 1, effectiveUnitPriceMinor: 400, lineSubtotalMinor: 400 },
      ],
      ...overrides,
    },
  };
}

/**
 * Catalog fixtures for the composition editor's unit picker.
 *
 * The optional detail fields are spread from ONE base object rather than restated
 * per SKU. Fields the unit picker never reads are OMITTED rather than set to null:
 * the contract marks them optional, and naming them would spend this publishable
 * family's ratchet headroom on fixture noise the test does not depend on.
 */
const SKU_BASE = {
  netWeightGrams: null,
  formatCode: null,
  unitFormCode: null,
  gtin: null,
  priceEntries: [],
};

export function catalogListResponse(): ListCatalogProductsResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    products: [
      { slug: "gamma", name: "Gamma", status: "active", species: null, skuCount: 2, hasActivePrice: true },
    ],
    total: 1,
  };
}

export function catalogProductResponse(): GetCatalogProductResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    product: {
      slug: "gamma",
      name: "Gamma",
      status: "active",
      species: null,
      allergens: [],
      marketingContent: null,
      readyToPublish: true,
      publishBlockers: [],
      skus: [
        { ...SKU_BASE, sku: "UNIT-GAMMA-003", status: "active", title: "Gamma unit" },
        // Draft, so the editor must not offer it: a component must be sellable.
        { ...SKU_BASE, sku: "UNIT-DELTA-004", status: "draft", title: "Delta unit" },
      ],
    },
  };
}

export function sellableFeed(
  availability: Partial<SellableBundleListResponse["bundles"][number]["availability"]> = {},
): SellableBundleListResponse {
  return {
    contractVersion: SELLABLE_BUNDLE_CONTRACT_VERSION,
    bundles: [
      {
        code: "starter-set",
        title: "Zestaw startowy",
        fulfillmentMode: "virtual",
        price: { amountMinor: 2000, currency: CURRENCY },
        components: [
          {
            sku: "UNIT-ALPHA-001",
            quantity: 2,
            effectiveUnitPriceMinor: 800,
            lineSubtotalMinor: 1600,
            discountBps: 2000,
          },
        ],
        availability: {
          status: "low_stock",
          sellableNow: 2,
          limitingSku: "UNIT-ALPHA-001",
          reasonCode: "low_stock",
          ...availability,
        },
      },
    ],
  };
}
