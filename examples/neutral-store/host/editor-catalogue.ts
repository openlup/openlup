import { createHash } from 'node:crypto';
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
    return storefront ? { ...product, ...storefront,stockQuantity: config.purchase.stock.quantities[product.sku] ?? product.stockQuantity } : product;
  });
}
/** The complete fictional document is the host's opaque schema, including every exact size. */
export function editorDocuments(config: StoreConfig) {
  const products = editorProducts(config);
  return [...new Set(products.map(product => product.groupKey))].map(group => {
    const variants = products.filter(product => product.groupKey === group);
    const id = demoIdentifier(config, 'product', group);
    const document = { schema: 'starter:subscription-item@1', productId: id,
      variants: variants.map(product => ({ id: demoIdentifier(config, 'sku', product.sku), sku: product.sku,
        physicalSize: product.physicalSize, demandPerUnit: product.demandPerUnit, exclusions: [...product.exclusions] })) };
    return { id: demoIdentifier(config, 'document', group), productId: id, document, digest: documentDigest(document), variants };
  });
}
