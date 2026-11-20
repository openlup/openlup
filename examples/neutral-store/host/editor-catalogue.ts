import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommerceQuoteCatalogReadError } from '@openlup/platform/pricing';
import { canonicalCatalogDraftJson, catalogDefinitionDigest, catalogPackIssues, createCatalogProductTypeRegistry, withCatalogPublicationRules,
  type CatalogDefinitionInstallReceipt, type CatalogProductTypeInput, type CatalogProductTypeRef, type CatalogProductTypeRegistry, type NeutralSkuEnvelopeV1 } from '@openlup/platform/catalog';
import { catalogDraftRegistry } from '../owned/catalogue.ts';
import { isRecord } from '../shared/offer.ts';
import type { StoreConfig } from '../shared/config.ts';
import type { EditorProduct } from '../shared/subscription-edit.ts';

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

function derivationRefusal(code: string, hint: string): never {
  throw Object.assign(new Error(code), { hint });
}

function rulesVersion(type: Omit<CatalogProductTypeInput, 'validateContent'>, artifact: Uint8Array): number {
  return 2 + createHash('sha256').update(canonicalCatalogDraftJson(type)).update(artifact).digest().readUInt32BE() % 2_147_483_646;
}

/** The installer and operator host run from the same image built by lifecycle up. */
function starterCatalogueBuilds(artifact: Uint8Array) {
  const definitions = authoringRegistry.definitions;
  if (!definitions) derivationRefusal('starter_catalogue_rules_registry_required',
    'In owned/catalogue.ts, export the registry returned by createCatalogProductTypeRegistry, or provide its definitions list.');
  const identities = new Set<string>();
  return definitions.map(authoring => {
    const { validateContent: _legacyRule, validatorRef: _legacyRef, ...legacyType } = authoring;
    const reference = authoring.taxClass !== undefined ? ['taxClass', authoring.taxClass]
      : authoring.subscriptionProfileRef !== undefined ? ['subscriptionProfileRef', typeIdentity(authoring.subscriptionProfileRef)] : undefined;
    if (reference) derivationRefusal('starter_catalogue_rules_reference_unsupported',
      `Remove ${reference[0]} from ${typeIdentity(authoring)} in owned/catalogue.ts for starter preview. The starter cannot supply ${reference[0]} ${reference[1]}.`);
    const unit = 'openlup:g';
    const catalogueType = { ...legacyType,
      units: legacyType.units.some(row => row.code === unit) ? legacyType.units
        : [...legacyType.units, { code: unit, dimension: 'mass' as const, integral: true }],
      netContentUnits: [...new Set([...legacyType.netContentUnits, unit])],
    };
    // Keep the version derivation and installer identity used by retained builds.
    const version = rulesVersion(catalogueType, artifact);
    const pack = starterBuild({ ...catalogueType, version }, artifact);
    const identity = `${pack.id}@${version}`;
    if (authoringRegistry.resolve({ key: authoring.key, version }) || identities.has(identity))
      derivationRefusal('starter_catalogue_rules_version_conflict',
        `Change the colliding authoring version for ${typeIdentity(authoring)} in owned/catalogue.ts, then run ./lifecycle up.`);
    const issue = catalogPackIssues(pack)[0];
    if (issue) derivationRefusal('starter_catalogue_rules_definition_invalid',
      `Correct ${typeIdentity(authoring)} in owned/catalogue.ts. ${issue.code} at ${issue.path}.`);
    identities.add(identity);
    return { authoring: { key: authoring.key, version: authoring.version }, pack };
  });
}

export function prepareStarterCatalogueRules(rules: Uint8Array | undefined) {
  if (!rules) return;
  const artifact = Buffer.from(rules);
  return { artifact, builds: starterCatalogueBuilds(artifact) };
}

function starterBuild(type: Omit<CatalogProductTypeInput, 'validateContent'>, artifact: Uint8Array) {
  const namespace = type.key.split(':', 1)[0]!;
  return withCatalogPublicationRules({ id: `${namespace}:local-rules`, namespace, version: type.version, openlupRange: '1.x',
    types: [type], capabilities: {}, taxClasses: [] }, () => artifact);
}

const typeIdentity = (ref: CatalogProductTypeRef) => `${ref.key}@${ref.version}`;
const buildFile = (ref: CatalogProductTypeRef) => `${encodeURIComponent(ref.key)}@${ref.version}.json`;
const legacyBuildFile = (ref: CatalogProductTypeRef) => `${ref.version}.json`;

/** Stage the receipt and exact rules. Only a committed install may publish their link. */
export function stageStarterCatalogueBuild(artifact: Buffer, pack: ReturnType<typeof starterBuild>,
  authoring: CatalogProductTypeRef, receipt: CatalogDefinitionInstallReceipt, singleType: boolean, directory = buildDirectory) {
  const definition = pack.types[0]!;
  const { validateContent: _callback, ...type } = definition;
  const installed = receipt.types.find(row => row.key === type.key && row.version === type.version);
  if (!installed || installed.definitionDigest !== catalogDefinitionDigest(definition)) throw new Error('starter_catalogue_install_receipt_invalid');
  const record = { type, asset: artifact.toString('base64'), installed };
  const bytes = Buffer.from(canonicalCatalogDraftJson({ ...record, authoring }));
  const legacyBytes = Buffer.from(canonicalCatalogDraftJson(record));
  const sameBuild = (previous: Buffer | undefined) => previous?.equals(bytes) || previous?.equals(legacyBytes);
  mkdirSync(directory, { recursive: true });
  // Preserve the original volume format for a one-type installation.
  const target = join(directory, singleType ? legacyBuildFile(type) : buildFile(type));
  const previous = readOptional(target);
  if (previous) {
    if (!sameBuild(previous)) throw Object.assign(new Error('starter_catalogue_build_conflict'), { code: 'EEXIST' });
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
      catch (error) { if (!sameBuild(readOptional(target))) throw error; }
    },
    discard,
  };
}

export function starterCatalogue(directory = buildDirectory) {
  const builds = prepareStarterCatalogueRules(readStarterCatalogueRules())?.builds ?? [];
  const currentByAuthoring = new Map(builds.map(({ authoring, pack }) => [typeIdentity(authoring), pack.types[0]!]));
  const currentPins = [...currentByAuthoring.values()];
  const currentIdentities = new Set(currentPins.map(typeIdentity));
  const registeredKeys = new Set(authoringRegistry.definitions?.map(type => type.key));
  const history = new Map<string, { type: NonNullable<ReturnType<typeof authoringRegistry.resolve>>; digest: string;
    authoring?: CatalogProductTypeRef; matchesLegacyAuthoring: (ref: CatalogProductTypeRef) => boolean }>();
  function readInstalled(ref: CatalogProductTypeRef) {
    if (!Number.isSafeInteger(ref.version) || ref.version <= 1) return;
    const identity = typeIdentity(ref);
    const cached = history.get(identity);
    if (cached) return cached;
    // A visible receipt link was published only after its definition committed.
    const keyed = readOptional(join(directory, buildFile(ref)));
    const raw = keyed ?? readOptional(join(directory, legacyBuildFile(ref)));
    if (!raw) return;
    const { type, asset, installed, authoring } = JSON.parse(raw.toString()) as {
      type: Omit<CatalogProductTypeInput, 'validateContent'>; asset: string;
      installed: CatalogDefinitionInstallReceipt['types'][number];
      authoring?: CatalogProductTypeRef;
    };
    if (!keyed && type.key !== ref.key) return;
    if (type.key !== ref.key || type.version !== ref.version || installed.key !== ref.key || installed.version !== ref.version)
      throw new Error('starter_catalogue_build_invalid');
    const bytes = Buffer.from(asset, 'base64');
    const { validatorRef: _validator, publicationRules: _binding, ...metadata } = type;
    // The legacy receipt kept the installed definition and artifact. Recompute its pin
    // from the submitted authoring version and the retained bytes, never today's files.
    const matchesLegacyAuthoring = (source: CatalogProductTypeRef) => source.key === type.key
      && [metadata, { ...metadata, publicationRules: true as const }]
        .some(candidate => rulesVersion({ ...candidate, version: source.version }, bytes) === type.version);
    if (authoring && !matchesLegacyAuthoring(authoring))
      throw new Error('starter_catalogue_build_invalid');
    const restored = starterBuild(type, bytes);
    const definition = createCatalogProductTypeRegistry(restored.types).resolve(ref)!;
    const digest = catalogDefinitionDigest(definition);
    if (digest !== installed.definitionDigest) throw new Error('starter_catalogue_build_invalid');
    const build = { type: definition, digest, ...(authoring && { authoring }), matchesLegacyAuthoring };
    history.set(identity, build);
    return build;
  }
  return {
    current: currentPins[0], readInstalled,
    firstInstalled() {
      for (const pin of currentPins) {
        const installed = readInstalled(pin);
        if (installed) return installed.type;
      }
    },
    currentFor: (ref: CatalogProductTypeRef) => currentByAuthoring.get(typeIdentity(ref)),
    derivesPin: (ref: CatalogProductTypeRef) => currentIdentities.has(typeIdentity(ref)),
    hasRegisteredKey: (ref: CatalogProductTypeRef) => registeredKeys.has(ref.key) || !!authoringRegistry.resolve(ref),
    matchesAuthoring(pin: CatalogProductTypeRef, source: CatalogProductTypeRef) {
      if (pin.key !== source.key) return false;
      const build = readInstalled(pin);
      if (build?.authoring) return typeIdentity(build.authoring) === typeIdentity(source);
      if (build) {
        const matches = authoringRegistry.definitions?.filter(build.matchesLegacyAuthoring);
        return matches?.length === 1 && build.matchesLegacyAuthoring(source);
      }
      const current = currentByAuthoring.get(typeIdentity(source));
      return pin.version === source.version || current?.version === pin.version;
    },
    registry: { resolve: (ref: CatalogProductTypeRef) => readInstalled(ref)?.type ?? authoringRegistry.resolve(ref) },
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
