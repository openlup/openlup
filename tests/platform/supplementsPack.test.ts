import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { canonicalizeCatalogQuantity, convertCatalogQuantity } from '@openlup/core/catalog';
import {
  catalogDefinitionDigest, catalogDraftPayloadV3Schema, catalogDraftPayloadV4Schema, catalogDraftPayloadV5Schema,
  catalogPackIssues, createCatalogProductTypeRegistry, prepareCatalogAttributeProjection, validateCatalogAttributes, type CatalogAttributeProjectionRow,
} from '@openlup/platform/catalog';
import { applyAppUpgrade } from '@openlup/platform/lifecycle';
import { deriveSubscriptionUnitPrice } from '@openlup/platform/pricing';
import { createCatalogSubscriptionProfileBinding } from '@openlup/platform/subscriptions';
import { catalogueConformance, catalogDraftRegistry, supplementsCatalogueRegistration } from '../../examples/neutral-store/owned/catalogue.ts';
import { marketFixture } from '../../examples/catalog-packs/market-fictional/tax-table.ts';
import { initialDrafts, initialPublications, proposedTaxonomy, successor, withdrawal } from '../../examples/catalog-packs/supplements/catalogue.ts';
import { agreedTerms, fixtures, purchase, upgrade } from '../../examples/catalog-packs/supplements/fixtures.ts';
import { itemType, pack, profileRef } from '../../examples/catalog-packs/supplements/pack.ts';
import { checkAge, policy, scoopMass, units } from '../../examples/catalog-packs/supplements/policy.ts';

const root = fileURLToPath(new URL('../../examples/', import.meta.url));
const packPaths = ['catalogue.ts', 'fixtures.ts', 'pack.ts', 'policy.ts'].map(name => `catalog-packs/supplements/${name}`);
const ownedPaths = [...packPaths, 'market-packs/market-fictional/tax-table.ts'];
const [capsule, powder] = initialDrafts;
const definition = createCatalogProductTypeRegistry(supplementsCatalogueRegistration.pack.types).resolve(itemType)!;
const formatAttribute = pack.types[0].attributes[0];

it.each<[string, () => unknown]>([
  ['RP1-D-002a document evidence and validator artifact', () => {
    expect(catalogPackIssues(pack)).toEqual([]);
    const source = readFileSync(join(root, 'catalog-packs/supplements/policy.ts'));
    expect(pack.types[0].validatorRef).toBe('sha256:' + createHash('sha256').update(source).digest('hex'));
    for (const [entry, ingredient, evidence] of [
      [capsule, 'Fictional amber blend', 'fixture:supplements/capsule/1'],
      [powder, 'Fictional white blend', 'fixture:supplements/powder/1'],
    ] as const) {
      expect(entry.payload.product.sharedContent.document).toMatchObject({
        ingredients: [ingredient], supplementFacts: ['Synthetic serving declaration'],
        allergens: ['Fictional amber allergen'], warnings: ['Demonstration label for adults'],
        claims: ['Fictional label display'], evidence: [evidence], adultsOnly: true,
      });
    }
  }],
  ['RP1-D-002b missing evidence', () => {
    const content = structuredClone(capsule.payload.product.sharedContent);
    delete content.document!.evidence;
    expect(definition.validateContent(content)).toEqual([{ path: 'document.evidence', code: 'evidence_required' }]);
  }],
  ['RP1-D-002c filterable public format', async () => {
    expect(formatAttribute).toMatchObject({ key: 'format', filterable: true, public: true });
    const rows: Readonly<CatalogAttributeProjectionRow>[] = [];
    for (const fixture of fixtures.attributes.slice(0, 2)) {
      const prepared = prepareCatalogAttributeProjection(await validateCatalogAttributes(definition, fixture.input), '1');
      if (!prepared.prepared) throw new Error('Expected a ready attribute projection');
      rows.push(...prepared.rows);
    }
    expect(rows.filter(row => row.attribute_key === 'format')).toHaveLength(2);
    expect(rows.filter(row => row.attribute_key === 'format' && row.text_value === 'capsule').map(row => row.sku_id)).toEqual([capsule.skuId]);
    expect(rows.map(row => row.attribute_key)).not.toContain('evidence');
  }],
  ['RP1-D-003a one registry entry', () => {
    expect(catalogueConformance.packs.map(({ pack }) => pack.id)).toEqual(['supplements']);
    expect(catalogueConformance.packs[0]?.pack).toBe(supplementsCatalogueRegistration.pack);
    expect(supplementsCatalogueRegistration).toMatchObject({
      draftType: { key: 'supplements:item', version: 1 }, offerVersion: 'supplements:regular@1',
    });
    expect(definition).toBeDefined();
    expect(catalogDraftRegistry.resolve({ key: 'starter:item', version: 1 })).toBeDefined();
  }],
  ['RP1-D-004a canonical count', () => {
    expect(canonicalizeCatalogQuantity(capsule.netContent, units)).toEqual({ dimension: 'count', unit: 'openlup:piece', unscaled: '56', scale: 0 });
  }],
  ['RP1-D-004b canonical mass', () => {
    expect(canonicalizeCatalogQuantity(powder.netContent, units)).toEqual({ dimension: 'mass', unit: 'openlup:g', unscaled: '140', scale: 0 });
  }],
  ['RP1-D-004c supplements_count_and_consumption_are_distinct', () => {
    expect(capsule.payload.product.sharedContent.document?.serving).toEqual({ perContainer: 28, unit: 'capsule_pair' });
    expect(powder.payload.product.sharedContent.document?.serving).toEqual({ perContainer: 28, unit: 'scoop' });
    expect(scoopMass).toEqual({ dimension: 'mass', unit: 'openlup:g', unscaled: '5', scale: 0 });
  }],
  ['RP1-D-004d cross dimension refuses', () => {
    expect(() => convertCatalogQuantity(capsule.netContent, 'openlup:g', units)).toThrow('quantity_cross_dimension');
  }],
  ['RP1-D-004e gross mass and format', () => {
    expect([capsule, powder, successor].map(({ payload }) =>
      [payload.skus[0]?.grossMass, payload.skus[0]?.attributes?.format])).toEqual([
      [{ dimension: 'mass', unit: 'openlup:g', unscaled: '92', scale: 0 }, 'capsule'],
      [{ dimension: 'mass', unit: 'openlup:g', unscaled: '172', scale: 0 }, 'powder'],
      [{ dimension: 'mass', unit: 'openlup:g', unscaled: '96', scale: 0 }, 'capsule'],
    ]);
  }],
  ['RP1-D-007a separate market and class default', () => {
    expect(pack.taxClasses).toEqual([{ key: 'reduced-supplement' }]);
    expect(definition.taxClass).toBe('reduced-supplement');
    expect(marketFixture).toEqual({ country: 'ZZ', currency: 'XTS', currencyExponent: 2,
      rates: [{ taxClass: 'reduced-supplement', rateBps: 0, from: '2026-01-01', until: '2027-01-01' }] });
  }],
  ['RP1-D-007b proposed taxonomy', () => {
    expect(proposedTaxonomy).toEqual({
      categories: [{ key: 'supplements', parent: null }, { key: 'capsules', parent: 'supplements' }, { key: 'powders', parent: 'supplements' }],
      collections: [{ key: 'daily', categories: ['capsules', 'powders'] }],
    });
    expect(fixtures.drafts.flatMap(draft => draft.publication.operations.map(operation => operation.op)))
      .not.toContain('set_category_membership');
  }],
  ['RP1-D-010a exact source and extraction bytes', () => {
    const target = mkdtempSync(join(tmpdir(), 'supplements-extract-'));
    try {
      execFileSync(process.execPath, [join(root, 'neutral-store/extract.mjs'), target]);
      for (const path of ownedPaths) {
        const reference = path.replace('market-packs/', 'catalog-packs/');
        const bytes = readFileSync(join(root, reference));
        expect(readFileSync(join(target, 'owned', path))).toEqual(bytes);
        for (const match of bytes.toString('utf8').matchAll(/from '([^']+)'/gu)) {
          expect(match[1]).toMatch(/^(?:\.[/]\w+\.ts|@openlup[/]|node:)/u);
        }
      }
    } finally { rmSync(target, { recursive: true, force: true }); }
  }],
  ['RP1-D-010b starter_upgrade_preserves_owned_pack', async () => {
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'supplements-upgrade-')));
    try {
      execFileSync(process.execPath, [join(root, 'neutral-store/extract.mjs'), target]);
      const path = join(target, 'owned', packPaths[0]!);
      const edited = Buffer.concat([readFileSync(path), Buffer.from('\n// Local fixture change.\n')]);
      writeFileSync(path, edited);
      const schema = { min: 0, max: 0 };
      const oldBytes = readFileSync(join(target, 'README.md'), 'utf8');
      await applyAppUpgrade({ root: target, schemaVersion: 0, from: { version: '1.2.0', schema, files: { 'README.md': oldBytes } },
        to: { version: '1.2.1', schema, files: { 'README.md': 'Updated managed readme\n' } } });
      expect(readFileSync(path)).toEqual(edited);
    } finally { rmSync(target, { recursive: true, force: true }); }
  }],
])('supplements_pack_artifact_matrix %s', async (_rule, verify) => { await verify(); });

it.each([
  ['RP1-D-005a', () => {
    expect(initialDrafts.map(entry => catalogDraftPayloadV3Schema.parse(entry.payload).skus[0]?.code))
      .toEqual(['G1-CAPS-56', 'G1-POWDER-140']);
    expect(initialPublications.map(draft => catalogDraftPayloadV4Schema.parse(draft).schemaVersion)).toEqual([4, 4]);
  }],
  ['RP1-D-005b', () => {
    expect(catalogDraftPayloadV4Schema.parse(withdrawal).publication.operations).toEqual([
      { op: 'set_product_lifecycle', productSlug: 'capsule', expectedState: 'active', state: 'withdrawn',
        children: [{ skuCode: 'G1-CAPS-56', expectedState: 'active' }] },
    ]);
    expect(withdrawal.skus.flatMap(item => item.priceOperations ?? [])).toEqual([]);
  }],
  ['RP1-D-005c', () => {
    const payload = catalogDraftPayloadV5Schema.parse(successor.payload);
    expect(payload.publication.operations.find(operation => operation.op === 'create_sku')).toMatchObject({
      successorOf: capsule.skuId, skuId: '00000000-0000-4000-8000-000000000131', skuCode: 'G1-CAPS-NEXT-56',
    });
    expect(payload.skus[0]?.identifiers?.[0]?.value).toBe('0000000010306');
    expect(payload.skus[0]?.priceOperations?.[0]?.unitPriceMinor).toBe(3080);
    expect(agreedTerms.successor.requiresExplicitConsent).toBe(true);
  }],
] as const)('supplements_draft_transition_matrix %s', (_rule, verify) => { verify(); });

const binding = createCatalogSubscriptionProfileBinding({ profiles: pack.subscriptionProfileDefinitions, policies: [policy] });
const resolved = binding.resolve(profileRef)!;
const selection = {
  cadenceDays: purchase.cadenceDays,
  lineItems: purchase.lines.map(line => ({ ...line, typeRef: line.type, addon: false, sellable: true,
    profileRef, profileDigest: resolved.digest })),
};

it.each<[string, () => unknown]>([
  ['RP1-D-006a independent exact days', () => {
    expect(checkAge(true, purchase.adultAttestation)).toBeUndefined();
    expect(binding.check(selection)).toMatchObject({ kind: 'profiled', allowedDays: [28], coverage: [
      { lineIds: [capsule.skuId], wholeDays: 28, exact: true },
      { lineIds: [powder.skuId], wholeDays: 28, exact: true },
    ] });
  }],
  ...([['RP1-D-006b', undefined], ['RP1-D-006c', false]] as const).map(([rule, attestation]): [string, () => void] => [
    rule, () => { expect(checkAge(true, attestation)).toEqual({ code: 'age_attestation_required', path: '/adultAttestation' }); },
  ]),
  ['RP1-D-006d owner-backed prepaid refusal', () => {
    expect(Object.entries(pack.capabilities).filter(([, supported]) => !supported).map(([capability]) => capability)).toEqual(['prepaid']);
    expect(fixtures.refusals.map(fixture => fixture.capability)).toEqual(['prepaid']);
    expect(binding.bindAcceptance({ ...selection, prepaid: true })).toEqual({
      kind: 'refused', issue: { code: 'prepaid_unsupported', path: '/prepaid' },
    });
  }],
  ['RP1-D-006e off cadence', () => {
    expect(binding.check({ ...selection, cadenceDays: 27 })).toEqual({
      kind: 'refused', issue: { code: 'cadence_not_allowed', path: '/cadenceDays' },
    });
  }],
  ['RP1-D-006f undersupplied count beside full mass', () => {
    const input = { ...selection, lineItems: selection.lineItems.map((line, index) =>
      index === 0 ? { ...line, demand: { ...line.demand, contentPerUnit: { ...line.demand.contentPerUnit, unscaled: '55' } } } : line) };
    expect(binding.check(input)).toMatchObject({ kind: 'refused', issue: { code: 'line_coverage_mismatch' } });
  }],
  ['RP1-D-008a retained definition and explicit label mapping', async () => {
    const registry = createCatalogProductTypeRegistry(upgrade.pack.types);
    const prior = registry.resolve(upgrade.retainedType)!;
    const updated = registry.resolve(upgrade.updatedType)!;
    expect(catalogDefinitionDigest(prior)).toBe(catalogDefinitionDigest(definition));
    expect(catalogDefinitionDigest(updated)).not.toBe(catalogDefinitionDigest(prior));
    const mapped = await validateCatalogAttributes(updated, { ...fixtures.attributes[0]!.input, productAttributes: upgrade.productAttributes });
    expect(mapped).toMatchObject({ valid: true, readinessIssues: [] });
  }],
  ['RP1-D-008b required language cannot be inferred', async () => {
    const updated = createCatalogProductTypeRegistry(upgrade.pack.types).resolve(upgrade.updatedType)!;
    const result = await validateCatalogAttributes(updated, fixtures.attributes[0]!.input);
    expect(result).toMatchObject({ valid: true, readinessIssues: [{ code: 'attribute_required_missing', path: '/productAttributes/label_language' }] });
  }],
  ['RP1-D-007c authored prices through existing sandbox price owner', () => {
    const amounts = [capsule, powder, successor].map(({ payload }) => deriveSubscriptionUnitPrice(
      payload.skus[0]!.priceOperations![0]!.unitPriceMinor, {
        discountBps: agreedTerms.discountBps, roundingQuantumMinor: agreedTerms.roundingQuantumMinor, roundingRule: 'FLOOR_TO_QUANTUM',
      }));
    expect(amounts).toEqual([2800, 4200, 3080]);
    expect(agreedTerms.purchase).toEqual(agreedTerms.renewal);
    expect(agreedTerms.purchase.totalMinor).toBe(7000);
    expect(agreedTerms.successor).toMatchObject({ oldTotalMinor: 7000, newTotalMinor: 7280 });
    expect(agreedTerms).toMatchObject({ currency: 'XTS', currencyExponent: 2, cadenceDays: 28, shippingMinor: 0, taxMinor: 0 });
    expect(Date.parse(agreedTerms.renewalCycleAnchor) - Date.parse(agreedTerms.firstCycleAnchor)).toBe(28 * 86_400_000);
    expect(Date.parse(agreedTerms.followingCycleAnchor) - Date.parse(agreedTerms.renewalCycleAnchor)).toBe(28 * 86_400_000);
  }],
])('supplements_policy_and_upgrade_matrix %s', async (_rule, verify) => { await verify(); });
