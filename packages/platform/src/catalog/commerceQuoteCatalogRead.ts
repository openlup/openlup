import type { PgQueryExecutor } from "../data/index.js";
import {
  CommerceQuoteCatalogReadError,
  type CommerceQuoteCatalogItem,
  type CommerceQuoteCatalogReadPort,
} from "../pricing/index.js";
import { createPostgresCatalogSkuEnvelopeReadPort } from "./catalogSkuEnvelope.js";
import { CatalogSkuAuthorityError, type NeutralSkuEnvelopeV1 } from "./foundationSchemas.js";

const PAGE_SIZE = 100;
const CURRENT_DOCUMENTS_SQL = `
  SELECT product.id AS product_id, product.slug AS product_slug,
    product.status AS product_status, product.current_document_revision_id,
    revision.id AS revision_id, revision.product_id AS revision_product_id,
    revision.revision_no AS revision_no, revision.schema_id AS revision_schema_id,
    revision.document_payload AS revision_document_payload, revision.digest AS revision_digest
  FROM public.catalog_products AS product
  LEFT JOIN public.catalog_product_document_revisions AS revision
    ON revision.id = product.current_document_revision_id
   AND revision.product_id = product.id
  WHERE product.id = ANY($1::uuid[])`;

export interface PostgresCommerceQuoteCatalogReadOptions {
  /** Technical ceiling for one full scan; defaults to 500. Positive safe integer. */
  maxItems?: number;
  /**
   * Required host policy: admit the opaque document schema, check its semantic
   * identity against the envelope and verify its canonical digest. Reject with
   * CommerceQuoteCatalogReadError for a named schema or digest refusal.
   */
  verifyDocument(document: unknown, envelope: NeutralSkuEnvelopeV1): Promise<void>;
  /** The trusted host runs the whole offer read on a single repeatable-read connection.
   * @experimental
   */
  governedOffer?: {
    offerVersion: string;
    mode: "one_time" | "subscription";
    withSnapshot<T>(read: (executor: PgQueryExecutor) => Promise<T>): Promise<T>;
  };
}

/**
 * Strict current-direct quote facts over existing runtime SELECT grants.
 * Requires host document verification; never falls back to a legacy catalog.
 * The current-direct path scans afresh. The governed offer path qualifies an
 * exact roster and its publication heads on one host-owned snapshot.
 */
export function createPostgresCommerceQuoteCatalogReadPort(
  executor: PgQueryExecutor,
  options: PostgresCommerceQuoteCatalogReadOptions,
): CommerceQuoteCatalogReadPort {
  const maxItems = options?.maxItems ?? (options?.governedOffer?.offerVersion === "sized.v1" ? 1000 : 500);
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new RangeError("maxItems must be a positive safe integer");
  }
  const verifyDocument = options?.verifyDocument;
  if (typeof verifyDocument !== "function") {
    throw new CommerceQuoteCatalogReadError("catalog_read_not_configured");
  }
  const envelopes = createPostgresCatalogSkuEnvelopeReadPort(executor);
  return {
    async listQuoteCatalogItems() {
      try {
        const offer = options.governedOffer;
        if (offer) return await offer.withSnapshot(db => readGovernedQuoteCatalog(db, offer, verifyDocument, maxItems));
        const items: CommerceQuoteCatalogItem[] = [];
        const seenCursors = new Set<string>();
        const seenIds = new Set<string>();
        const seenCodes = new Set<string>();
        const maxPages = Math.ceil(maxItems / PAGE_SIZE) + 1;
        let pageCount = 0;
        let cursor: string | null = null;
        do {
          if (pageCount >= maxPages) {
            throw new CommerceQuoteCatalogReadError("catalog_cardinality_exceeded");
          }
          pageCount += 1;
          const page = await envelopes.listActiveSkuEnvelopes({ cursor, limit: PAGE_SIZE });
          const documents = await readCurrentDocuments(executor, page.items);
          const active = page.items.filter((envelope, index) => documents[index]!.product_status === "active");
          if (items.length + active.length > maxItems) {
            throw new CommerceQuoteCatalogReadError("catalog_cardinality_exceeded");
          }
          for (const [index, envelope] of page.items.entries()) {
            if (documents[index]!.product_status !== "active") continue;
            await verifyDocument(documents[index]!.revision_document_payload, envelope);
            if (seenIds.has(envelope.sku.id) || seenCodes.has(envelope.sku.code)) {
              throw new CommerceQuoteCatalogReadError("catalog_authority_changed");
            }
            seenIds.add(envelope.sku.id);
            seenCodes.add(envelope.sku.code);
            items.push(quoteCatalogItem(envelope));
          }
          const nextCursor = page.nextCursor;
          if (nextCursor !== null && (nextCursor === cursor || seenCursors.has(nextCursor))) {
            throw new CommerceQuoteCatalogReadError("catalog_cursor_invalid");
          }
          if (cursor !== null) seenCursors.add(cursor);
          cursor = nextCursor;
        } while (cursor !== null);
        return items;
      } catch (error) {
        if (error instanceof CommerceQuoteCatalogReadError) throw error;
        if (options.governedOffer && error && typeof error === "object" && "code" in error && error.code === "40001") {
          throw new CommerceQuoteCatalogReadError("catalog_authority_changed");
        }
        if (error instanceof CatalogSkuAuthorityError) {
          throw new CommerceQuoteCatalogReadError(
            error.code === "catalog_sku_authority_primary_sku_invalid"
              || error.code === "catalog_sku_identifier_authority_absent"
              || error.code === "catalog_sku_identifier_authority_ambiguous"
              || error.code === "catalog_sku_identifier_authority_invalid"
              ? "catalog_primary_trade_item_invalid" : "catalog_revision_invalid",
          );
        }
        throw new CommerceQuoteCatalogReadError("catalog_authority_unavailable");
      }
    },
  };
}

function quoteCatalogItem(envelope: NeutralSkuEnvelopeV1): CommerceQuoteCatalogItem {
  return {
    skuId: envelope.sku.id,
    skuCode: envelope.sku.code,
    variantId: envelope.sku.id,
    productSlug: envelope.product.slug,
    netWeightG: envelope.sku.netContent.unscaled,
    isPrimarySku: envelope.product.primarySkuId === envelope.sku.id,
    isAddon: envelope.sku.isAddon,
    sellability: { oneTime: envelope.sku.sellability.oneTime, subscription: envelope.sku.sellability.subscription },
    documentRevision: { id: envelope.documentRevision.id, digest: envelope.documentRevision.digest },
  };
}

type QuoteMembership = NonNullable<CommerceQuoteCatalogItem["publication"]> & {
  skuId: string;
  skuCode: string;
  productSlug: string;
  primarySkuId: string;
  isAddon: boolean;
  netWeightG: number;
  sellableStandalone: boolean;
  sellableInSubscription: boolean;
  document: NeutralSkuEnvelopeV1["documentRevision"];
};

async function readGovernedQuoteCatalog(
  db: PgQueryExecutor,
  offer: NonNullable<PostgresCommerceQuoteCatalogReadOptions["governedOffer"]>,
  verifyDocument: PostgresCommerceQuoteCatalogReadOptions["verifyDocument"],
  maxItems: number,
): Promise<CommerceQuoteCatalogItem[]> {
  const { rows: [scope] } = await db.query(`SELECT public.catalog_admission_members($1::text,$2::text,NULL,false) AS members
    WHERE current_setting('transaction_isolation') IN ('repeatable read','serializable')`, [offer.offerVersion, offer.mode]);
  if (!scope) throw new CommerceQuoteCatalogReadError("catalog_read_not_configured");
  const members = scope.members as Record<string, QuoteMembership>;
  const ids = Object.keys(members).sort();
  if (ids.length > maxItems) throw new CommerceQuoteCatalogReadError("catalog_cardinality_exceeded");
  const envelopes = createPostgresCatalogSkuEnvelopeReadPort(db);
  const items: CommerceQuoteCatalogItem[] = [];
  for (let start = 0; start < ids.length; start += PAGE_SIZE) {
    const selected = ids.slice(start, start + PAGE_SIZE);
    const { items: roster, nextCursor } = await envelopes.listActiveSkuEnvelopes({
      skuCodes: selected.map(id => members[id]!.skuCode), cursor: null, limit: PAGE_SIZE,
    });
    if (roster.length !== selected.length || nextCursor !== null) throw new CommerceQuoteCatalogReadError("catalog_authority_changed");
    const documents = await readCurrentDocuments(db, roster);
    for (const [index, envelope] of roster.entries()) {
      const member = members[envelope.sku.id];
      const item = quoteCatalogItem(envelope);
      const document = documents[index]!;
      if (!member || document.product_status !== "active" || member.skuId !== item.skuId ||
        member.skuCode !== item.skuCode || member.productId !== envelope.product.id ||
        member.productSlug !== item.productSlug || member.primarySkuId !== envelope.product.primarySkuId ||
        member.isAddon !== item.isAddon || member.netWeightG !== item.netWeightG ||
        member.sellableStandalone !== item.sellability.oneTime || member.sellableInSubscription !== item.sellability.subscription ||
        member.document.id !== item.documentRevision.id || member.document.digest !== item.documentRevision.digest ||
        member.head.documentDigest !== item.documentRevision.digest) {
        throw new CommerceQuoteCatalogReadError("catalog_authority_changed");
      }
      await verifyDocument(document.revision_document_payload, envelope);
      items.push({ ...item, publication: { productId: member.productId, skuRevisionId: member.skuRevisionId, head: member.head } });
    }
  }
  return items;
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

async function readCurrentDocuments(
  executor: PgQueryExecutor,
  envelopes: readonly NeutralSkuEnvelopeV1[],
): Promise<CurrentDocumentRow[]> {
  if (envelopes.length === 0) return [];
  const productIds = [...new Set(envelopes.map((envelope) => envelope.product.id))];
  const { rows } = await executor.query(CURRENT_DOCUMENTS_SQL, [productIds]);
  return envelopes.map((envelope) => {
    const products = (rows as unknown as CurrentDocumentRow[])
      .filter((row) => row.product_id === envelope.product.id);
    if (products.length === 0) throw new CommerceQuoteCatalogReadError("catalog_authority_changed");
    if (products.length !== 1) throw new CommerceQuoteCatalogReadError("catalog_revision_invalid");
    const product = products[0]!;
    const expected = envelope.documentRevision;
    if (product.product_slug !== envelope.product.slug
      || product.current_document_revision_id !== expected.id) {
      throw new CommerceQuoteCatalogReadError("catalog_authority_changed");
    }
    if ((product.product_status !== "active" && product.product_status !== "draft" && product.product_status !== "archived")
      || product.revision_id !== expected.id
      || product.revision_product_id !== envelope.product.id
      || product.revision_no !== expected.revisionNo
      || product.revision_schema_id !== expected.schemaId
      || product.revision_digest !== expected.digest) {
      throw new CommerceQuoteCatalogReadError("catalog_revision_invalid");
    }
    return product;
  });
}
