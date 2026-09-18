import type { PgQueryExecutor } from "./postgres/queryBuilder.js";
import type { CatalogSkuEnvelopeSupabaseClient } from "./supabase/catalogSkuEnvelope.js";

// One formula for "per 100 g scaled by net weight", re-exported beside the energy it scales so a
// reader of document energy never writes a second rounding rule. The quote port owns the original.
export { catalogEnergyPerUnit } from "../domains/commerce/dbBackedCommerceQuoteHelpers.js";

const PRODUCT_COLUMNS = "id, slug, status, current_document_revision_id";
const REVISION_COLUMNS = "id, product_id, revision_no, schema_id, document_payload, digest";
const CURRENT_DOCUMENTS_SQL = `SELECT product.id AS product_id, product.slug AS product_slug,
    product.status AS product_status, product.current_document_revision_id,
    revision.id AS revision_id, revision.product_id AS revision_product_id,
    revision.revision_no AS revision_no, revision.schema_id AS revision_schema_id,
    revision.document_payload AS revision_document_payload, revision.digest AS revision_digest
  FROM public.catalog_products AS product
  LEFT JOIN public.catalog_product_document_revisions AS revision
    ON revision.id = product.current_document_revision_id
   AND revision.product_id = product.id
  WHERE product.id = ANY($1::uuid[])`;

export type CurrentDocumentPayloadRefusalCode = "catalog_authority_changed" | "catalog_revision_invalid";

export class CurrentDocumentPayloadReadError extends Error {
  constructor(readonly code: CurrentDocumentPayloadRefusalCode) {
    super(code);
    this.name = "CurrentDocumentPayloadReadError";
  }
}

export interface CurrentDocumentCondition {
  productId: string;
  slug: string;
  currentDocumentRevisionId: string;
}

export interface CurrentDocumentAuthority {
  product: { id: string; slug: string; status: unknown; currentDocumentRevisionId: unknown };
  revision: { id: unknown; productId: unknown; revisionNo: unknown; schemaId: unknown; document: unknown; digest: unknown } | null;
}

export interface CurrentDocumentPayloadReadPort {
  readCurrentDocument(condition: CurrentDocumentCondition): Promise<CurrentDocumentAuthority>;
  /**
   * Reads a bounded page of document pointers in a fixed number of queries.
   * Each returned entry corresponds to the condition at the same index; every
   * product/slug/current-pointer match remains guarded before it is returned.
   */
  readCurrentDocuments(
    conditions: readonly CurrentDocumentCondition[],
  ): Promise<readonly CurrentDocumentAuthority[]>;
}

interface QueryResult<T> { data: T[] | null; error: { message?: string } | null }

interface Query<T> extends PromiseLike<QueryResult<T>> {
  select(columns: string): Query<T>;
  eq(column: string, value: unknown): Query<T>;
  in(column: string, values: readonly unknown[]): Query<T>;
  limit(count: number): Query<T>;
}

interface SupabaseCurrentDocumentClient {
  from(table: "catalog_products"): Query<SupabaseProductRow>;
  from(table: "catalog_product_document_revisions"): Query<SupabaseRevisionRow>;
}

interface SupabaseProductRow { id: unknown; slug: unknown; status: unknown; current_document_revision_id: unknown }
interface SupabaseRevisionRow { id: unknown; product_id: unknown; revision_no: unknown; schema_id: unknown; document_payload: unknown; digest: unknown }

/** Revision is immutable; the guarded product query is this adapter's linearization point. */
export function createSupabaseCurrentDocumentPayloadReadPort(
  client: CatalogSkuEnvelopeSupabaseClient,
): CurrentDocumentPayloadReadPort {
  const payloadClient = client as unknown as SupabaseCurrentDocumentClient;
  const readCurrentDocuments = async (
    conditions: readonly CurrentDocumentCondition[],
  ): Promise<readonly CurrentDocumentAuthority[]> => {
    if (conditions.length === 0) return [];
    const productIds = [...new Set(conditions.map((condition) => condition.productId))];
    const revisionIds = [...new Set(conditions.map((condition) => condition.currentDocumentRevisionId))];
    const [revisions, products] = await Promise.all([
      readSupabaseRows(
        payloadClient.from("catalog_product_document_revisions")
          .select(REVISION_COLUMNS)
          .in("id", revisionIds),
      ),
      readSupabaseRows(
        payloadClient.from("catalog_products")
          .select(PRODUCT_COLUMNS)
          .in("id", productIds),
      ),
    ]);
    return conditions.map((condition) => authorityForSupabase(condition, products, revisions));
  };
  return {
    async readCurrentDocument(condition: CurrentDocumentCondition): Promise<CurrentDocumentAuthority> {
      const [authority] = await readCurrentDocuments([condition]);
      if (!authority) throw new CurrentDocumentPayloadReadError("catalog_revision_invalid");
      return authority;
    },

    readCurrentDocuments,
  };
}

export function createPostgresCurrentDocumentPayloadReadPort(
  executor: PgQueryExecutor,
): CurrentDocumentPayloadReadPort {
  const readCurrentDocuments = async (
    conditions: readonly CurrentDocumentCondition[],
  ): Promise<readonly CurrentDocumentAuthority[]> => {
    if (conditions.length === 0) return [];
    const productIds = [...new Set(conditions.map((condition) => condition.productId))];
    const { rows } = await executor.query(CURRENT_DOCUMENTS_SQL, [productIds]);
    return conditions.map((condition) => authorityForPostgres(
      condition,
      rows as unknown as readonly CurrentDocumentRow[],
    ));
  };
  return {
    async readCurrentDocument(condition: CurrentDocumentCondition): Promise<CurrentDocumentAuthority> {
      const [authority] = await readCurrentDocuments([condition]);
      if (!authority) throw new CurrentDocumentPayloadReadError("catalog_revision_invalid");
      return authority;
    },

    readCurrentDocuments,
  };
}

interface CurrentDocumentRow {
  product_id: unknown;
  product_slug: unknown;
  product_status: unknown;
  current_document_revision_id: unknown;
  revision_id: unknown;
  revision_product_id: unknown;
  revision_no: unknown;
  revision_schema_id: unknown;
  revision_document_payload: unknown;
  revision_digest: unknown;
}

function authorityForSupabase(
  condition: CurrentDocumentCondition,
  productRows: readonly SupabaseProductRow[],
  revisionRows: readonly SupabaseRevisionRow[],
): CurrentDocumentAuthority {
  const products = productRows.filter((row) => row.id === condition.productId);
  if (products.length === 0) throw new CurrentDocumentPayloadReadError("catalog_authority_changed");
  if (products.length !== 1) throw new CurrentDocumentPayloadReadError("catalog_revision_invalid");
  const product = products[0]!;
  if (
    product.slug !== condition.slug
    || product.current_document_revision_id !== condition.currentDocumentRevisionId
  ) {
    throw new CurrentDocumentPayloadReadError("catalog_authority_changed");
  }
  const revision = uniqueRevision(revisionRows, condition);
  return {
    product: {
      id: requiredString(product.id),
      slug: requiredString(product.slug),
      status: product.status,
      currentDocumentRevisionId: requiredString(product.current_document_revision_id),
    },
    revision,
  };
}

function authorityForPostgres(
  condition: CurrentDocumentCondition,
  rows: readonly CurrentDocumentRow[],
): CurrentDocumentAuthority {
  const products = rows.filter((row) => row.product_id === condition.productId);
  if (products.length === 0) throw new CurrentDocumentPayloadReadError("catalog_authority_changed");
  if (products.length !== 1) throw new CurrentDocumentPayloadReadError("catalog_revision_invalid");
  const product = products[0]!;
  if (
    product.product_slug !== condition.slug
    || product.current_document_revision_id !== condition.currentDocumentRevisionId
  ) {
    throw new CurrentDocumentPayloadReadError("catalog_authority_changed");
  }
  return {
    product: {
      id: requiredString(product.product_id),
      slug: requiredString(product.product_slug),
      status: product.product_status,
      currentDocumentRevisionId: requiredString(product.current_document_revision_id),
    },
    revision: revisionFromJoinedRow(product),
  };
}

function uniqueRevision(
  revisions: readonly SupabaseRevisionRow[],
  condition: CurrentDocumentCondition,
): CurrentDocumentAuthority["revision"] {
  const matched = revisions.filter((revision) => (
    revision.id === condition.currentDocumentRevisionId
    && revision.product_id === condition.productId
  ));
  if (matched.length !== 1) throw new CurrentDocumentPayloadReadError("catalog_revision_invalid");
  return revisionAuthority(matched[0]!);
}

function revisionFromJoinedRow(row: CurrentDocumentRow): CurrentDocumentAuthority["revision"] {
  if (row.revision_id === null || row.revision_id === undefined) return null;
  return {
    id: row.revision_id,
    productId: row.revision_product_id,
    revisionNo: row.revision_no,
    schemaId: row.revision_schema_id,
    document: row.revision_document_payload,
    digest: row.revision_digest,
  };
}

function revisionAuthority(revision: SupabaseRevisionRow): NonNullable<CurrentDocumentAuthority["revision"]> {
  return {
    id: revision.id,
    productId: revision.product_id,
    revisionNo: revision.revision_no,
    schemaId: revision.schema_id,
    document: revision.document_payload,
    digest: revision.digest,
  };
}

/**
 * Energy per 100 g off a current-document payload, or `null`.
 *
 * The published document is the ONE energy authority: `energy.unscaled` at scale
 * 0 in the per-100 g unit, the same field the storefront projection reads
 * (`publicCatalogProjection.ts`, `storefrontProductProjectionSupport.ts`). A
 * consumer needing a per-unit figure scales it by the SKU's net weight rather
 * than reading a stored per-unit copy, because a copy is a second answer nobody
 * keeps in step. The payload stays `unknown`: this module refuses to know the
 * document's schema, which lives in the deployment overlay that
 * `server/adapters/**` does not import, so the three fields are checked by hand
 * and anything else reports `null` rather than being coerced.
 */
export function currentDocumentEnergyPer100g(authority: CurrentDocumentAuthority): number | null {
  const document = authority.revision?.document;
  if (!document || typeof document !== "object") return null;
  const energy = (document as { energy?: unknown }).energy;
  if (!energy || typeof energy !== "object") return null;
  const { unscaled, scale, unit } = energy as { unscaled?: unknown; scale?: unknown; unit?: unknown };
  if (unit !== "KCAL_PER_100G" || scale !== 0) return null;
  return typeof unscaled === "number" && Number.isInteger(unscaled) && unscaled > 0 ? unscaled : null;
}

/**
 * The current document's energy for one product, guarded by the same pointer
 * check every other reader of this port passes.
 *
 * It takes the `catalog_products` row as selected, rather than a camel-cased
 * projection of it, because that is what a caller of this module actually holds
 * and a second spelling of `current_document_revision_id` buys nothing.
 *
 * A product carrying no pointer never reaches the port, and a pointer that moved
 * under us (`catalog_authority_changed`) or a revision that will not resolve
 * (`catalog_revision_invalid`) both report `null` rather than failing the
 * caller's read: this serves an admin projection's energy field, not the money
 * path, so an unreadable authority is "unknown" and never "the old number".
 * A caller that must not proceed without a document uses the port directly.
 */
export async function readProductEnergyPer100g(
  client: CatalogSkuEnvelopeSupabaseClient,
  product: { id: string; slug: string; current_document_revision_id: string | null },
): Promise<number | null> {
  if (!product.current_document_revision_id) return null;
  try {
    return currentDocumentEnergyPer100g(
      await createSupabaseCurrentDocumentPayloadReadPort(client).readCurrentDocument({
        productId: product.id,
        slug: product.slug,
        currentDocumentRevisionId: product.current_document_revision_id,
      }),
    );
  } catch (error) {
    if (error instanceof CurrentDocumentPayloadReadError) return null;
    throw error;
  }
}

async function readSupabaseRows<T>(request: PromiseLike<QueryResult<T>>): Promise<T[]> {
  const { data, error } = await request;
  if (error) throw new Error(error.message ?? "catalog storefront document read failed");
  return data ?? [];
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CurrentDocumentPayloadReadError("catalog_revision_invalid");
  }
  return value;
}
