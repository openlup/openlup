import type { CatalogSkuIdentifier, NeutralSkuEnvelopeV1 } from "../../src/domains/catalog/catalogFoundationContracts.js";
export const CATALOG_ENVELOPE_FIXTURE = {
  productId: "11111111-1111-4111-8111-111111111111",
  documentId: "33333333-3333-4333-8333-333333333333",
  skuIds: {
    grams200: "22222222-2222-4200-8200-000000000200",
    grams400: "22222222-2222-4400-8400-000000000400",
    grams800: "22222222-2222-4800-8800-000000000800",
  },
  product: { slug: "catalog-foundation-fixture" },
  revision: { revisionNo: 1, schemaId: "application:document/v1",
    documentRef: "document:catalog-foundation-fixture/v1", sourceRef: "source:catalog-foundation-fixture/v1",
    digest: "a".repeat(64) },
  skus: [
    { key: "grams200", code: "CATALOG-FOUNDATION-200", grams: 200, gtin: "12345670" },
    { key: "grams400", code: "CATALOG-FOUNDATION-400", grams: 400, gtin: "012345678905" },
    { key: "grams800", code: "CATALOG-FOUNDATION-800", grams: 800, gtin: "5901234123457" },
  ],
} as const;
type FixtureSku = typeof CATALOG_ENVELOPE_FIXTURE.skus[number];
type FixtureSkuKey = FixtureSku["key"];

export const catalogSkuEnvelopeFixture = {
  products: [{
    id: CATALOG_ENVELOPE_FIXTURE.productId,
    slug: CATALOG_ENVELOPE_FIXTURE.product.slug,
    primary_sku_id: CATALOG_ENVELOPE_FIXTURE.skuIds.grams400,
    current_document_revision_id: CATALOG_ENVELOPE_FIXTURE.documentId,
  }],
  revisions: [{
    id: CATALOG_ENVELOPE_FIXTURE.documentId,
    product_id: CATALOG_ENVELOPE_FIXTURE.productId,
    revision_no: CATALOG_ENVELOPE_FIXTURE.revision.revisionNo,
    schema_id: CATALOG_ENVELOPE_FIXTURE.revision.schemaId,
    document_ref: CATALOG_ENVELOPE_FIXTURE.revision.documentRef,
    source_ref: CATALOG_ENVELOPE_FIXTURE.revision.sourceRef,
    digest: CATALOG_ENVELOPE_FIXTURE.revision.digest,
  }],
  supabaseSkus: CATALOG_ENVELOPE_FIXTURE.skus.map((sku) => ({
    id: fixtureSkuId(sku.key),
    product_id: CATALOG_ENVELOPE_FIXTURE.productId,
    sku: sku.code,
    net_weight_g: sku.grams,
    status: "active" as const,
    sellable_standalone: true,
    sellable_in_subscription: true,
    is_addon: false,
    asset_ref: null,
  })),
  supabaseEans: CATALOG_ENVELOPE_FIXTURE.skus.map((sku) => ({
    catalog_sku_id: fixtureSkuId(sku.key),
    ean: sku.gtin,
    kind: "unit" as const,
    quantity: 1,
    is_primary: true,
  })),
  postgresRows: CATALOG_ENVELOPE_FIXTURE.skus.map((sku) => ({
    product_id: CATALOG_ENVELOPE_FIXTURE.productId,
    product_slug: CATALOG_ENVELOPE_FIXTURE.product.slug,
    current_document_revision_id: CATALOG_ENVELOPE_FIXTURE.documentId,
    primary_sku_id: CATALOG_ENVELOPE_FIXTURE.skuIds.grams400,
    sku_id: fixtureSkuId(sku.key),
    sku_product_id: CATALOG_ENVELOPE_FIXTURE.productId,
    sku_code: sku.code,
    net_content_unscaled: sku.grams,
    sku_status: "active" as const,
    sellable_one_time: true,
    sellable_subscription: true,
    is_addon: false,
    asset_ref: null,
    document_revision_id: CATALOG_ENVELOPE_FIXTURE.documentId,
    document_product_id: CATALOG_ENVELOPE_FIXTURE.productId,
    document_revision_no: CATALOG_ENVELOPE_FIXTURE.revision.revisionNo,
    document_schema_id: CATALOG_ENVELOPE_FIXTURE.revision.schemaId,
    document_ref: CATALOG_ENVELOPE_FIXTURE.revision.documentRef,
    document_source_ref: CATALOG_ENVELOPE_FIXTURE.revision.sourceRef,
    document_digest: CATALOG_ENVELOPE_FIXTURE.revision.digest,
  })),
  postgresIdentifiers: CATALOG_ENVELOPE_FIXTURE.skus.map((sku) => ({
    catalog_sku_id: fixtureSkuId(sku.key),
    issuer: "gs1",
    identifier_kind: "gtin" as const,
    normalized_value: sku.gtin,
    pack_kind: "unit" as const,
    quantity: 1,
    is_primary: true,
  })),
  envelopes: CATALOG_ENVELOPE_FIXTURE.skus.map((sku) => ({
    contractVersion: "catalog.foundation.v1" as const,
    product: {
      id: CATALOG_ENVELOPE_FIXTURE.productId,
      slug: CATALOG_ENVELOPE_FIXTURE.product.slug,
      primarySkuId: CATALOG_ENVELOPE_FIXTURE.skuIds.grams400,
    },
    sku: {
      id: fixtureSkuId(sku.key),
      productId: CATALOG_ENVELOPE_FIXTURE.productId,
      code: sku.code,
      netContent: { unscaled: sku.grams, scale: 0, unit: "GRAM" },
      sellability: { status: "active" as const, oneTime: true, subscription: true },
      isAddon: false,
      assetRef: null,
    },
    documentRevision: {
      id: CATALOG_ENVELOPE_FIXTURE.documentId,
      productId: CATALOG_ENVELOPE_FIXTURE.productId,
      ...CATALOG_ENVELOPE_FIXTURE.revision,
    },
    identifiers: [primaryCatalogSkuIdentifier(sku.key)],
  })) satisfies NeutralSkuEnvelopeV1[],
};

export interface CatalogSkuEnvelopeScaleFixture {
  products: Array<{
    id: string;
    slug: string;
    primary_sku_id: string;
    current_document_revision_id: string;
  }>;
  revisions: Array<{
    id: string;
    product_id: string;
    revision_no: number;
    schema_id: string;
    document_ref: string;
    source_ref: string;
    digest: string;
  }>;
  supabaseSkus: Array<{
    id: string;
    product_id: string;
    sku: string;
    net_weight_g: number;
    status: "active";
    sellable_standalone: boolean;
    sellable_in_subscription: boolean;
    is_addon: boolean;
    asset_ref: null;
  }>;
  supabaseEans: Array<{
    catalog_sku_id: string;
    ean: string;
    kind: "unit" | "collective";
    quantity: number;
    is_primary: boolean;
  }>;
  postgresRows: Array<Record<string, unknown>>;
  postgresIdentifiers: Array<Record<string, unknown>>;
  envelopes: NeutralSkuEnvelopeV1[];
}

/**
 * Independent scale fixture: 500 products x 10 SKUs x 2 identifiers. It is
 * deliberately separate from the small 200/400/800 structural example so the
 * two proofs cannot make each other's counts look green accidentally.
 */
export function createCatalogSkuEnvelopeScaleFixture(): CatalogSkuEnvelopeScaleFixture {
  const fixture: CatalogSkuEnvelopeScaleFixture = {
    products: [],
    revisions: [],
    supabaseSkus: [],
    supabaseEans: [],
    postgresRows: [],
    postgresIdentifiers: [],
    envelopes: [],
  };

  for (let productIndex = 1; productIndex <= 500; productIndex += 1) {
    const productId = scaleUuid("1", productIndex);
    const documentId = scaleUuid("3", productIndex);
    const productSlug = `catalog-product-${String(productIndex).padStart(4, "0")}`;
    const primarySkuId = scaleUuid("2", (productIndex - 1) * 10 + 1);
    const revision = {
      id: documentId,
      product_id: productId,
      revision_no: 1,
      schema_id: "application:document/v1",
      document_ref: `document:${productSlug}/v1`,
      source_ref: `source:${productSlug}/v1`,
      digest: productIndex.toString(16).padStart(64, "0"),
    };
    fixture.products.push({
      id: productId,
      slug: productSlug,
      primary_sku_id: primarySkuId,
      current_document_revision_id: documentId,
    });
    fixture.revisions.push(revision);

    for (let skuOffset = 1; skuOffset <= 10; skuOffset += 1) {
      const skuIndex = (productIndex - 1) * 10 + skuOffset;
      const skuId = scaleUuid("2", skuIndex);
      const skuCode = `CATALOG-P${String(productIndex).padStart(4, "0")}-S${String(skuOffset).padStart(2, "0")}`;
      const sku = {
        id: skuId,
        product_id: productId,
        sku: skuCode,
        net_weight_g: skuOffset * 100,
        status: "active" as const,
        sellable_standalone: true,
        sellable_in_subscription: true,
        is_addon: false,
        asset_ref: null,
      };
      fixture.supabaseSkus.push(sku);
      fixture.postgresRows.push({
        product_id: productId,
        product_slug: productSlug,
        current_document_revision_id: documentId,
        primary_sku_id: primarySkuId,
        sku_id: skuId,
        sku_product_id: productId,
        sku_code: skuCode,
        net_content_unscaled: skuOffset * 100,
        sku_status: "active",
        sellable_one_time: true,
        sellable_subscription: true,
        is_addon: false,
        asset_ref: null,
        document_revision_id: documentId,
        document_product_id: productId,
        document_revision_no: revision.revision_no,
        document_schema_id: revision.schema_id,
        document_ref: revision.document_ref,
        document_source_ref: revision.source_ref,
        document_digest: revision.digest,
      });

      const primaryGtin = scaleGtin((skuIndex - 1) * 2);
      const collectiveGtin = scaleGtin((skuIndex - 1) * 2 + 1);
      fixture.supabaseEans.push(
        { catalog_sku_id: skuId, ean: primaryGtin, kind: "unit", quantity: 1, is_primary: true },
        { catalog_sku_id: skuId, ean: collectiveGtin, kind: "collective", quantity: 6, is_primary: false },
      );
      fixture.postgresIdentifiers.push(
        { catalog_sku_id: skuId, issuer: "gs1", identifier_kind: "gtin", normalized_value: primaryGtin, pack_kind: "unit", quantity: 1, is_primary: true },
        { catalog_sku_id: skuId, issuer: "gs1", identifier_kind: "gtin", normalized_value: collectiveGtin, pack_kind: "collective", quantity: 6, is_primary: false },
      );
      fixture.envelopes.push({
        contractVersion: "catalog.foundation.v1",
        product: { id: productId, slug: productSlug, primarySkuId },
        sku: {
          id: skuId,
          productId,
          code: skuCode,
          netContent: { unscaled: skuOffset * 100, scale: 0, unit: "GRAM" },
          sellability: { status: "active", oneTime: true, subscription: true },
          isAddon: false,
          assetRef: null,
        },
        documentRevision: {
          id: documentId,
          productId,
          revisionNo: revision.revision_no,
          schemaId: revision.schema_id,
          documentRef: revision.document_ref,
          sourceRef: revision.source_ref,
          digest: revision.digest,
        },
        identifiers: [
          { issuer: "gs1", normalizedValue: primaryGtin, kind: "gtin", packKind: "unit", packQuantity: 1, isPrimary: true },
          { issuer: "gs1", normalizedValue: collectiveGtin, kind: "gtin", packKind: "collective", packQuantity: 6, isPrimary: false },
        ],
      });
    }
  }

  return fixture;
}

export function primaryCatalogSkuIdentifier(key: FixtureSkuKey): CatalogSkuIdentifier {
  const sku = CATALOG_ENVELOPE_FIXTURE.skus.find((candidate) => candidate.key === key);
  if (!sku) throw new RangeError(`unknown catalog fixture SKU: ${key}`);
  return {
    issuer: "gs1",
    normalizedValue: sku.gtin,
    kind: "gtin",
    packKind: "unit",
    packQuantity: 1,
    isPrimary: true,
  };
}

function fixtureSkuId(key: FixtureSkuKey): string {
  return CATALOG_ENVELOPE_FIXTURE.skuIds[key];
}

function scaleUuid(kind: "1" | "2" | "3", index: number): string {
  return `${kind}0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function scaleGtin(index: number): string {
  const body = `9${String(index).padStart(12, "0")}`;
  const weighted = [...body].reverse().reduce(
    (sum, digit, digitIndex) => sum + Number(digit) * (digitIndex % 2 === 0 ? 3 : 1),
    0,
  );
  return `${body}${(10 - (weighted % 10)) % 10}`;
}
