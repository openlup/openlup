import { createHash } from "node:crypto";
import type { CatalogPublicationDependencies } from "./publicationPortsV2.js";
import type { CatalogPublicationDocument } from "./publicationValidation.js";
import type { CatalogPublishedProductV3, CatalogPublishedSkuV3 } from "./contracts/lifecycleV2.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { canonicalizeCatalogCombinationV2 } from "./variantCombination.js";
import { catalogQuantitySchema } from "./productTypeSchemas.js";
import { publicationJson, publicationRefuse } from "./publicationValidation.js";
import { z } from "./validation.js";

const id = z.guid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const status = z.enum(["draft", "active", "archived"]);
const rawProduct = z.object({ id, slug: z.string().min(1), name: z.string().min(1), status, type_key: z.string().min(1),
  type_version: z.number().int().positive(), variant_axes: z.array(z.string()).nullable(),
  attribute_values: z.record(z.string(), z.json()).nullable(), primary_sku_id: id,
  current_document_revision_id: id }).passthrough();
const rawSku = z.object({ id, product_id: id, sku: z.string().min(1), title: z.string().min(1), status,
  min_order_qty: z.number().int().positive(), is_addon: z.boolean(), sellable_standalone: z.boolean(), sellable_in_subscription: z.boolean(),
  net_content_dimension: z.enum(["mass", "volume", "count"]), net_content_unscaled: z.string(), net_content_scale: z.number(),
  net_content_unit: z.string(), gross_mass_dimension: z.literal("mass").nullable(), gross_mass_unscaled: z.string().nullable(),
  gross_mass_scale: z.number().nullable(), gross_mass_unit: z.string().nullable(), option_values: z.record(z.string(), z.json()).nullable(),
  attribute_values: z.record(z.string(), z.json()).nullable(), asset_ref: z.string().nullable(),
}).passthrough();
const identifier = z.object({ identifier_kind: z.enum(["gtin", "other"]), scheme: z.string().nullable(), issuer: z.string(),
  normalized_value: z.string(), original_value: z.string().nullable(), pack_kind: z.enum(["unit", "collective"]),
  quantity: z.number().int().positive(), is_primary: z.boolean(), display_label: z.string().nullable(), source_ref: z.string().nullable(),
}).passthrough();
const document = z.object({ id, digest, product_id: id, canonical_text: z.string(), revision_no: z.number().int().positive(),
  schema_id: z.string(), document_ref: z.string(), source_ref: z.string(), document_payload: z.record(z.string(), z.json()),
}).passthrough();
const manifest = z.object({ schemaVersion: z.literal(5), sourceKind: z.literal("adopted_existing"), sourceDigest: digest, definitionDigest: digest,
  product: rawProduct, document, skus: z.array(z.object({ skuId: id, revisionId: id, revision: z.literal(1), digest }).strict()).min(1),
}).strict();
const skuRecord = z.object({ id, productId: id, code: z.string(), facts: rawSku, identifiers: z.array(identifier) }).strict();
const unavailable = () => publicationRefuse("catalog_adoption_lineage_invalid", "dependency_unavailable");
const drift = () => publicationRefuse("catalog_publication_live_drift", "conflict");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type AdoptedProduct = Omit<CatalogPublishedProductV3, "source"> & { source: null };
type AdoptedSku = Omit<CatalogPublishedSkuV3, "source"> & { source: null };

/** Verify the initial source before the shared reader or compiler uses its facts. */
type StoredAdoption = { canonical_state: string; digest: string; document_revision_id: string; product_id: string; revision: number; id: string };
export function decodeAdoptedPublication<Context, Stored extends StoredAdoption>(
  deps: CatalogPublicationDependencies<Context>,
  stored: Stored,
  revisions: Record<string, unknown>[],
  live: { product: unknown; skus: unknown[]; identifiers: Record<string, unknown>[] } | null,
) {
  if (stored.revision !== 1 || sha256(stored.canonical_state) !== stored.digest) return unavailable();
  const state = manifest.parse(JSON.parse(stored.canonical_state));
  const productRow = state.product, doc = state.document;
  if (productRow.id !== stored.product_id || doc.id !== stored.document_revision_id || doc.product_id !== productRow.id
    || productRow.current_document_revision_id !== doc.id || sha256(doc.canonical_text) !== doc.digest
    || publicationJson(JSON.parse(doc.canonical_text)) !== publicationJson(doc.document_payload)
    || !state.skus.every(({ skuId }, index) => index === 0 || state.skus[index - 1]!.skuId < skuId)
    || !state.skus.some(reference => reference.skuId === productRow.primary_sku_id)
    || state.skus.length !== revisions.length) return unavailable();
  if (live && publicationJson(live.product) !== publicationJson(productRow)) return drift();
  const retainedDocument: CatalogPublicationDocument = {
    reference: { id: doc.id, productId: doc.product_id, schemaId: doc.schema_id, revisionNo: doc.revision_no,
      documentRef: doc.document_ref, sourceRef: doc.source_ref, digest: doc.digest },
    canonicalText: doc.canonical_text,
    provenance: { sourceKind: "adopted_existing", sourceDigest: state.sourceDigest },
  };
  const type = { key: productRow.type_key, version: productRow.type_version };
  const definition = deps.registry.resolve(type);
  if (!definition || catalogDefinitionDigest(definition) !== state.definitionDigest) return unavailable();
  const axes = productRow.variant_axes ?? [];
  const product: AdoptedProduct = { id: productRow.id, slug: productRow.slug, name: productRow.name, status: productRow.status,
    schemaVersion: 3, lifecycleState: productRow.status, type, axes,
    attributes: (productRow.attribute_values ?? {}) as AdoptedProduct["attributes"], definitionDigest: state.definitionDigest,
    primarySkuId: productRow.primary_sku_id, document: retainedDocument.reference, source: null, presentation: null,
    content: { schemaVersion: 1, catalogAction: "revise", presentation: {}, offerMemberships: [], requestedModes: [], publicationSkus: [] } };
  const seenCodes = new Set<string>();
  const skus = state.skus.map(reference => {
    const revision = revisions.find(row => row.id === reference.revisionId && row.sku_id === reference.skuId);
    if (!revision || revision.revision !== 1 || revision.publication_id !== stored.id || revision.digest !== reference.digest
      || typeof revision.full_facts !== "string" || sha256(revision.full_facts) !== reference.digest) return unavailable();
    const record = skuRecord.parse(JSON.parse(revision.full_facts));
    const skuRow = record.facts;
    if (record.id !== reference.skuId || skuRow.id !== record.id || record.productId !== productRow.id
      || skuRow.product_id !== productRow.id || skuRow.sku !== record.code || seenCodes.has(record.code)) return unavailable();
    seenCodes.add(record.code);
    if (live && (!live.skus.some(row => publicationJson(row) === publicationJson(skuRow))
      || publicationJson(live.identifiers.filter(row => row.catalog_sku_id === skuRow.id)) !== publicationJson(record.identifiers))) return drift();
    const options = (skuRow.option_values ?? {}) as AdoptedSku["options"];
    const identity = canonicalizeCatalogCombinationV2({ definition, axes, options });
    const sku: AdoptedSku = { schemaVersion: 3, lifecycleState: skuRow.status,
      id: skuRow.id, productId: skuRow.product_id, code: skuRow.sku, title: skuRow.title, status: skuRow.status,
      isAddon: skuRow.is_addon, minQuantity: skuRow.min_order_qty, sellableStandalone: skuRow.sellable_standalone,
      sellableInSubscription: skuRow.sellable_in_subscription, options, optionDigest: Buffer.from(identity.combinationDigest).toString("hex"),
      attributes: (skuRow.attribute_values ?? {}) as AdoptedSku["attributes"], source: null,
      netContent: catalogQuantitySchema.parse({ dimension: skuRow.net_content_dimension, unit: skuRow.net_content_unit,
        scale: skuRow.net_content_scale, unscaled: skuRow.net_content_unscaled }),
      grossMass: skuRow.gross_mass_dimension === null ? null : catalogQuantitySchema.parse({ dimension: skuRow.gross_mass_dimension,
        unit: skuRow.gross_mass_unit, scale: skuRow.gross_mass_scale, unscaled: skuRow.gross_mass_unscaled }),
      identifiers: record.identifiers.map(row => ({
        scheme: row.scheme ?? (row.identifier_kind === "gtin" ? "gs1:gtin" : unavailable()), issuer: row.issuer,
        value: row.original_value ?? row.normalized_value, packagingLevel: row.pack_kind === "unit" ? "unit" : "case",
        quantity: row.quantity, isPrimary: row.is_primary, label: row.display_label, sourceRef: row.source_ref,
      })),
      facts: {}, assetRefs: skuRow.asset_ref ? [skuRow.asset_ref] : [], logisticsRef: null, memberships: [],
    };
    sku.facts = deps.rules.deriveSkuFacts(doc.document_payload, sku);
    return sku;
  });
  if (live && skus.length !== live.skus.length) return drift();
  return { head: { publicationId: stored.id, revision: 1, documentDigest: doc.digest }, publication: stored,
    product, skus, references: state.skus, documents: [retainedDocument] };
}
