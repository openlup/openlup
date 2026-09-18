import {
  CatalogSkuAuthorityError,
  catalogSkuEnvelopeSelectorSchema,
  type CatalogSkuEnvelopeSelector,
  type NeutralSkuEnvelopeV1,
} from "../../../src/domains/catalog/catalogFoundationContracts.js";
import { parseCatalogActiveSkuSelection } from "../../../src/domains/catalog/catalogActiveSkuSelection.js";
import type {
  CatalogActiveSkuEnvelopeListQuery,
  CatalogSkuEnvelopeListQuery,
  CatalogSkuEnvelopePage,
  PublicCatalogSkuEnvelopeReadPort,
} from "../../../src/domains/catalog/ports.js";
import type { PgQueryExecutor } from "./queryBuilder.js";
import {
  mapPostgresCatalogSkuEnvelope,
  readPostgresCatalogSkuIdentifiers,
  requirePostgresCatalogSkuEnvelopeRow,
  type PostgresCatalogSkuEnvelopeRow,
} from "./catalogSkuEnvelopeMapper.js";

const ENVELOPE_COLUMNS_SQL = `
    product.id AS product_id,
    product.slug AS product_slug,
    product.primary_sku_id,
    product.current_document_revision_id,
    sku.id AS sku_id,
    sku.product_id AS sku_product_id,
    sku.sku AS sku_code,
    sku.net_weight_g AS net_content_unscaled,
    sku.status AS sku_status,
    sku.sellable_standalone AS sellable_one_time,
    sku.sellable_in_subscription AS sellable_subscription,
    sku.is_addon,
    sku.asset_ref,
    revision.id AS document_revision_id,
    revision.product_id AS document_product_id,
    revision.revision_no AS document_revision_no,
    revision.schema_id AS document_schema_id,
    revision.document_ref AS document_ref,
    revision.source_ref AS document_source_ref,
    revision.digest AS document_digest`;

const SKU_ENVELOPE_FROM_SQL = `
  SELECT ${ENVELOPE_COLUMNS_SQL}
  FROM public.catalog_skus AS sku
  JOIN public.catalog_products AS product
    ON product.id = sku.product_id
  LEFT JOIN public.catalog_product_document_revisions AS revision
    ON revision.id = product.current_document_revision_id`;

const LIST_ENVELOPES_SQL = `${SKU_ENVELOPE_FROM_SQL}
  WHERE ($1::uuid IS NULL OR sku.id > $1::uuid)
  ORDER BY sku.id
  LIMIT $2::integer`;

const LIST_ACTIVE_ENVELOPES_SQL = `${SKU_ENVELOPE_FROM_SQL}
  WHERE sku.status = 'active'
    AND (sku.sellable_standalone OR sku.sellable_in_subscription)
    AND ($3::text[] IS NULL OR sku.sku = ANY($3::text[]))
    AND ($1::uuid IS NULL OR sku.id > $1::uuid)
  ORDER BY sku.id
  LIMIT $2::integer`;

const LIST_PUBLIC_ACTIVE_ENVELOPES_SQL = `${SKU_ENVELOPE_FROM_SQL}
  WHERE sku.status = 'active'
    AND ($1::uuid IS NULL OR sku.id > $1::uuid)
  ORDER BY sku.id
  LIMIT $2::integer`;

const LIST_PUBLIC_ACTIVE_PRODUCT_ENVELOPES_SQL = `${SKU_ENVELOPE_FROM_SQL}
  WHERE sku.product_id = $1::uuid
    AND sku.status = 'active'
    AND ($2::uuid IS NULL OR sku.id > $2::uuid)
  ORDER BY sku.id
  LIMIT $3::integer`;

const DETAIL_ENVELOPE_BY_ID_SQL = `${SKU_ENVELOPE_FROM_SQL}
  WHERE sku.id = $1::uuid`;

const DETAIL_ENVELOPE_BY_SKU_CODE_SQL = `${SKU_ENVELOPE_FROM_SQL}
  WHERE sku.sku = $1
  LIMIT 2`;

const DETAIL_ENVELOPE_BY_PRIMARY_PRODUCT_SLUG_SQL = `
  SELECT ${ENVELOPE_COLUMNS_SQL}
  FROM public.catalog_products AS product
  LEFT JOIN public.catalog_skus AS sku
    ON sku.id = product.primary_sku_id
  LEFT JOIN public.catalog_product_document_revisions AS revision
    ON revision.id = product.current_document_revision_id
  WHERE product.slug = $1
  LIMIT 2`;

/**
 * Portable W2a envelope reader. It reads only product/SKU/revision references
 * and neutral identifiers; application document content never crosses this seam.
 */
export function createPostgresCatalogSkuEnvelopeReadPort(
  executor: PgQueryExecutor,
): PublicCatalogSkuEnvelopeReadPort {
  return {
    async listSkuEnvelopes(query: CatalogSkuEnvelopeListQuery): Promise<CatalogSkuEnvelopePage> {
      return listEnvelopes(executor, query, LIST_ENVELOPES_SQL);
    },

    async listActiveSkuEnvelopes(query: CatalogActiveSkuEnvelopeListQuery): Promise<CatalogSkuEnvelopePage> {
      const skuCodes = parseCatalogActiveSkuSelection(query.skuCodes);
      return listEnvelopes(executor, query, LIST_ACTIVE_ENVELOPES_SQL, [], [skuCodes ?? null]);
    },

    async listPublicActiveSkuEnvelopes(query: CatalogSkuEnvelopeListQuery): Promise<CatalogSkuEnvelopePage> {
      return listEnvelopes(executor, query, LIST_PUBLIC_ACTIVE_ENVELOPES_SQL);
    },

    async listPublicActiveProductSkuEnvelopes(
      productId: string,
      query: CatalogSkuEnvelopeListQuery,
    ): Promise<CatalogSkuEnvelopePage> {
      return listEnvelopes(executor, query, LIST_PUBLIC_ACTIVE_PRODUCT_ENVELOPES_SQL, [productId]);
    },

    async getSkuEnvelope(selector: CatalogSkuEnvelopeSelector): Promise<NeutralSkuEnvelopeV1 | null> {
      const parsed = catalogSkuEnvelopeSelectorSchema.parse(selector);
      const rows = await readRows(
        executor,
        parsed.kind === "sku_code"
          ? DETAIL_ENVELOPE_BY_SKU_CODE_SQL
          : DETAIL_ENVELOPE_BY_PRIMARY_PRODUCT_SLUG_SQL,
        [parsed.kind === "sku_code" ? parsed.skuCode : parsed.productSlug],
      );
      const row = uniqueDetailRow(
        rows,
        parsed.kind === "sku_code"
          ? "catalog_sku_authority_sku_absent"
          : "catalog_sku_authority_product_absent",
      );
      requirePostgresCatalogSkuEnvelopeRow(
        row,
        parsed.kind === "primary_product_slug"
          ? "catalog_sku_authority_primary_sku_invalid"
          : "catalog_sku_authority_current_document_invalid",
      );
      if (
        parsed.kind === "primary_product_slug"
        && (row.primary_sku_id !== row.sku_id || row.product_id !== row.sku_product_id)
      ) {
        throw new CatalogSkuAuthorityError("catalog_sku_authority_primary_sku_invalid");
      }
      const identifiers = await readPostgresCatalogSkuIdentifiers(executor, [row.sku_id]);
      return mapPostgresCatalogSkuEnvelope(row, identifiers.get(row.sku_id) ?? []);
    },

    async getSkuEnvelopeById(skuId: string): Promise<NeutralSkuEnvelopeV1 | null> {
      const row = uniqueDetailRow(
        await readRows(executor, DETAIL_ENVELOPE_BY_ID_SQL, [skuId]),
        "catalog_sku_authority_sku_absent",
      );
      requirePostgresCatalogSkuEnvelopeRow(row, "catalog_sku_authority_current_document_invalid");
      const identifiers = await readPostgresCatalogSkuIdentifiers(executor, [row.sku_id]);
      return mapPostgresCatalogSkuEnvelope(row, identifiers.get(row.sku_id) ?? []);
    },
  };
}

async function listEnvelopes(
  executor: PgQueryExecutor,
  query: CatalogSkuEnvelopeListQuery,
  sql: string,
  prefixValues: unknown[] = [],
  suffixValues: unknown[] = [],
): Promise<CatalogSkuEnvelopePage> {
  const rows = await readRows(
    executor,
    sql,
    [...prefixValues, query.cursor, checkedLimit(query.limit) + 1, ...suffixValues],
  );
  const pageRows = rows.slice(0, query.limit).map((row) => {
    requirePostgresCatalogSkuEnvelopeRow(row, "catalog_sku_authority_current_document_invalid");
    return row;
  });
  const identifiers = await readPostgresCatalogSkuIdentifiers(executor, pageRows.map((row) => row.sku_id));
  return {
    items: pageRows.map((row) => mapPostgresCatalogSkuEnvelope(row, identifiers.get(row.sku_id) ?? [])),
    nextCursor: rows.length > query.limit ? pageRows[pageRows.length - 1]?.sku_id ?? null : null,
  };
}

function uniqueDetailRow(
  rows: readonly PostgresCatalogSkuEnvelopeRow[],
  absent: CatalogSkuAuthorityError["code"],
): PostgresCatalogSkuEnvelopeRow {
  if (rows.length === 0) throw new CatalogSkuAuthorityError(absent);
  if (rows.length !== 1) {
    throw new CatalogSkuAuthorityError("catalog_sku_authority_selector_ambiguous");
  }
  return rows[0]!;
}

async function readRows(
  executor: PgQueryExecutor,
  sql: string,
  values: unknown[],
): Promise<PostgresCatalogSkuEnvelopeRow[]> {
  const { rows } = await executor.query(sql, values);
  return rows as unknown as PostgresCatalogSkuEnvelopeRow[];
}

function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("catalog_sku_envelope_invalid_limit");
  }
  return limit;
}
