import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommerceQuoteCatalogReadError } from '@openlup/platform/pricing';
import { canonicalCatalogDraftJson, catalogDefinitionDigest, catalogPackIssues, createCatalogProductTypeRegistry, withCatalogPublicationRules,
  type CatalogDefinitionInstallReceipt, type CatalogProductTypeInput, type CatalogProductTypeRef, type CatalogProductTypeRegistry, type NeutralSkuEnvelopeV1 } from '@openlup/platform/catalog';
import { catalogDraftRegistry } from '../owned/catalogue.ts';
import { isRecord } from '../shared/offer.ts';
import type { StoreConfig } from '../shared/config.ts';
import type { EditorProduct } from '../shared/subscription-edit.ts';

export const starterCatalogueType = { key: 'starter:item', version: 1 } as const;
const authoringRegistry: CatalogProductTypeRegistry = catalogDraftRegistry;
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

const identity = (ref: CatalogProductTypeRef) => `${ref.key}@${ref.version}`;
const base = (ref: CatalogProductTypeRef) => identity(ref) === identity(starterCatalogueType);
const rulesPin = (type: Omit<CatalogProductTypeInput, 'validateContent'>, artifact: Uint8Array) =>
  2 + createHash('sha256').update(canonicalCatalogDraftJson(type)).update(artifact).digest().readUInt32BE() % 2_147_483_646;

function starterBuild(type: Omit<CatalogProductTypeInput, 'validateContent'>, artifact: Uint8Array) {
  const namespace = type.key.split(':', 1)[0]!;
  return withCatalogPublicationRules({ id: `${namespace}:local-rules`, namespace, version: type.version, openlupRange: '1.x',
    types: [type], capabilities: {}, taxClasses: [] }, () => artifact);
}

function preflightRefusal(code: string, path: string, hint: string): never {
  throw Object.assign(new Error(code), { issue: { code, path }, hint });
}

/** Both filename formats reserve the version even when the build needs restoration. */
export function assertStarterCataloguePins(names: readonly string[]) {
  for (const name of names) {
    const match = /^(?:([a-z0-9.-]+)%3A([a-z0-9._-]+)@)?([1-9][0-9]*)\.json$/u.exec(name);
    if (!match) continue;
    const key = match[1] ? `${match[1]}:${match[2]}` : starterCatalogueType.key;
    const version = Number(match[3]);
    if (version <= 1 || version > 2_147_483_647 || !authoringRegistry.resolve({ key, version })) continue;
    preflightRefusal('starter_catalogue_rules_version_conflict', '/version',
      `Choose a different version number for ${key}. Version ${version} is already an installed pin.`);
  }
}

export function starterCataloguePack(artifact: Uint8Array) {
  const definition = authoringRegistry.resolve(starterCatalogueType);
  if (!definition) preflightRefusal('starter_catalogue_rules_base_required', '/type',
    'Define starter:item at version 1 in owned/catalogue.ts to install catalogue rules.');
  const { validateContent: _inline, validatorRef: _ref, ...metadata } = definition;
  const unit = 'openlup:g';
  const type = { ...metadata,
    units: metadata.units.some(row => row.code === unit) ? metadata.units
      : [...metadata.units, { code: unit, dimension: 'mass' as const, integral: true }],
    netContentUnits: [...new Set([...metadata.netContentUnits, unit])],
  };
  return starterBuild({ ...type, version: rulesPin(type, artifact) }, artifact);
}

/** Preflight the existing single-type rules install. */
export function prepareStarterCatalogueRules(rules: Uint8Array | undefined, directory = buildDirectory) {
  try { assertStarterCataloguePins(readdirSync(directory)); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (!rules) return;
  const artifact = Buffer.from(rules);
  const pack = starterCataloguePack(artifact);
  const pin = pack.types[0]!;
  if (authoringRegistry.resolve(pin))
    preflightRefusal('starter_catalogue_rules_version_conflict', '/version', `Choose a different version number for ${pin.key}.`);
  const issue = catalogPackIssues(pack)[0];
  if (issue) preflightRefusal(issue.code, issue.path, 'Correct the indicated definition field.');
  return { artifact, pack };
}

const fileName = (ref: CatalogProductTypeRef) => `${encodeURIComponent(ref.key)}@${ref.version}.json`;

/** Publish a verified build only after its definition install commits. */
export function stageStarterCatalogueBuild(artifact: Buffer, pack: ReturnType<typeof starterBuild>,
  receipt: CatalogDefinitionInstallReceipt, directory = buildDirectory) {
  const definition = pack.types[0]!;
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
  const plan = prepareStarterCatalogueRules(readStarterCatalogueRules(), directory);
  const current = plan?.pack.types[0];
  const history = new Map<string, { type: NonNullable<ReturnType<typeof authoringRegistry.resolve>>; digest: string; legacy: boolean }>();
  const corrupt = new Set<string>();
  function readInstalled(ref: CatalogProductTypeRef) {
    if (!Number.isSafeInteger(ref.version) || ref.version <= 1) return;
    const cached = history.get(identity(ref));
    if (cached) return cached;
    const keyed = readOptional(join(directory, fileName(ref)));
    const legacy = keyed === undefined && ref.key === starterCatalogueType.key;
    const raw = keyed ?? (legacy ? readOptional(join(directory, `${ref.version}.json`)) : undefined);
    corrupt.delete(identity(ref));
    if (!raw) return;
    try {
      const { type, asset, installed } = JSON.parse(raw.toString()) as {
        type: Omit<CatalogProductTypeInput, 'validateContent'>; asset: string;
        installed: CatalogDefinitionInstallReceipt['types'][number];
      };
      if (identity(type) !== identity(ref) || identity(installed) !== identity(ref))
        throw new Error('starter_catalogue_build_invalid');
      const restored = starterBuild(type, Buffer.from(asset, 'base64'));
      const definition = createCatalogProductTypeRegistry(restored.types).resolve(ref)!;
      const digest = catalogDefinitionDigest(definition);
      if (digest !== installed.definitionDigest || type.validatorRef !== definition.validatorRef)
        throw new Error('starter_catalogue_build_invalid');
      const build = { type: definition, digest, legacy };
      history.set(identity(ref), build);
      return build;
    } catch {
      corrupt.add(identity(ref));
    }
  }
  const registry = { resolve: (ref: CatalogProductTypeRef) => readInstalled(ref)?.type ?? authoringRegistry.resolve(ref) };
  const pinnedRegistry = { resolve: (ref: CatalogProductTypeRef) => readInstalled(ref)?.type
    ?? (plan ? undefined : authoringRegistry.resolve(ref)) };
  const legacyRegistry = { resolve(ref: CatalogProductTypeRef) {
    const installed = readInstalled(ref);
    return installed?.legacy ? installed.type : authoringRegistry.resolve(ref);
  } };
  return {
    current, baseType: current,
    registry, pinnedRegistry, legacyRegistry, readInstalled,
    isCorrupt: (ref: CatalogProductTypeRef) => corrupt.has(identity(ref)),
    isInline: (ref: CatalogProductTypeRef) => Boolean(authoringRegistry.resolve(ref)),
    currentFor: (ref: CatalogProductTypeRef) => base(ref) ? current : undefined,
    resolveSave: (ref: CatalogProductTypeRef) => pinnedRegistry.resolve((base(ref) && current) || ref),
    derivesPin: (ref: CatalogProductTypeRef) => current !== undefined && identity(current) === identity(ref),
    hasRegisteredKey: (ref: CatalogProductTypeRef) => ref.key === starterCatalogueType.key || Boolean(authoringRegistry.resolve(ref)),
  };
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
