import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommerceQuoteCatalogReadError } from '@openlup/platform/pricing';
import { canonicalCatalogDraftJson, catalogDefinitionDigest, createCatalogProductTypeRegistry, withCatalogPublicationRules,
  type CatalogDefinitionInstallReceipt, type CatalogProductTypeInput, type CatalogProductTypeRef, type NeutralSkuEnvelopeV1 } from '@openlup/platform/catalog';
import { catalogDraftRegistry } from '../owned/catalogue.ts';
import { isRecord } from '../shared/offer.ts';
import type { StoreConfig } from '../shared/config.ts';
import type { EditorProduct } from '../shared/subscription-edit.ts';

export const starterCatalogueType = { key: 'starter:item', version: 1 } as const;
const buildDirectory = fileURLToPath(new URL('../.context/catalogue-builds', import.meta.url));

function readOptional(path: URL | string): Buffer | undefined {
  try { return readFileSync(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function readStarterCatalogueRules(): Buffer | undefined {
  return readOptional(new URL('../owned/catalogue-rules.cjs', import.meta.url));
}

/** The installer and operator host run from the same image built by lifecycle up. */
export function starterCataloguePack(artifact: Uint8Array) {
  const definition = catalogDraftRegistry.resolve(starterCatalogueType);
  if (!definition) throw new Error('Define starter:item at version 1 in owned/catalogue.ts to install catalogue rules.');
  const { validateContent: _legacyRule, validatorRef: _legacyRef, ...legacyType } = definition;
  const unit = 'openlup:g';
  const catalogueType = { ...legacyType,
    units: legacyType.units.some(row => row.code === unit) ? legacyType.units
      : [...legacyType.units, { code: unit, dimension: 'mass' as const, integral: true }],
    netContentUnits: [...new Set([...legacyType.netContentUnits, unit])],
  };
  // Keep version 1 for the shipped draft example. The immutable installer refuses a collision.
  const version = 2 + createHash('sha256').update(canonicalCatalogDraftJson(catalogueType)).update(artifact).digest().readUInt32BE() % 2_147_483_646;
  return starterBuild({ ...catalogueType, version }, artifact);
}

function starterBuild(type: Omit<CatalogProductTypeInput, 'validateContent'>, artifact: Uint8Array) {
  return withCatalogPublicationRules({ id: 'starter:local-rules', namespace: 'starter', version: type.version, openlupRange: '1.x',
    types: [type], capabilities: {}, taxClasses: [] }, () => artifact);
}

/** Stage the receipt and exact rules. Only a committed install may publish their link. */
export function stageStarterCatalogueBuild(artifact: Buffer, receipt: CatalogDefinitionInstallReceipt, directory = buildDirectory) {
  const definition = starterCataloguePack(artifact).types[0]!;
  const { validateContent: _callback, ...type } = definition;
  const installed = receipt.types.find(row => row.key === type.key && row.version === type.version);
  if (!installed || installed.definitionDigest !== catalogDefinitionDigest(definition)) throw new Error('starter_catalogue_install_receipt_invalid');
  const bytes = Buffer.from(canonicalCatalogDraftJson({ type, asset: artifact.toString('base64'), installed }));
  mkdirSync(directory, { recursive: true });
  const target = join(directory, `${type.version}.json`);
  const previous = readOptional(target);
  if (previous) {
    if (!previous.equals(bytes)) throw Object.assign(new Error('starter_catalogue_build_conflict'), { code: 'EEXIST' });
    return;
  }
  const temp = mkdtempSync(join(directory, '.pending-'));
  const source = join(temp, 'build.json');
  const discard = () => rmSync(temp, { recursive: true, force: true });
  try { writeFileSync(source, bytes); }
  catch (error) { discard(); throw error; }
  return {
    publish() {
      try { linkSync(source, target); }
      catch (error) { if (!readOptional(target)?.equals(bytes)) throw error; }
    },
    discard,
  };
}

export function starterCatalogue(directory = buildDirectory) {
  const artifact = readStarterCatalogueRules();
  const pack = artifact && starterCataloguePack(artifact);
  const current = pack && createCatalogProductTypeRegistry(pack.types).resolve(pack.types[0]!);
  const history = new Map<number, { type: NonNullable<typeof current>; digest: string }>();
  function readInstalled(ref: CatalogProductTypeRef) {
    if (ref.key !== starterCatalogueType.key || !Number.isSafeInteger(ref.version) || ref.version <= 1) return;
    const cached = history.get(ref.version);
    if (cached) return cached;
    // A visible receipt link was published only after its definition committed.
    const raw = readOptional(join(directory, `${ref.version}.json`));
    if (!raw) return;
    const { type, asset, installed } = JSON.parse(raw.toString()) as {
      type: Omit<CatalogProductTypeInput, 'validateContent'>; asset: string;
      installed: CatalogDefinitionInstallReceipt['types'][number];
    };
    if (type.key !== ref.key || type.version !== ref.version || installed.key !== ref.key || installed.version !== ref.version)
      throw new Error('starter_catalogue_build_invalid');
    const restored = starterBuild(type, Buffer.from(asset, 'base64'));
    const definition = createCatalogProductTypeRegistry(restored.types).resolve(ref)!;
    const digest = catalogDefinitionDigest(definition);
    if (digest !== installed.definitionDigest) throw new Error('starter_catalogue_build_invalid');
    const build = { type: definition, digest };
    history.set(ref.version, build);
    return build;
  }
  return { current, readInstalled, registry: { resolve: (ref: CatalogProductTypeRef) =>
    readInstalled(ref)?.type ?? catalogDraftRegistry.resolve(ref) } };
}

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
