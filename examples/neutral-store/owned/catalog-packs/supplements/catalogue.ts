import { createHash } from 'node:crypto';
import {
  canonicalCatalogDraftJson, catalogDraftPayloadV3Schema, catalogDraftPayloadV4Schema, catalogDraftPayloadV5Schema,
  type CatalogDraftPayloadV3, type CatalogDraftPayloadV4, type CatalogDraftPayloadV5,
} from '@openlup/platform/catalog';
import { itemType } from './pack.ts';
import type { Format } from './policy.ts';

export const offerVersion = 'supplements:regular@1';

export const proposedTaxonomy = {
  categories: [
    { key: 'supplements', parent: null },
    { key: 'capsules', parent: 'supplements' },
    { key: 'powders', parent: 'supplements' },
  ],
  collections: [{ key: 'daily', categories: ['capsules', 'powders'] }],
} as const;

const gram = (unscaled: string) => ({ dimension: 'mass', unit: 'openlup:g', unscaled, scale: 0 }) as const;
const capsules = { dimension: 'count', unit: 'supplements:capsule', unscaled: '56', scale: 0 } as const;
const identity = (suffix: number) => `00000000-0000-4000-8000-0000000001${suffix}`;
type Input = {
  suffix: 10 | 20 | 30;
  slug: 'capsule' | 'powder' | 'capsule-next';
  format: Format;
  title: string;
  skuCode: string;
  gtin: string;
  grossGrams: string;
  unitPriceMinor: number;
};

function draft({ suffix, slug, format, title, skuCode, gtin, grossGrams, unitPriceMinor }: Input, priceListId: string) {
  const productId = identity(suffix);
  const skuId = identity(suffix + 1);
  const evidence = `fixture:supplements/${slug}/1`;
  const document = {
    title,
    ingredients: [format === 'capsule' ? 'Fictional amber blend' : 'Fictional white blend'],
    supplementFacts: ['Synthetic serving declaration'],
    allergens: ['Fictional amber allergen'],
    warnings: ['Demonstration label for adults'],
    claims: ['Fictional label display'],
    evidence: [evidence],
    adultsOnly: true,
    serving: { perContainer: 28, unit: format === 'capsule' ? 'capsule_pair' : 'scoop' },
  };
  const canonicalText = canonicalCatalogDraftJson(document);
  const documentRevision = {
    id: identity(suffix + 2), productId, revisionNo: 1, schemaId: 'supplements:label',
    documentRef: `supplements:${slug}/1`, sourceRef: evidence,
    digest: createHash('sha256').update(canonicalText).digest('hex'),
  };
  const presentation = { route: `/product/${slug}`, title };
  const membership = { skuCode, offerVersion, admitted: true };
  const publicationSku = { skuCode, title, minQuantity: 1, isAddon: false, facts: {} };
  const identifier = { scheme: 'gs1:gtin', issuer: 'fixture:supplements', value: gtin,
    packagingLevel: 'unit', quantity: 1 } as const;
  const logisticsRef = `fixture:supplements/logistics/${slug}`;
  const payload: CatalogDraftPayloadV3 = {
    schemaVersion: 3,
    product: { id: productId, type: itemType, slug, dimensions: ['format'], primarySkuId: skuId,
      attributes: { adults_only: document.adultsOnly }, documentRevision,
      sharedContent: { schemaVersion: 1, catalogAction: 'create', document, presentation,
        offerMemberships: [membership], requestedModes: [{ skuCode, modes: ['subscription'] }], publicationSkus: [publicationSku] } },
    skus: [{ id: skuId, productId, code: skuCode, options: { format: { kind: 'choice', value: format } },
      attributes: { format }, identifiers: [identifier], logisticsRef,
      netContent: format === 'capsule' ? capsules : gram('140'), grossMass: gram(grossGrams),
      priceOperations: [{ schemaVersion: 1, commandKey: `supplements:price:${slug}`, variantId: skuId, priceListId,
        mode: 'one_time', minQty: 1, amountKind: 'gross', unitPriceMinor, expected: { entryId: null, unitPriceMinor: null } }] }],
    publication: { kind: 'release', evidence: {}, operations: [
      { op: 'create_product', productId, productSlug: slug, name: title },
      { op: 'register_document_revision', productSlug: slug, revisionId: documentRevision.id, revisionNo: 1,
        documentRef: documentRevision.documentRef, sourceRef: evidence, canonicalText,
        digest: documentRevision.digest, provenance: { source: 'current_draft' } },
      { op: 'move_document_pointer', productSlug: slug, documentRevisionNo: 1 },
      { op: 'create_sku', skuId, productSlug: slug, documentRevisionNo: 1, ...publicationSku },
      { op: 'create_identifier', skuCode, ...identifier, isPrimary: true, label: null, sourceRef: evidence },
      { op: 'set_sku_metadata', skuCode, logisticsRef },
      { op: 'set_primary_sku', productSlug: slug, skuCode },
      { op: 'set_product_presentation', productSlug: slug, presentation },
      { op: 'set_offer_membership', ...membership },
      { op: 'set_eligibility', skuCode, sellableStandalone: false, sellableInSubscription: true },
      { op: 'set_sku_status', skuCode, status: 'active' },
      { op: 'set_product_status', productSlug: slug, status: 'active' },
    ] },
  };
  return { draftId: identity(suffix + 3), format, skuId, skuCode,
    netContent: format === 'capsule' ? capsules : gram('140'), payload: catalogDraftPayloadV3Schema.parse(payload) };
}

/** Revise the stored v3 drafts to the lifecycle dialect before approving publication. */
function lifecycleRelease(payload: CatalogDraftPayloadV3): CatalogDraftPayloadV4 {
  const operations = payload.publication.operations.filter(operation =>
    operation.op !== 'set_sku_status' && operation.op !== 'set_product_status' && operation.op !== 'set_eligibility');
  const skuCode = payload.skus[0]!.code!;
  return catalogDraftPayloadV4Schema.parse({ ...payload, schemaVersion: 4, publication: { ...payload.publication, operations: [
    ...operations,
    { op: 'set_product_lifecycle', productSlug: payload.product.slug, expectedState: 'draft', state: 'active', children: [] },
    { op: 'set_sku_lifecycle', skuCode, expectedState: 'draft', state: 'active' },
    { op: 'set_eligibility', skuCode, sellableStandalone: false, sellableInSubscription: true },
  ] } });
}

/** Build typed drafts for the adopter's installed price list. */
export function supplementsCatalogue(priceListId: string) {
  const capsule = draft({ suffix: 10, slug: 'capsule', format: 'capsule', title: 'Fixture capsules',
    skuCode: 'G1-CAPS-56', gtin: '0000000010108', grossGrams: '92', unitPriceMinor: 2800 }, priceListId);
  const powder = draft({ suffix: 20, slug: 'powder', format: 'powder', title: 'Fixture powder',
    skuCode: 'G1-POWDER-140', gtin: '0000000010207', grossGrams: '172', unitPriceMinor: 4200 }, priceListId);
  const next = draft({ suffix: 30, slug: 'capsule-next', format: 'capsule', title: 'Fixture successor capsules',
    skuCode: 'G1-CAPS-NEXT-56', gtin: '0000000010306', grossGrams: '96', unitPriceMinor: 3080 }, priceListId);

  const initialDrafts = [capsule, powder] as const;

  const initialPublications = initialDrafts.map(({ payload }) => lifecycleRelease(payload));

  const capsuleProduct = capsule.payload.product;
  const withdrawal = catalogDraftPayloadV4Schema.parse({
    schemaVersion: 4,
    product: { ...capsuleProduct, sharedContent: { ...capsuleProduct.sharedContent, catalogAction: 'revise' } },
    skus: capsule.payload.skus.map(({ priceOperations: _priceOperations, ...sku }) => sku),
    publication: { kind: 'release', evidence: {}, operations: [
      { op: 'set_product_lifecycle', productSlug: capsuleProduct.slug,
        expectedState: 'active', state: 'withdrawn', children: [{ skuCode: capsule.skuCode, expectedState: 'active' }] },
    ] },
  });

  const nextRelease = lifecycleRelease(next.payload);
  const successorPayload: CatalogDraftPayloadV5 = {
    ...nextRelease,
    schemaVersion: 5,
    publication: { ...nextRelease.publication, operations: nextRelease.publication.operations.map(operation =>
      operation.op === 'create_sku' ? { ...operation, successorOf: capsule.skuId } : operation) },
  };
  const successor = { ...next, payload: catalogDraftPayloadV5Schema.parse(successorPayload) };
  return { initialDrafts, initialPublications, withdrawal, successor };
}
