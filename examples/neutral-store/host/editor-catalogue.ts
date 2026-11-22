import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommerceQuoteCatalogReadError } from '@openlup/platform/pricing';
import { CATALOG_CANONICAL_UNITS, type CatalogQuantity } from '@openlup/core/catalog';
import type { CatalogDraftClaimV3 } from '@openlup/platform/catalog/contracts';
import { canonicalCatalogDraftJson, catalogDefinitionDigest, createCatalogProductTypeRegistry, withCatalogPublicationRules,
  type CatalogDefinitionInstallReceipt, type CatalogProductTypeInput, type CatalogProductTypeRef, type NeutralSkuEnvelopeV1 } from '@openlup/platform/catalog';
import { catalogDraftRegistry } from '../owned/catalogue.ts';
import { isRecord } from '../shared/offer.ts';
import type { StoreConfig } from '../shared/config.ts';
import type { EditorProduct } from '../shared/subscription-edit.ts';

// Admit owned definitions at host import, including hosts without a rules file.
void catalogDraftRegistry.resolve;

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
type GramVariant = ProductDocument['variants'][number];
type GramPhysical = GramVariant['physical'];
type TypedPhysical = { netContent: CatalogQuantity; issuer: string; unitGtin: string };
type MixedVariant = Omit<GramVariant, 'physical'> & { physical: GramPhysical | TypedPhysical };
type MixedProductDocument = Omit<ProductDocument, 'variants'> & { variants: MixedVariant[] };
type PrimaryUnitGtin = Pick<GramPhysical, 'issuer' | 'unitGtin'>;

function gramPhysical(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.netWeightG) && Number(value.netWeightG) > 0;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function typedPhysical(value: Record<string, unknown>): boolean {
  const net = value.netContent;
  return hasExactKeys(value, ['netContent', 'issuer', 'unitGtin'])
    && isRecord(net) && hasExactKeys(net, ['dimension', 'unit', 'unscaled', 'scale'])
    && (net.dimension === 'volume' || net.dimension === 'count') && net.unit === CATALOG_CANONICAL_UNITS[net.dimension]
    && typeof net.unscaled === 'string' && /^[1-9][0-9]{0,39}$/u.test(net.unscaled)
    && typeof net.scale === 'number' && Number.isInteger(net.scale) && net.scale >= 0 && net.scale <= 12
    && (net.scale === 0 || net.dimension === 'volume' && !net.unscaled.endsWith('0'));
}

function parseProductDocument(value: unknown, schemaId: string, physical: (value: Record<string, unknown>) => boolean): MixedProductDocument {
  if (!isRecord(value) || value.schemaVersion !== schemaId || Object.keys(value).length !== 6
    || typeof value.productId !== 'string' || typeof value.productSlug !== 'string'
    || !Number.isSafeInteger(value.revisionNo) || Number(value.revisionNo) < 1 || typeof value.sourceRef !== 'string'
    || !Array.isArray(value.variants) || !value.variants.length || value.variants.some(row => !isRecord(row)
      || typeof row.skuId !== 'string' || typeof row.sku !== 'string' || !isRecord(row.physical)
      || !physical(row.physical)
      || typeof row.physical.issuer !== 'string' || typeof row.physical.unitGtin !== 'string'
      || !Number.isSafeInteger(row.demandPerUnit) || Number(row.demandPerUnit) <= 0
      || !Array.isArray(row.exclusions) || row.exclusions.some(key => typeof key !== 'string' || !key))) {
    throw new CommerceQuoteCatalogReadError('catalog_document_schema_invalid');
  }
  return value as MixedProductDocument;
}

export function productDocument(value: unknown, schemaId: string): ProductDocument {
  return parseProductDocument(value, schemaId, gramPhysical) as ProductDocument;
}

/** Evidence supplied by the installed reader on the same loan and snapshot. */
export interface MixedProductRead {
  operation: object;
  evidence: {
    operation: object;
    productId: string;
    documentRevisionId: string;
    documentDigest: string;
    siblings: readonly {
      skuId: string; sku: string; netContent: CatalogQuantity; primaryUnitGtin: PrimaryUnitGtin; issuingDraft: CatalogDraftClaimV3;
    }[];
  };
}

class MixedProductDocumentError extends CommerceQuoteCatalogReadError {
  readonly path: 'documentRevision' | 'documentRevision.digest';
  readonly fix: string;
  constructor(code: 'catalog_document_schema_invalid' | 'catalog_document_digest_mismatch') {
    super(code);
    this.path = code === 'catalog_document_schema_invalid' ? 'documentRevision' : 'documentRevision.digest';
    this.fix = code === 'catalog_document_schema_invalid'
      ? 'Recover the admitted document and its revision.'
      : 'Replay the original document bytes and digest.';
  }
}

function isMixedSibling(row: unknown): row is MixedProductRead['evidence']['siblings'][number] {
  if (!isRecord(row) || typeof row.skuId !== 'string' || typeof row.sku !== 'string'
    || !isRecord(row.primaryUnitGtin) || typeof row.primaryUnitGtin.issuer !== 'string' || typeof row.primaryUnitGtin.unitGtin !== 'string'
    || !isRecord(row.issuingDraft) || typeof row.issuingDraft.draftId !== 'string'
    || !Number.isSafeInteger(row.issuingDraft.revision) || typeof row.issuingDraft.commandKey !== 'string'
    || typeof row.issuingDraft.fingerprint !== 'string') return false;
  return typedPhysical({ netContent: row.netContent, issuer: row.primaryUnitGtin.issuer, unitGtin: row.primaryUnitGtin.unitGtin });
}

function verifyMixedProductDocument(value: unknown, schemaId: string, read: MixedProductRead,
  expected: { productId: unknown; documentRevisionId: unknown; documentDigest: unknown }): MixedProductDocument {
  if (documentDigest(value) !== expected.documentDigest)
    throw new MixedProductDocumentError('catalog_document_digest_mismatch');
  const { evidence } = read;
  const invalid = (): never => { throw new MixedProductDocumentError('catalog_document_schema_invalid'); };
  if (read.operation !== evidence.operation || expected.productId !== evidence.productId
    || expected.documentRevisionId !== evidence.documentRevisionId || expected.documentDigest !== evidence.documentDigest) invalid();
  let parsed: MixedProductDocument;
  try {
    parsed = parseProductDocument(value, schemaId, physical =>
      Object.hasOwn(physical, 'netContent') ? typedPhysical(physical) : gramPhysical(physical));
  } catch (error) {
    if (error instanceof CommerceQuoteCatalogReadError) return invalid();
    throw error;
  }
  if (!Array.isArray(evidence.siblings)) return invalid();
  const siblings = new Map<string, MixedProductRead['evidence']['siblings'][number]>();
  for (const row of evidence.siblings) {
    if (!isMixedSibling(row)) return invalid();
    siblings.set(row.skuId.toLowerCase(), row);
  }
  if (siblings.size !== evidence.siblings.length || siblings.size === 0) invalid();
  const ids = new Set<string>(), codes = new Set<string>();
  for (const { skuId, sku, physical } of parsed.variants) {
    const id = skuId.toLowerCase();
    if (ids.has(id) || codes.has(sku)) invalid();
    ids.add(id);
    codes.add(sku);
    if (!('netContent' in physical)) continue;
    const sibling = siblings.get(id), net = physical.netContent, admitted = sibling?.netContent;
    const gtin = sibling?.primaryUnitGtin;
    if (!sibling || !admitted || !gtin || sibling.sku !== sku || physical.issuer !== gtin.issuer
      || physical.unitGtin !== gtin.unitGtin
      || net.dimension !== admitted.dimension || net.unit !== admitted.unit || net.unscaled !== admitted.unscaled
      || net.scale !== admitted.scale) invalid();
    siblings.delete(id);
  }
  if (siblings.size) invalid();
  return parsed;
}

export function verifyProductDocument(value: unknown, envelope: NeutralSkuEnvelopeV1, schemaId: string, mixed?: MixedProductRead): void {
  const { product, sku, documentRevision } = envelope;
  const parsed = mixed ? verifyMixedProductDocument(value, schemaId, mixed, {
    productId: product.id, documentRevisionId: documentRevision.id, documentDigest: documentRevision.digest,
  }) : productDocument(value, schemaId);
  const variants = parsed.variants.filter(row => row.skuId.toLowerCase() === sku.id.toLowerCase() && row.sku === sku.code);
  const variant = variants[0];
  if (parsed.productId.toLowerCase() !== product.id.toLowerCase() || parsed.productSlug !== product.slug
    || parsed.schemaVersion !== documentRevision.schemaId || parsed.revisionNo !== documentRevision.revisionNo
    || parsed.sourceRef !== documentRevision.sourceRef || variants.length !== 1 || !variant
    || !('netWeightG' in variant.physical) || variant.physical.netWeightG !== sku.netContent.unscaled
    || !envelope.identifiers.some(identifier => identifier.isPrimary && identifier.kind === 'gtin'
      && (!mixed || identifier.packKind === 'unit' && identifier.packQuantity === 1)
      && identifier.issuer === variant.physical.issuer && identifier.normalizedValue === variant.physical.unitGtin)) {
    if (mixed) throw new MixedProductDocumentError('catalog_document_schema_invalid');
    throw new CommerceQuoteCatalogReadError('catalog_document_schema_invalid');
  }
  if (!mixed && documentDigest(value) !== documentRevision.digest) throw new CommerceQuoteCatalogReadError('catalog_document_digest_mismatch');
}

export function verifySizedProductDocument(value: unknown, schemaId: string,
  selection: { skuId: unknown; sku: unknown; productId: unknown; netWeightG: unknown; documentRevisionId: unknown; documentDigest: unknown },
  mixed?: MixedProductRead & { primaryUnitGtin: PrimaryUnitGtin }): GramVariant {
  const parsed = mixed ? verifyMixedProductDocument(value, schemaId, mixed, selection) : productDocument(value, schemaId);
  const variant = parsed.variants.find(row => row.skuId === selection.skuId && row.sku === selection.sku);
  if (!variant || parsed.productId !== selection.productId || !('netWeightG' in variant.physical)
    || variant.physical.netWeightG !== selection.netWeightG
    || (mixed ? variant.physical.issuer !== mixed.primaryUnitGtin.issuer || variant.physical.unitGtin !== mixed.primaryUnitGtin.unitGtin
      : documentDigest(parsed) !== selection.documentDigest)) {
    if (mixed) throw new MixedProductDocumentError('catalog_document_schema_invalid');
    throw new Error('subscription_reprice_sized_catalog_facts_unreadable');
  }
  return variant as GramVariant;
}
