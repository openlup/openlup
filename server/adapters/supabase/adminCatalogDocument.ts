import {
  CatalogDocumentAuthorityError,
  type AdminCatalogDocumentDataPort,
  type CatalogChangeProposalSubmission,
  type CatalogDocumentAuthorityProduct,
  type CatalogDocumentAuthorityRead,
  type CatalogDocumentJsonValue,
} from "../../../src/domains/commerce/adminCatalogDocumentContracts.js";
import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import {
  createSupabaseCurrentDocumentPayloadReadPort,
  CurrentDocumentPayloadReadError,
  type CurrentDocumentCondition,
} from "../catalogCurrentDocumentPayload.js";
import type { CatalogSkuEnvelopeSupabaseClient } from "./catalogSkuEnvelope.js";

/**
 * Data access for the admin catalog DOCUMENT authority.
 *
 * It never derives a second "current" answer. The pointer is
 * `catalog_products.current_document_revision_id` and the revision facts come
 * from the same current-document port the public storefront detail route reads
 * through, so the panel and the storefront agree on `documentDigest` by
 * construction.
 *
 * NO AGGREGATE STATE DIGEST, deliberately. `catalog_publication_candidates`,
 * `_decisions` and `_events` are `REVOKE ALL ... FROM ... service_role`
 * (`supabase/migrations/20260828220001_catalog_document_publication_control.sql`),
 * and `catalog_publication_current_state()` is NOT `SECURITY DEFINER`, so it
 * would execute with the caller's privileges and hit the same revoke. Reading
 * either from this role is unreachable code, and mirroring the resolver here
 * would be a second implementation of the very authority this programme exists
 * to consolidate. Freshness is therefore anchored per product, on the revision
 * digest. W3f-d owns grant posture if an aggregate is ever actually needed.
 *
 * NO POSTGREST EMBED. `catalog_products` and `catalog_product_document_revisions`
 * carry TWO foreign keys between the same pair of tables (the composite
 * `catalog_products_current_document_revision_same_product_fkey` plus the
 * revisions table's own `product_id` reference), so any unhinted embed fails
 * with PGRST201 - and `!inner` is not a hint. Every read below is a separate
 * bounded select joined in TypeScript.
 *
 * The write path is a single call to the service-role change-proposal RPC, which
 * remains the validation authority. It reaches the proposal inbox and nothing
 * else: publish, decision and rollback are human-only acts defended by
 * `auth.uid()` and are deliberately unreachable from any service-role caller.
 */

interface QueryResult<T> { data: T[] | null; error: { message?: string } | null }

interface Query<T> extends PromiseLike<QueryResult<T>> {
  select(columns: string): Query<T>;
  eq(column: string, value: unknown): Query<T>;
  in(column: string, values: readonly unknown[]): Query<T>;
  not(column: string, operator: string, value: unknown): Query<T>;
  order(column: string): Query<T>;
  limit(count: number): Query<T>;
}

interface ProductRow {
  id: unknown; slug: unknown; status: unknown;
  primary_sku_id: unknown; current_document_revision_id: unknown;
}
interface SkuRow {
  id: unknown; sku: unknown; status: unknown; net_weight_g: unknown;
  sellable_standalone: unknown; sellable_in_subscription: unknown;
}
interface EanRow { catalog_sku_id: unknown; ean: unknown }

export interface CatalogDocumentDataClient {
  from(table: "catalog_products"): Query<ProductRow>;
  from(table: "catalog_skus"): Query<SkuRow>;
  from(table: "catalog_sku_eans"): Query<EanRow>;
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

/** Bounded read: the document scope is a product catalogue, not an event stream. */
const MAX_SCOPE_PRODUCTS = 500;
/** Roughly 3.7 KB of UUIDs per request line, comfortably inside the 8 KB cap. */
const MAX_IDS_PER_READ = 100;
const PRODUCT_COLUMNS = "id, slug, status, primary_sku_id, current_document_revision_id";
const SKU_COLUMNS = "id, sku, status, net_weight_g, sellable_standalone, sellable_in_subscription";

export function createSupabaseAdminCatalogDocumentDataPort(
  client: CatalogDocumentDataClient,
): AdminCatalogDocumentDataPort {
  const documentPort = createSupabaseCurrentDocumentPayloadReadPort(
    client as unknown as CatalogSkuEnvelopeSupabaseClient,
  );

  return {
    async readAuthority(slug?: string): Promise<CatalogDocumentAuthorityRead> {
      // Ordered before limited: an unordered page truncates non-deterministically,
      // and a slug silently dropped from the scope would surface later as a
      // misleading `catalog_document_scope_unknown` refusal.
      const products = (await rows(client.from("catalog_products")
        .select(PRODUCT_COLUMNS)
        .not("current_document_revision_id", "is", null)
        .order("slug")
        .limit(MAX_SCOPE_PRODUCTS)))
        .filter((row) => typeof row.slug === "string" && typeof row.id === "string"
          && typeof row.current_document_revision_id === "string")
        .sort((left, right) => String(left.slug).localeCompare(String(right.slug)));
      const scopeSlugs = products.map((row) => String(row.slug));

      const skuIds = products
        .map((row) => row.primary_sku_id)
        .filter((value): value is string => typeof value === "string");
      const [skus, eans] = await Promise.all([
        batched(skuIds, (page) => rows(client.from("catalog_skus").select(SKU_COLUMNS).in("id", page))),
        batched(skuIds, (page) => rows(client.from("catalog_sku_eans")
          .select("catalog_sku_id, ean")
          .in("catalog_sku_id", page)
          .eq("is_primary", true)
          .eq("kind", "unit")
          .eq("quantity", 1))),
      ]);

      const conditions: CurrentDocumentCondition[] = products.map((row) => ({
        productId: String(row.id),
        slug: String(row.slug),
        currentDocumentRevisionId: String(row.current_document_revision_id),
      }));
      let authorities;
      try {
        authorities = await documentPort.readCurrentDocuments(conditions);
      } catch (error) {
        if (error instanceof CurrentDocumentPayloadReadError) {
          throw new CatalogDocumentAuthorityError("catalog_document_authority_unavailable");
        }
        throw error;
      }
      const revisionBySlug = new Map(conditions.map((condition, index) => [
        condition.slug,
        authorities[index]?.revision ?? null,
      ]));

      const skuById = new Map(skus.map((row) => [String(row.id), row]));
      const eanBySkuId = new Map(eans.map((row) => [String(row.catalog_sku_id), row.ean]));
      const documents = new Map<string, CatalogDocumentJsonValue>();
      const projected = products.map((row): CatalogDocumentAuthorityProduct => {
        const productSlug = String(row.slug);
        const sku = typeof row.primary_sku_id === "string" ? skuById.get(row.primary_sku_id) : undefined;
        const revision = revisionBySlug.get(productSlug) ?? null;
        if (revision && revision.document !== undefined && revision.document !== null) {
          documents.set(productSlug, revision.document as CatalogDocumentJsonValue);
        }
        return {
          slug: productSlug,
          productId: String(row.id),
          productStatus: String(row.status),
          primarySkuId: typeof row.primary_sku_id === "string" ? row.primary_sku_id : null,
          skuCode: sku && typeof sku.sku === "string" ? sku.sku : null,
          skuStatus: sku && typeof sku.status === "string" ? sku.status : null,
          netContentGrams: sku && typeof sku.net_weight_g === "number" ? sku.net_weight_g : null,
          sellableStandalone: sku && typeof sku.sellable_standalone === "boolean" ? sku.sellable_standalone : null,
          sellableInSubscription: sku && typeof sku.sellable_in_subscription === "boolean"
            ? sku.sellable_in_subscription
            : null,
          primaryTradeItemRef: typeof row.primary_sku_id === "string"
            ? stringOrNull(eanBySkuId.get(row.primary_sku_id))
            : null,
          documentRevisionId: revision ? stringOrNull(revision.id) : null,
          revisionNo: revision && typeof revision.revisionNo === "number" ? revision.revisionNo : null,
          documentSchemaId: revision ? stringOrNull(revision.schemaId) : null,
          documentDigest: revision ? stringOrNull(revision.digest) : null,
        };
      });

      const selected = slug ? projected.filter((product) => product.slug === slug) : projected;
      return { scopeSlugs, products: selected, documents };
    },

    async submitChangeProposal(
      canonicalText: string,
      envelopeSha256: string,
    ): Promise<CatalogChangeProposalSubmission> {
      const { data, error } = await client.rpc("catalog_submit_change_proposal", {
        p_canonical_text: canonicalText,
        p_envelope_sha256: envelopeSha256,
      });
      if (error) throw new DomainRpcError(error.code, error.message ?? "catalog_proposal_submit_failed");
      const submitted = data;
      const row = Array.isArray(submitted) ? submitted[0] : submitted;
      const record = (row ?? {}) as Record<string, unknown>;
      return {
        proposalId: String(record.proposal_id ?? ""),
        proposalSha256: String(record.proposal_sha256 ?? ""),
        envelopeSha256: String(record.envelope_sha256 ?? envelopeSha256),
        inserted: record.inserted === true,
      };
    },
  };
}

/**
 * PostgREST puts `in` lists in the query string, and a UUID is ~37 bytes there,
 * so the full scope would build a request line past the usual 8 KB cap. Read it
 * in pages instead of relying on the whole set fitting.
 */
async function batched<T>(
  ids: readonly string[],
  read: (page: string[]) => Promise<T[]>,
): Promise<T[]> {
  const pages: T[][] = [];
  for (let index = 0; index < ids.length; index += MAX_IDS_PER_READ) {
    pages.push(await read(ids.slice(index, index + MAX_IDS_PER_READ)));
  }
  return pages.flat();
}

async function rows<T>(request: PromiseLike<QueryResult<T>>): Promise<T[]> {
  const { data, error } = await request;
  if (error) throw new Error(error.message ?? "catalog document authority read failed");
  return data ?? [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
