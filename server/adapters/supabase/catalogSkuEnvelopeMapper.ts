import {
  CATALOG_FOUNDATION_CONTRACT_VERSION,
  CatalogSkuAuthorityError,
  assertPrimaryUnitGtinAuthority,
  neutralSkuEnvelopeV1Schema,
  type CatalogSkuIdentifier,
  type NeutralSkuEnvelopeV1,
} from "../../../src/domains/catalog/catalogFoundationContracts.js";

export interface SupabaseCatalogSkuEnvelopeSkuRow {
  id: string;
  product_id: string;
  sku: string;
  net_weight_g: number;
  status: "draft" | "active" | "archived";
  sellable_standalone: boolean;
  sellable_in_subscription: boolean;
  is_addon: boolean;
  asset_ref: string | null;
}

export interface SupabaseCatalogSkuEnvelopeProductRow {
  id: string;
  slug: string;
  primary_sku_id: string | null;
  current_document_revision_id: string | null;
}

export interface SupabaseCatalogSkuEnvelopeRevisionRow {
  id: string;
  product_id: string;
  revision_no: number;
  schema_id: string;
  document_ref: string;
  source_ref: string;
  digest: string;
}

export interface SupabaseCatalogSkuEnvelopeEanRow {
  catalog_sku_id: string;
  ean: string;
  kind: "unit" | "collective";
  quantity: number;
  is_primary: boolean;
}

export function groupSupabaseCatalogSkuIdentifiers(
  rows: readonly SupabaseCatalogSkuEnvelopeEanRow[],
): Map<string, CatalogSkuIdentifier[]> {
  const grouped = new Map<string, CatalogSkuIdentifier[]>();
  for (const row of rows) {
    const identifiers = grouped.get(row.catalog_sku_id) ?? [];
    identifiers.push({
      issuer: "gs1",
      normalizedValue: row.ean,
      kind: "gtin",
      packKind: row.kind,
      packQuantity: row.quantity,
      isPrimary: row.is_primary,
    });
    grouped.set(row.catalog_sku_id, identifiers);
  }
  return grouped;
}

export function mapSupabaseCatalogSkuEnvelope(
  sku: SupabaseCatalogSkuEnvelopeSkuRow,
  product: SupabaseCatalogSkuEnvelopeProductRow,
  revision: SupabaseCatalogSkuEnvelopeRevisionRow,
  identifiers: CatalogSkuIdentifier[],
): NeutralSkuEnvelopeV1 {
  if (!product.primary_sku_id) {
    throw new CatalogSkuAuthorityError("catalog_sku_authority_primary_sku_invalid");
  }
  assertPrimaryUnitGtinAuthority(identifiers);
  return neutralSkuEnvelopeV1Schema.parse({
    contractVersion: CATALOG_FOUNDATION_CONTRACT_VERSION,
    product: { id: product.id, slug: product.slug, primarySkuId: product.primary_sku_id },
    sku: {
      id: sku.id,
      productId: sku.product_id,
      code: sku.sku,
      netContent: { unscaled: sku.net_weight_g, scale: 0, unit: "GRAM" },
      sellability: {
        status: sku.status,
        oneTime: sku.sellable_standalone,
        subscription: sku.sellable_in_subscription,
      },
      isAddon: sku.is_addon,
      assetRef: sku.asset_ref,
    },
    documentRevision: {
      id: revision.id,
      productId: revision.product_id,
      revisionNo: revision.revision_no,
      schemaId: revision.schema_id,
      documentRef: revision.document_ref,
      sourceRef: revision.source_ref,
      digest: revision.digest,
    },
    identifiers,
  });
}
