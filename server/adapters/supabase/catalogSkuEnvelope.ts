import {
  CatalogSkuAuthorityError,
  catalogSkuEnvelopeSelectorSchema,
  requireCurrentCatalogDocumentAuthority,
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
import {
  groupSupabaseCatalogSkuIdentifiers,
  mapSupabaseCatalogSkuEnvelope,
  type SupabaseCatalogSkuEnvelopeEanRow,
  type SupabaseCatalogSkuEnvelopeProductRow,
  type SupabaseCatalogSkuEnvelopeRevisionRow,
  type SupabaseCatalogSkuEnvelopeSkuRow,
} from "./catalogSkuEnvelopeMapper.js";

const SKU_COLUMNS = "id, product_id, sku, net_weight_g, status, sellable_standalone, sellable_in_subscription, is_addon, asset_ref";
const PRODUCT_COLUMNS = "id, slug, primary_sku_id, current_document_revision_id";
const REVISION_COLUMNS = "id, product_id, revision_no, schema_id, document_ref, source_ref, digest";
const EAN_COLUMNS = "catalog_sku_id, ean, kind, quantity, is_primary";
interface QueryResult<T> { data: T[] | null; error: { message?: string } | null }

interface Query<T> extends PromiseLike<QueryResult<T>> {
  select(columns: string): Query<T>; eq(column: string, value: unknown): Query<T>;
  or(filters: string): Query<T>;
  gt(column: string, value: unknown): Query<T>; in(column: string, values: readonly unknown[]): Query<T>;
  order(column: string, options: { ascending: boolean }): Query<T>; limit(count: number): Query<T>;
}

export interface CatalogSkuEnvelopeSupabaseClient {
  from<T extends CatalogSkuEnvelopeTable>(table: T): Query<CatalogSkuEnvelopeRowByTable[T]>;
}

type CatalogSkuEnvelopeTable = "catalog_skus" | "catalog_products" | "catalog_product_document_revisions" | "catalog_sku_eans";

interface CatalogSkuEnvelopeRowByTable {
  catalog_skus: SkuRow; catalog_products: ProductRow;
  catalog_product_document_revisions: RevisionRow; catalog_sku_eans: EanRow;
}

type SkuRow = SupabaseCatalogSkuEnvelopeSkuRow;
type ProductRow = SupabaseCatalogSkuEnvelopeProductRow;
type RevisionRow = SupabaseCatalogSkuEnvelopeRevisionRow;
type EanRow = SupabaseCatalogSkuEnvelopeEanRow;

/** Inert managed reader: it never selects document payloads or dormant SKU GTINs. */
export function createSupabaseCatalogSkuEnvelopeReadPort(
  client: CatalogSkuEnvelopeSupabaseClient,
): PublicCatalogSkuEnvelopeReadPort {
  return {
    async listSkuEnvelopes(query: CatalogSkuEnvelopeListQuery): Promise<CatalogSkuEnvelopePage> {
      return listEnvelopes(client, query);
    },

    async listActiveSkuEnvelopes(query: CatalogActiveSkuEnvelopeListQuery): Promise<CatalogSkuEnvelopePage> {
      const skuCodes = parseCatalogActiveSkuSelection(query.skuCodes);
      return listEnvelopes(client, query, { activeOnly: true, sellableOnly: true, skuCodes });
    },

    async listPublicActiveSkuEnvelopes(query: CatalogSkuEnvelopeListQuery): Promise<CatalogSkuEnvelopePage> {
      return listEnvelopes(client, query, { activeOnly: true });
    },

    async listPublicActiveProductSkuEnvelopes(
      productId: string,
      query: CatalogSkuEnvelopeListQuery,
    ): Promise<CatalogSkuEnvelopePage> {
      return listEnvelopes(client, query, { activeOnly: true, productId });
    },

    async getSkuEnvelope(selector: CatalogSkuEnvelopeSelector): Promise<NeutralSkuEnvelopeV1 | null> {
      const parsed = catalogSkuEnvelopeSelectorSchema.parse(selector);
      if (parsed.kind === "sku_code") {
        const sku = await readUnique(
          client.from("catalog_skus").select(SKU_COLUMNS).eq("sku", parsed.skuCode).limit(2),
          "catalog_sku_envelope_sku_read_failed",
          "catalog_sku_authority_sku_absent",
        );
        return envelopeForSku(client, sku);
      }

      const product = await readUnique(
        client.from("catalog_products").select(PRODUCT_COLUMNS).eq("slug", parsed.productSlug).limit(2),
        "catalog_sku_envelope_product_read_failed",
        "catalog_sku_authority_product_absent",
      );
      if (!product.primary_sku_id) {
        throw new CatalogSkuAuthorityError("catalog_sku_authority_primary_sku_invalid");
      }
      const primarySku = await readUnique(
        client.from("catalog_skus").select(SKU_COLUMNS).eq("id", product.primary_sku_id).limit(2),
        "catalog_sku_envelope_sku_read_failed",
        "catalog_sku_authority_primary_sku_invalid",
      );
      if (primarySku.product_id !== product.id) {
        throw new CatalogSkuAuthorityError("catalog_sku_authority_primary_sku_invalid");
      }
      return envelopeForKnownProduct(client, primarySku, product);
    },

    async getSkuEnvelopeById(skuId: string): Promise<NeutralSkuEnvelopeV1 | null> {
      const sku = await readUnique(
        client.from("catalog_skus").select(SKU_COLUMNS).eq("id", skuId).limit(2),
        "catalog_sku_envelope_sku_read_failed",
        "catalog_sku_authority_sku_absent",
      );
      return envelopeForSku(client, sku);
    },
  };
}

async function listEnvelopes(
  client: CatalogSkuEnvelopeSupabaseClient,
  query: CatalogSkuEnvelopeListQuery,
  options: { activeOnly?: boolean; sellableOnly?: boolean; productId?: string; skuCodes?: readonly string[] } = {},
): Promise<CatalogSkuEnvelopePage> {
  const limit = checkedLimit(query.limit);
  let request = client.from("catalog_skus")
    .select(SKU_COLUMNS)
    .order("id", { ascending: true });
  if (options.activeOnly) request = request.eq("status", "active");
  if (options.sellableOnly) request = request.or("sellable_standalone.eq.true,sellable_in_subscription.eq.true");
  if (options.skuCodes) request = request.in("sku", options.skuCodes);
  if (options.productId) request = request.eq("product_id", options.productId);
  if (query.cursor) request = request.gt("id", query.cursor);
  const skuRows = await read(request.limit(limit + 1), "catalog_sku_envelope_skus_read_failed");
  const sourcePageRows = skuRows.slice(0, limit);
  const items = await envelopesFor(client, sourcePageRows);
  return {
    items,
    nextCursor: skuRows.length > limit ? sourcePageRows[sourcePageRows.length - 1]?.id ?? null : null,
  };
}

async function readUnique<T>(
  request: PromiseLike<QueryResult<T>>,
  failure: string,
  absent: CatalogSkuAuthorityError["code"],
): Promise<T> {
  const rows = await read(request, failure);
  if (rows.length === 0) throw new CatalogSkuAuthorityError(absent);
  if (rows.length !== 1) {
    throw new CatalogSkuAuthorityError("catalog_sku_authority_selector_ambiguous");
  }
  return rows[0]!;
}

async function envelopeForSku(
  client: CatalogSkuEnvelopeSupabaseClient,
  sku: SkuRow,
): Promise<NeutralSkuEnvelopeV1> {
  const product = await readUnique(
    client.from("catalog_products").select(PRODUCT_COLUMNS).eq("id", sku.product_id).limit(2),
    "catalog_sku_envelope_products_read_failed",
    "catalog_sku_authority_current_document_invalid",
  );
  return envelopeForKnownProduct(client, sku, product);
}

async function envelopeForKnownProduct(
  client: CatalogSkuEnvelopeSupabaseClient,
  sku: SkuRow,
  product: ProductRow,
): Promise<NeutralSkuEnvelopeV1> {
  if (sku.product_id !== product.id) {
    throw new CatalogSkuAuthorityError("catalog_sku_authority_primary_sku_invalid");
  }
  const [revisions, eans] = await Promise.all([
    product.current_document_revision_id
      ? read(
        client.from("catalog_product_document_revisions")
          .select(REVISION_COLUMNS)
          .eq("id", product.current_document_revision_id)
          .limit(2),
        "catalog_sku_envelope_revisions_read_failed",
      )
      : Promise.resolve([] as RevisionRow[]),
    read(
      client.from("catalog_sku_eans")
        .select(EAN_COLUMNS)
        .eq("catalog_sku_id", sku.id)
        .order("is_primary", { ascending: false })
        .order("ean", { ascending: true }),
      "catalog_sku_envelope_eans_read_failed",
    ),
  ]);
  const revision = requireCurrentCatalogDocumentAuthority(
    product.id,
    product.current_document_revision_id,
    revisions[0] && { id: revisions[0].id, productId: revisions[0].product_id },
  );
  if (revisions.length !== 1 || !revision) {
    throw new CatalogSkuAuthorityError("catalog_sku_authority_current_document_invalid");
  }
  return mapSupabaseCatalogSkuEnvelope(
    sku,
    product,
    revisions[0]!,
    groupSupabaseCatalogSkuIdentifiers(eans).get(sku.id) ?? [],
  );
}

async function envelopesFor(
  client: CatalogSkuEnvelopeSupabaseClient,
  skuRows: readonly SkuRow[],
): Promise<NeutralSkuEnvelopeV1[]> {
  if (skuRows.length === 0) return [];

  const productIds = [...new Set(skuRows.map((row) => row.product_id))];
  const products = await read(
    client.from("catalog_products").select(PRODUCT_COLUMNS).in("id", productIds),
    "catalog_sku_envelope_products_read_failed",
  );
  const productsById = new Map(products.map((row) => [row.id, row]));
  const revisionIds = [...new Set(products.flatMap((row) => row.current_document_revision_id ? [row.current_document_revision_id] : []))];
  const [revisions, eans] = await Promise.all([
    revisionIds.length === 0
      ? Promise.resolve([] as RevisionRow[])
      : read(
        client.from("catalog_product_document_revisions").select(REVISION_COLUMNS).in("id", revisionIds),
        "catalog_sku_envelope_revisions_read_failed",
      ),
    read(
      client.from("catalog_sku_eans")
        .select(EAN_COLUMNS)
        .in("catalog_sku_id", skuRows.map((row) => row.id))
        .order("catalog_sku_id", { ascending: true })
        .order("is_primary", { ascending: false })
        .order("ean", { ascending: true }),
      "catalog_sku_envelope_eans_read_failed",
    ),
  ]);
  const revisionsById = new Map(revisions.map((row) => [row.id, row]));
  const identifiersBySkuId = groupSupabaseCatalogSkuIdentifiers(eans);

  return skuRows.map((sku) => {
    const product = productsById.get(sku.product_id);
    if (!product) {
      throw new CatalogSkuAuthorityError("catalog_sku_authority_current_document_invalid");
    }
    const rawRevision = product.current_document_revision_id
      ? revisionsById.get(product.current_document_revision_id)
      : undefined;
    requireCurrentCatalogDocumentAuthority(
      product.id,
      product.current_document_revision_id,
      rawRevision && { id: rawRevision.id, productId: rawRevision.product_id },
    );
    if (!rawRevision) throw new CatalogSkuAuthorityError("catalog_sku_authority_current_document_invalid");
    return mapSupabaseCatalogSkuEnvelope(sku, product, rawRevision, identifiersBySkuId.get(sku.id) ?? []);
  });
}

async function read<T>(request: PromiseLike<QueryResult<T>>, failure: string): Promise<T[]> {
  const { data, error } = await request;
  if (error) throw new Error(error.message ?? failure);
  return data ?? [];
}

function checkedLimit(limit: number): number {
  const invalid = !Number.isSafeInteger(limit) || limit < 1 || limit > 500;
  if (invalid) throw new RangeError("catalog_sku_envelope_invalid_limit");
  return limit;
}
