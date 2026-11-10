import { createHash } from 'node:crypto';
import { CommerceQuoteCatalogReadError } from '@openlup/platform/pricing';
import type { NeutralSkuEnvelopeV1 } from '@openlup/platform/catalog';
import { isRecord } from '../shared/offer.ts';
import type { StoreConfig } from '../shared/config.ts';
import type { EditorProduct } from '../shared/subscription-edit.ts';

export function demoIdentifier(config: StoreConfig, kind: string, key: string): string {
  const hex = createHash('sha256').update(`neutral-store-demo-v1:${config.id}:${kind}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function documentDigest(document: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(document))).digest('hex');
}
export function editorProducts(config: StoreConfig): EditorProduct[] {
  return config.subscriptionEditing.catalogue.map(product => {
    const storefront = config.offer.products.find(item => item.sku === product.sku);
    return storefront ? { ...product, ...storefront,physicalSize: storefront.physical.netWeightG,stockQuantity: config.purchase.stock.quantities[product.sku] ?? product.stockQuantity } : product;
  });
}
/** One application-owned product document shared by checkout and servicing. */
export function editorDocuments(config: StoreConfig) {
  const products = editorProducts(config);
  return [...new Set(products.map(product => product.groupKey))].map(group => {
    const variants = products.filter(product => product.groupKey === group);
    const id = demoIdentifier(config, 'product', group);
    const document = { schemaVersion: config.quote.document.schemaId, productId: id,
      productSlug: `demo-${config.id}-${variants[0]!.slug}`, revisionNo: config.quote.document.revisionNo,
      sourceRef: config.quote.document.sourceRef,
      variants: variants.map(product => {
        const skuId = demoIdentifier(config, 'sku', product.sku);
        const digits = BigInt('0x' + skuId.replaceAll('-', '')).toString().slice(0,12).padStart(12,'0');
        const check = (10 - [...digits].reduce((sum,digit,index) => sum + Number(digit) * (index % 2 ? 3 : 1),0) % 10) % 10;
        const physical = config.offer.products.some(item => item.sku === product.sku) ? product.physical
          : { netWeightG: product.physicalSize, issuer: 'starter:demo', unitGtin: digits + check };
        return { skuId, sku: product.sku, physical, demandPerUnit: product.demandPerUnit, exclusions: [...product.exclusions] };
      }) };
    return { id: demoIdentifier(config, 'document', group), productId: id, document, digest: documentDigest(document), variants };
  });
}

export type ProductDocument = ReturnType<typeof editorDocuments>[number]['document'];
export function productDocument(value: unknown, schemaId: string): ProductDocument {
  if (!isRecord(value) || value.schemaVersion !== schemaId || Object.keys(value).length !== 6
    || typeof value.productId !== 'string' || typeof value.productSlug !== 'string'
    || !Number.isSafeInteger(value.revisionNo) || Number(value.revisionNo) < 1 || typeof value.sourceRef !== 'string'
    || !Array.isArray(value.variants) || !value.variants.length || value.variants.some(row => !isRecord(row)
      || typeof row.skuId !== 'string' || typeof row.sku !== 'string' || !isRecord(row.physical)
      || !Number.isSafeInteger(row.physical.netWeightG) || Number(row.physical.netWeightG) <= 0
      || typeof row.physical.issuer !== 'string' || typeof row.physical.unitGtin !== 'string'
      || !Number.isSafeInteger(row.demandPerUnit) || Number(row.demandPerUnit) <= 0
      || !Array.isArray(row.exclusions) || row.exclusions.some(key => typeof key !== 'string' || !key))) {
    throw new CommerceQuoteCatalogReadError('catalog_document_schema_invalid');
  }
  return value as ProductDocument;
}
export function verifyProductDocument(value: unknown, envelope: NeutralSkuEnvelopeV1, schemaId: string): void {
  const parsed = productDocument(value, schemaId);
  const variants = parsed.variants.filter(row => row.skuId.toLowerCase() === envelope.sku.id.toLowerCase() && row.sku === envelope.sku.code);
  const variant = variants[0];
  if (parsed.productId.toLowerCase() !== envelope.product.id.toLowerCase() || parsed.productSlug !== envelope.product.slug
    || parsed.schemaVersion !== envelope.documentRevision.schemaId || parsed.revisionNo !== envelope.documentRevision.revisionNo
    || parsed.sourceRef !== envelope.documentRevision.sourceRef || variants.length !== 1 || !variant
    || variant.physical.netWeightG !== envelope.sku.netContent.unscaled
    || !envelope.identifiers.some(identifier => identifier.isPrimary && identifier.kind === 'gtin'
      && identifier.issuer === variant.physical.issuer && identifier.normalizedValue === variant.physical.unitGtin)) {
    throw new CommerceQuoteCatalogReadError('catalog_document_schema_invalid');
  }
  if (documentDigest(value) !== envelope.documentRevision.digest) throw new CommerceQuoteCatalogReadError('catalog_document_digest_mismatch');
}
