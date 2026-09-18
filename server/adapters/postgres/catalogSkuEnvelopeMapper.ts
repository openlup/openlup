import {
  CATALOG_FOUNDATION_CONTRACT_VERSION,
  CatalogSkuAuthorityError,
  assertPrimaryUnitGtinAuthority,
  neutralSkuEnvelopeV1Schema,
  requireCurrentCatalogDocumentAuthority,
  type CatalogSkuIdentifier,
  type NeutralSkuEnvelopeV1,
} from "../../../src/domains/catalog/catalogFoundationContracts.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const IDENTIFIERS_SQL = `
  SELECT catalog_sku_id, issuer, identifier_kind, normalized_value,
    pack_kind, quantity, is_primary
  FROM public.catalog_sku_identifiers
  WHERE catalog_sku_id = ANY($1::uuid[])
  ORDER BY catalog_sku_id, identifier_kind, is_primary DESC, issuer, normalized_value`;

export interface PostgresCatalogSkuEnvelopeRow {
  product_id: string;
  product_slug: string;
  primary_sku_id: string | null;
  current_document_revision_id: string | null;
  sku_id: string | null;
  sku_product_id: string | null;
  sku_code: string | null;
  net_content_unscaled: number | null;
  sku_status: "draft" | "active" | "archived" | null;
  sellable_one_time: boolean | null;
  sellable_subscription: boolean | null;
  is_addon: boolean | null;
  asset_ref: string | null;
  document_revision_id: string | null;
  document_product_id: string | null;
  document_revision_no: number | null;
  document_schema_id: string | null;
  document_ref: string | null;
  document_source_ref: string | null;
  document_digest: string | null;
}

interface IdentifierRow {
  catalog_sku_id: string;
  issuer: string;
  identifier_kind: "gtin" | "other";
  normalized_value: string;
  pack_kind: "unit" | "collective";
  quantity: number;
  is_primary: boolean;
}

export type CompletePostgresCatalogSkuEnvelopeRow = PostgresCatalogSkuEnvelopeRow & {
  primary_sku_id: string;
  sku_id: string;
  sku_product_id: string;
  sku_code: string;
  net_content_unscaled: number;
  sku_status: "draft" | "active" | "archived";
  sellable_one_time: boolean;
  sellable_subscription: boolean;
  is_addon: boolean;
};

export function requirePostgresCatalogSkuEnvelopeRow(
  row: PostgresCatalogSkuEnvelopeRow,
  refusal: CatalogSkuAuthorityError["code"],
): asserts row is CompletePostgresCatalogSkuEnvelopeRow {
  if (!row.primary_sku_id) {
    throw new CatalogSkuAuthorityError("catalog_sku_authority_primary_sku_invalid");
  }
  if (
    !row.sku_id
    || !row.sku_product_id
    || !row.sku_code
    || row.net_content_unscaled === null
    || row.sku_status === null
    || row.sellable_one_time === null
    || row.sellable_subscription === null
    || row.is_addon === null
  ) {
    throw new CatalogSkuAuthorityError(refusal);
  }
}

export async function readPostgresCatalogSkuIdentifiers(
  executor: PgQueryExecutor,
  skuIds: string[],
): Promise<Map<string, CatalogSkuIdentifier[]>> {
  if (skuIds.length === 0) return new Map();
  const { rows } = await executor.query(IDENTIFIERS_SQL, [skuIds]);
  const grouped = new Map<string, CatalogSkuIdentifier[]>();
  for (const row of rows as unknown as IdentifierRow[]) {
    const identifiers = grouped.get(row.catalog_sku_id) ?? [];
    identifiers.push({
      issuer: row.issuer,
      normalizedValue: row.normalized_value,
      kind: row.identifier_kind,
      packKind: row.pack_kind,
      packQuantity: row.quantity,
      isPrimary: row.is_primary,
    });
    grouped.set(row.catalog_sku_id, identifiers);
  }
  return grouped;
}

export function mapPostgresCatalogSkuEnvelope(
  row: CompletePostgresCatalogSkuEnvelopeRow,
  identifiers: CatalogSkuIdentifier[],
): NeutralSkuEnvelopeV1 {
  assertPrimaryUnitGtinAuthority(identifiers);
  const revision = requireCurrentCatalogDocumentAuthority(
    row.product_id,
    row.current_document_revision_id,
    row.document_revision_id
      && row.document_product_id
      && row.document_revision_no !== null
      && row.document_schema_id
      && row.document_ref
      && row.document_source_ref
      && row.document_digest
      ? {
        id: row.document_revision_id,
        productId: row.document_product_id,
        revisionNo: row.document_revision_no,
        schemaId: row.document_schema_id,
        documentRef: row.document_ref,
        sourceRef: row.document_source_ref,
        digest: row.document_digest,
      }
      : null,
  );
  return neutralSkuEnvelopeV1Schema.parse({
    contractVersion: CATALOG_FOUNDATION_CONTRACT_VERSION,
    product: { id: row.product_id, slug: row.product_slug, primarySkuId: row.primary_sku_id },
    sku: {
      id: row.sku_id,
      productId: row.sku_product_id,
      code: row.sku_code,
      netContent: { unscaled: row.net_content_unscaled, scale: 0, unit: "GRAM" },
      sellability: {
        status: row.sku_status,
        oneTime: row.sellable_one_time,
        subscription: row.sellable_subscription,
      },
      isAddon: row.is_addon,
      assetRef: row.asset_ref,
    },
    documentRevision: {
      id: revision.id,
      productId: revision.productId,
      revisionNo: revision.revisionNo,
      schemaId: revision.schemaId,
      documentRef: revision.documentRef,
      sourceRef: revision.sourceRef,
      digest: revision.digest,
    },
    identifiers,
  });
}
