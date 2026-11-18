import type { PgQueryExecutor } from "../data/index.js";
import { CommerceQuoteCatalogReadError, type CommerceQuoteCatalogItemV2 } from "../pricing/commerceQuoteCatalogReadPort.js";
import { canonicalizeCatalogQuantity } from "@openlup/core/catalog";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { CatalogSkuAuthorityError, assertPrimaryUnitGtinAuthority, type NeutralSkuEnvelopeV1 } from "./contracts/foundation.js";
import type { CatalogHeadRef } from "./contracts/lifecycle.js";
import { catalogAuthoritativeLifecycleV2 } from "./lifecycleV2.js";
import type { CatalogAcceptedReferenceV2, CatalogProductState, CatalogSkuState } from "./contracts/lifecycleV2.js";
import type { CatalogSkuRevisionRef } from "./contracts/publication.js";
import type { CatalogProductTypeRef, CatalogQuantity } from "./contracts/productTypes.js";
import type { CatalogPublicationDependencies } from "./publicationPortsV2.js";
import { CatalogPublicationError, publicationDigest, type CatalogPublicationDocument } from "./publicationValidation.js";
import { catalogPhysicalUnits } from "./physicalQuantity.js";
import { canonicalizeCatalogCombinationV2 } from "./variantCombination.js";
import { z } from "./validation.js";

/** Current, verified catalogue facts shared by presentation and commerce. @experimental */
export interface NeutralSkuEnvelopeV2 {
  contractVersion: "catalog.foundation.v2";
  product: NeutralSkuEnvelopeV1["product"] & {
    title: string;
    type: CatalogProductTypeRef;
    attributes: CatalogProductState["attributes"];
  };
  sku: Omit<NeutralSkuEnvelopeV1["sku"], "netContent"> & {
    title: string;
    netContent: CatalogQuantity;
    grossMass: CatalogQuantity | null;
    minQuantity: number;
    options: CatalogSkuState["options"];
    attributes: CatalogSkuState["attributes"];
  };
  documentRevision: NeutralSkuEnvelopeV1["documentRevision"];
  identifiers: NeutralSkuEnvelopeV1["identifiers"];
  acceptedReference: CatalogAcceptedReferenceV2;
}

/** Explicitly selected host configuration and offer scope. @experimental */
export interface CatalogServingScopeV2 {
  types: readonly CatalogProductTypeRef[];
  offerVersion: string;
  maxItems?: number;
}

/** Current listing, detail and commerce reads share one installed authority. @experimental */
export interface CatalogServingReadPortV2 {
  list(query: { cursor: string | null; limit: number }): Promise<{ items: NeutralSkuEnvelopeV2[]; version: string; nextCursor: string | null }>;
  detail(slug: string): Promise<{ items: NeutralSkuEnvelopeV2[]; version: string }>;
  listQuoteCatalogItems(): Promise<CommerceQuoteCatalogItemV2[]>;
  listEditorSkus(): Promise<NeutralSkuEnvelopeV2[]>;
}

interface CurrentPublication {
  head: CatalogHeadRef | null;
  product: CatalogProductState | null;
  skus: readonly CatalogSkuState[];
  references: readonly CatalogSkuRevisionRef[];
  documents: readonly CatalogPublicationDocument[];
}
type LoadPublication = (db: PgQueryExecutor, productId: string) => Promise<CurrentPublication>;
const digest = /^[a-f0-9]{64}$/u;
const cursorSchema = z.tuple([z.string().regex(digest), z.guid().refine(id => id === id.toLowerCase())]);
const slugSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/u);
const fail = (code: CommerceQuoteCatalogReadError["code"]): never => { throw new CommerceQuoteCatalogReadError(code); };

function active(value: CatalogProductState | CatalogSkuState): boolean {
  return "lifecycleState" in value ? catalogAuthoritativeLifecycleV2(value) === "active" : value.status === "active";
}

function checkedCursor(cursor: string | null): z.infer<typeof cursorSchema> | null {
  if (cursor === null) return null;
  if (typeof cursor !== "string" || cursor.length > 160 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) return fail("catalog_cursor_invalid");
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) return fail("catalog_cursor_invalid");
    return cursorSchema.parse(JSON.parse(decoded.toString("utf8")));
  } catch {
    return fail("catalog_cursor_invalid");
  }
}

export function createCatalogServingReader<Context>(deps: CatalogPublicationDependencies<Context>, load: LoadPublication, scope: CatalogServingScopeV2): CatalogServingReadPortV2 {
  const maxItems = scope.maxItems ?? 500;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 5_000) fail("catalog_cardinality_exceeded");
  const types = scope.types.map(({ key, version }) => ({ key, version }));
  const offerVersion = scope.offerVersion.trim();
  const definitions = new Map(types.map(ref => {
    const definition = deps.registry.resolve(ref);
    return definition ? [`${ref.key}@${ref.version}`, { definition, digest: catalogDefinitionDigest(definition) }] : fail("catalog_read_not_configured");
  }));
  if (!types.length || definitions.size !== types.length || !offerVersion || offerVersion.length > 240) fail("catalog_read_not_configured");

  async function observe(slug: string | null) {
    try {
      return await deps.transactions.run(async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const observed = await db.query(`SELECT
          (SELECT bool_and(NOT row_security_active(relation::regclass)
                           AND has_table_privilege(relation::regclass, 'SELECT'))
           FROM unnest(ARRAY['public.catalog_products','public.catalog_skus','public.catalog_publication_heads',
             'public.catalog_publications','public.catalog_sku_revisions','public.catalog_product_document_revisions',
             'public.catalog_type_versions','public.catalog_sku_identifiers']) AS scoped(relation)) AS complete,
          (SELECT coalesce(jsonb_agg(jsonb_build_array(version.type_key,version.version,version.definition_digest)), '[]'::jsonb)
           FROM public.catalog_type_versions version
           JOIN jsonb_to_recordset($1::jsonb) AS scope(key text, version integer)
             ON version.type_key = scope.key AND version.version = scope.version) AS definitions`, [JSON.stringify(types)]);
        const installed = observed.rows[0];
        if (observed.rows.length !== 1 || installed?.complete !== true || !Array.isArray(installed.definitions)
          || installed.definitions.length !== types.length
          || installed.definitions.some(([key, version, digest]) => definitions.get(`${key}@${version}`)?.digest !== digest)) {
          return fail("catalog_authority_unavailable");
        }
        const { rows } = await db.query(`SELECT p.id, h.publication_id, h.revision,
            (SELECT count(*)::integer FROM public.catalog_skus s WHERE s.product_id = p.id) AS sku_count
          FROM public.catalog_products p
          JOIN jsonb_to_recordset($1::jsonb) AS scope(key text, version integer)
            ON p.type_key = scope.key AND p.type_version = scope.version
          LEFT JOIN public.catalog_publication_heads h ON h.product_id = p.id
          WHERE ($2::text IS NULL OR p.slug = $2)
          ORDER BY p.id LIMIT $3::integer`, [JSON.stringify(types), slug, maxItems + 1]);
        if (rows.length > maxItems || rows.reduce((sum, row) => sum + Number(row.sku_count), 0) > maxItems) return fail("catalog_cardinality_exceeded");
        const version = publicationDigest([types, offerVersion, slug, rows.map(row => [row.id, row.publication_id, row.revision])]);
        const items = new Map<string, { envelope: NeutralSkuEnvelopeV2; admitted: boolean }>();
        const slugs = new Set<string>();
        const codes = new Set<string>();
        for (const row of rows) {
          if (row.publication_id === null) fail("catalog_authority_unsupported");
          const { head, product, skus, references, documents } = await load(db, String(row.id));
          if (!head || !product || head.publicationId !== row.publication_id || head.revision !== row.revision
            || skus.length !== row.sku_count || slugs.has(product.slug) || (slug !== null && product.slug !== slug)) {
            return fail("catalog_authority_changed");
          }
          slugs.add(product.slug);
          if (!active(product)) continue;
          const typeEntry = definitions.get(`${product.type.key}@${product.type.version}`);
          if (!typeEntry || ("definitionDigest" in product && product.definitionDigest !== typeEntry.digest)) return fail("catalog_authority_changed");
          const document = documents.find(document => document.reference.id === product.document?.id);
          if (!document || !product.document || deps.rules.validateProduct(product, skus, [document]).length !== 0) {
            return fail("catalog_document_schema_invalid");
          }
          if (!product.primarySkuId || !skus.some(sku => sku.id === product.primarySkuId)) return fail("catalog_primary_trade_item_invalid");
          const units = catalogPhysicalUnits(typeEntry.definition);
          const publicAttributes = new Set((typeEntry.definition.attributes ?? []).filter(attribute => attribute.public).map(attribute => attribute.key));
          const projectAttributes = (attributes: CatalogSkuState["attributes"]) =>
            Object.fromEntries(Object.entries(attributes).filter(([key]) => publicAttributes.has(key)));
          for (const sku of skus) {
            if (items.has(sku.id) || codes.has(sku.code)) return fail("catalog_authority_changed");
            codes.add(sku.code);
            if (!active(sku)) continue;
            const reference = references.find(ref => ref.skuId === sku.id);
            if (!reference || sku.productId !== product.id) return fail("catalog_authority_changed");
            const identifiers: NeutralSkuEnvelopeV2["identifiers"] = sku.identifiers.map(identifier => ({
              issuer: identifier.issuer, normalizedValue: identifier.scheme === "gs1:gtin" ? identifier.value.padStart(14, "0") : identifier.value,
              kind: identifier.scheme === "gs1:gtin" ? "gtin" : "other", packKind: identifier.packagingLevel === "unit" ? "unit" : "collective",
              packQuantity: identifier.quantity, isPrimary: identifier.isPrimary,
            }));
            const selectable = sku.sellableStandalone || sku.sellableInSubscription;
            if (selectable) assertPrimaryUnitGtinAuthority(identifiers);
            canonicalizeCatalogQuantity(sku.netContent, units);
            if (sku.grossMass) canonicalizeCatalogQuantity(sku.grossMass, units);
            const optionDigest = Buffer.from(canonicalizeCatalogCombinationV2({ definition: typeEntry.definition, axes: product.axes, options: sku.options }).combinationDigest).toString("hex");
            if ("optionDigest" in sku && sku.optionDigest !== optionDigest) return fail("catalog_authority_changed");
            const acceptedReference: CatalogAcceptedReferenceV2 = {
              schemaVersion: 2, skuId: sku.id, skuCode: sku.code, skuRevisionId: reference.revisionId,
              publicationHead: head, typeRef: product.type, definitionDigest: typeEntry.digest, optionDigest, netContent: sku.netContent,
            };
            items.set(sku.id, { admitted: selectable && sku.memberships.some(member => member.offerVersion === offerVersion && member.admitted),
              envelope: { contractVersion: "catalog.foundation.v2", documentRevision: product.document, identifiers, acceptedReference,
                product: { id: product.id, slug: product.slug, title: product.name, type: product.type,
                  primarySkuId: product.primarySkuId, attributes: projectAttributes(product.attributes) },
                sku: { id: sku.id, productId: product.id, code: sku.code, title: sku.title, netContent: sku.netContent, grossMass: sku.grossMass,
                  options: sku.options, attributes: projectAttributes(sku.attributes), minQuantity: sku.minQuantity, isAddon: sku.isAddon,
                  assetRef: sku.assetRefs[0] ?? null,
                  sellability: { status: sku.status, oneTime: sku.sellableStandalone, subscription: sku.sellableInSubscription } } } });
          }
        }
        return { version, items: [...items.values()].sort((a, b) => a.envelope.sku.id < b.envelope.sku.id ? -1 : 1) };
      });
    } catch (error) {
      if (error instanceof CommerceQuoteCatalogReadError) throw error;
      if (error instanceof CatalogSkuAuthorityError) return fail("catalog_primary_trade_item_invalid");
      if (error instanceof CatalogPublicationError) {
        if (error.code === "catalog_publication_document_invalid") return fail("catalog_document_digest_mismatch");
        if (error.outcome === "conflict") return fail("catalog_authority_changed");
        return fail("catalog_revision_invalid");
      }
      return fail("catalog_authority_unavailable");
    }
  }

  async function selectable() {
    const page = await observe(null);
    return page.items.filter(item => item.admitted).map(item => item.envelope);
  }

  return {
    async list({ limit, cursor }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return fail("catalog_cursor_invalid");
      const anchor = checkedCursor(cursor);
      const { version, items } = await observe(null);
      if (anchor && anchor[0] !== version) return fail("catalog_authority_changed");
      const offset = anchor ? items.findIndex(item => item.envelope.sku.id === anchor[1]) + 1 : 0;
      if (anchor && !offset) return fail("catalog_cursor_invalid");
      const page = items.slice(offset, offset + limit).map(item => item.envelope);
      return { version, items: page, nextCursor: items.length > offset + limit
        ? Buffer.from(JSON.stringify([version, page[page.length - 1]!.sku.id])).toString("base64url") : null };
    },
    async detail(slug) {
      if (!slugSchema.safeParse(slug).success) return fail("catalog_cursor_invalid");
      const { version, items } = await observe(slug);
      return { version, items: items.some(item => item.admitted) ? items.map(item => item.envelope) : [] };
    },
    async listQuoteCatalogItems() {
      return (await selectable()).map(({ product, sku, documentRevision, acceptedReference }) => ({
        skuId: sku.id, skuCode: sku.code, variantId: sku.id, productSlug: product.slug, isPrimarySku: product.primarySkuId === sku.id,
        netContent: sku.netContent, grossMass: sku.grossMass, isAddon: sku.isAddon, sellability: sku.sellability, acceptedReference,
        documentRevision: { id: documentRevision.id, digest: documentRevision.digest },
      }));
    },
    listEditorSkus: selectable,
  };
}
