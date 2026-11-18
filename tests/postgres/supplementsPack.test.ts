import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalCatalogDraftJson, catalogDefinitionDigest, catalogPackManifest, createPostgresCatalogPublication, createCatalogDraftHandlerV5, createCatalogProductTypeRegistry, createPostgresCatalogDraftStoreV5, installCatalogDefinitions,
} from '@openlup/platform/catalog';
import { upgrade as extractedUpgrade } from '../../examples/neutral-store/owned/catalog-packs/supplements/fixtures.ts';
import type { CatalogDecisionCommandV2, CatalogDraftPayloadV3, CatalogPublishCommand } from '@openlup/platform/catalog/contracts';
import type { PgQueryExecutor } from '@openlup/platform/data';
import { supplementsCatalogueRegistration } from '../../examples/neutral-store/owned/catalogue.ts';
import { initialDrafts } from '../../examples/catalog-packs/supplements/catalogue.ts';
import { upgrade } from '../../examples/catalog-packs/supplements/fixtures.ts';
import { pack } from '../../examples/catalog-packs/supplements/pack.ts';
import {
  closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer,
} from '../helpers/postgresContainer.js';

let container: PostgresContainer | undefined;
let owner: Pool;
const actorId = randomUUID();
const registry = createCatalogProductTypeRegistry(supplementsCatalogueRegistration.pack.types);
const draftHandler = () => createCatalogDraftHandlerV5({
  store: createPostgresCatalogDraftStoreV5(owner), registry,
  authorizeOperator: async (verified: boolean) => verified ? { actorId } : null,
});

beforeAll(async () => {
  container = await runPostgresContainer({ name: `supplements-pack-${process.pid}`, password: 'synthetic-supplements' });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('Supplements witnesses require PostgreSQL');
  owner = new Pool({ connectionString: container.connectionString });
  await owner.query('CREATE ROLE service_role NOLOGIN NOINHERIT NOBYPASSRLS');
  const manifest = JSON.parse(readFileSync('config/platform-migration-manifest.json', 'utf8'));
  for (const unit of [manifest.baseline, ...manifest.forward]) await owner.query(readFileSync(unit.file, 'utf8'));
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, [owner]), postgresTeardownTimeoutMs);

async function commerceCounts() {
  return (await owner.query(`SELECT
    (SELECT count(*)::int FROM public.catalog_products) AS products,
    (SELECT count(*)::int FROM public.catalog_skus) AS skus,
    (SELECT count(*)::int FROM public.price_entries) AS prices,
    (SELECT count(*)::int FROM public.catalog_publications) AS publications`)).rows[0];
}

it.each([
  ['RP1-D-003b replay leaves catalogue dark', async () => {
    const expected = catalogPackManifest(pack).digest;
    const first = await installCatalogDefinitions(owner, pack);
    expect(first.manifestDigest).toBe(expected);
    expect(await installCatalogDefinitions(owner, pack)).toEqual(first);
    expect(await commerceCounts()).toEqual({ products: 0, skus: 0, prices: 0, publications: 0 });
  }],
  ['RP1-D-003c same pack version changed manifest', async () => {
    await installCatalogDefinitions(owner, pack);
    await expect(installCatalogDefinitions(owner, { ...pack, capabilities: { ...pack.capabilities, quantities: false } }))
      .rejects.toMatchObject({ code: '23505', message: 'catalog_definition_install_conflict' });
  }],
  ['RP1-D-003d same type version changed bytes', async () => {
    await installCatalogDefinitions(owner, pack);
    await expect(installCatalogDefinitions(owner, { ...pack, version: 3,
      types: [{ ...pack.types[0], validatorRef: 'sha256:' + 'f'.repeat(64) }] }))
      .rejects.toMatchObject({ code: '23505', message: 'catalog_type_install_refuses_redefinition' });
  }],
  ['RP1-D-003e runtime installation refused', async () => {
    const before = (await owner.query('SELECT count(*) FROM public.catalog_definition_installs')).rows;
    const connection = await owner.connect();
    try {
      await connection.query('SET ROLE service_role');
      await expect(installCatalogDefinitions(connection, pack)).rejects.toMatchObject({ code: '42501' });
    } finally { await connection.query('RESET ROLE'); connection.release(); }
    expect((await owner.query('SELECT count(*) FROM public.catalog_definition_installs')).rows).toEqual(before);
  }],
] as const)('supplements_pack_artifact_matrix %s', async (_rule, verify) => { await verify(); });

it.each(initialDrafts)('supplements_draft_transition_matrix RP1-D-005a $skuCode creates and replays one dark draft', async fixture => {
  const handler = draftHandler();
  const command = { schemaVersion: 3, action: 'create', draftId: fixture.draftId,
    commandKey: `supplements:draft:${fixture.skuCode}`, expectedRevision: 0, payload: fixture.payload };
  const before = await commerceCounts();
  expect(await handler.execute(command, false)).toEqual({ outcome: 'unauthorized', reason: 'draft_operator_required' });
  expect((await owner.query('SELECT revision FROM public.catalog_draft_revisions WHERE draft_id=$1', [fixture.draftId])).rows).toEqual([]);
  const first = await handler.execute(command, true);
  expect(first).toMatchObject({ outcome: 'committed', record: { revision: 1, payload: fixture.payload } });
  if (!('record' in first)) throw new Error(JSON.stringify(first));
  expect(await handler.execute(command, true)).toEqual({ outcome: 'replayed', record: first.record });
  expect(await commerceCounts()).toEqual(before);
});

it.each([
  ['RP1-D-008a', upgrade.pack],
  ['RP1-D-008c', extractedUpgrade.pack],
] as const)('supplements_policy_and_upgrade_matrix %s installs both type versions without altering v1', async (_rule, next) => {
  await installCatalogDefinitions(owner, pack);
  const first = await installCatalogDefinitions(owner, next);
  expect(await installCatalogDefinitions(owner, next)).toEqual(first);
  expect((await owner.query(`SELECT version, definition_digest AS digest
    FROM public.catalog_type_versions WHERE type_key='supplements:item' ORDER BY version`)).rows).toEqual([
    { version: 1, digest: catalogDefinitionDigest(pack.types[0]) },
    { version: 2, digest: catalogDefinitionDigest(upgrade.pack.types[1]!) },
  ]);
  expect(await commerceCounts()).toEqual({ products: 0, skus: 0, prices: 0, publications: 0 });
});

describe('human publication boundary on the powder fixture', () => {
  const otherActor = randomUUID();
  const powder = initialDrafts[1];
  const publisher = (mutate?: (sql: string, rows: Record<string, unknown>[]) => void) => createPostgresCatalogPublication({
    registry,
    rules: {
      canonicalizeDocument: canonicalCatalogDraftJson,
      deriveSkuFacts: () => ({}),
      validateProduct: product => pack.types[0].validateContent(product.content).map(issue => issue.code),
      classifySkuChange: () => 'inconclusive',
    },
    authorizeHuman: async (userId: string | null) => userId === null ? { ok: false }
      : { ok: true, userId, role: 'admin', isMachineActor: false },
    async readiness() { return { ready: true, reasons: [] }; },
    async verifyMedia() { return false; },
    transactions: { async run(work) {
      const connection = await owner.connect();
      try {
        await connection.query('BEGIN');
        const executor: PgQueryExecutor = { async query(sql, values) {
          const result = await connection.query(sql, values);
          mutate?.(sql, result.rows);
          return result;
        } };
        const result = await work(executor);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally { connection.release(); }
    } },
  });
  const target = publisher();
  let approval: CatalogDecisionCommandV2, publication: CatalogPublishCommand;
  beforeAll(async () => {
    await installCatalogDefinitions(owner, pack);
    for (const [principal, name] of [[actorId, 'publisher'], [otherActor, 'other-publisher']] as const) {
      await owner.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,$2)',
        [principal, `${name}@example.invalid`]);
      await owner.query(`INSERT INTO public.platform_human_memberships
        (principal_id,role,membership_state,membership_provenance,membership_accepted_at)
        VALUES($1,'admin','active','legacy',clock_timestamp())`, [principal]);
    }

    const payload: CatalogDraftPayloadV3 = structuredClone(powder.payload);
    payload.product.sharedContent.requestedModes = [];
    payload.skus[0]!.priceOperations = [];
    payload.publication.operations = payload.publication.operations.filter(operation =>
      operation.op !== 'set_eligibility' && operation.op !== 'set_sku_status' && operation.op !== 'set_product_status');
    const prior = await owner.query('SELECT revision FROM public.catalog_draft_heads WHERE draft_id=$1', [powder.draftId]);
    const expectedRevision = Number(prior.rows[0]?.revision ?? 0);
    const stored = await draftHandler().execute({ schemaVersion: 3, action: expectedRevision ? 'revise' : 'create',
      draftId: powder.draftId, commandKey: 'supplements:operator:dark-draft', expectedRevision, payload }, true);
    if (!('record' in stored)) throw new Error(JSON.stringify(stored));
    const candidateRef = `v1:${powder.draftId}@${stored.record.revision}/unpublished`;
    const definitions = [{ ...payload.product.type, definitionDigest: catalogDefinitionDigest(pack.types[0]) }];
    const candidateDigest = createHash('sha256').update(canonicalCatalogDraftJson(['catalog-candidate', 1, payload, definitions, null])).digest('hex');
    publication = { productId: payload.product.id, commandKey: 'supplements:publish:powder',
      candidateRef, candidateDigest, expectedHead: null, changes: [] };
    approval = { schemaVersion: 2, action: 'approve', productId: payload.product.id,
      candidateRef, candidateDigest, commandKey: 'supplements:approve:powder', reason: 'Synthetic approval for the exact dark fixture' };
    expect(await target.decision(approval, (await target.authorize(actorId))!)).toMatchObject({ outcome: 'committed' });
  });

  async function publishDark() {
    const capability = (await target.authorize(actorId))!;
    const result = await target.publish(publication, capability);
    if (!('receipt' in result)) throw new Error(JSON.stringify(result));
    return result;
  }

  it.each([
    ['RP1-D-011a', async () => {
      const before = await commerceCounts();
      expect(await target.decision(approval, (await target.authorize(otherActor))!))
        .toEqual({ outcome: 'unauthorized', reason: 'catalog_publication_operator_mismatch' });
      expect(await commerceCounts()).toEqual(before);
    }],
    ['RP1-D-011b', async () => {
      const before = await commerceCounts();
      // Null is the host's expired-session result. The native owner requires a
      // capability issued by its own authorizer even for an approved candidate.
      const capability = await target.authorize(null);
      expect(capability).toBeNull();
      expect(await target.publish(publication, capability!))
        .toEqual({ outcome: 'unauthorized', reason: 'publisher_not_authorized' });
      expect(await commerceCounts()).toEqual(before);
    }],
    ['RP1-D-011c', async () => {
      const capability = (await target.authorize(actorId))!;
      const first = await target.publish(publication, capability);
      expect(first).toMatchObject({ outcome: 'committed' });
      if (!('receipt' in first)) throw new Error(JSON.stringify(first));
      const before = await commerceCounts();
      expect(await target.publish(publication, capability)).toEqual({ outcome: 'replayed', receipt: first.receipt });
      expect(await commerceCounts()).toEqual(before);
      expect(before).toMatchObject({ publications: 1, products: 1, skus: 1, prices: 0 });
      expect(await target.readbackV2(first.receipt.head)).toMatchObject({ outcome: 'page',
        product: { document: powder.payload.product.documentRevision }, items: [{ facts: { code: 'G1-POWDER-140' } }] });
    }],
    ['RP1-D-001a', async () => {
      const { receipt } = await publishDark();
      const failing = publisher((sql, rows) => {
        if (sql.includes('d.id AS document_id')) rows[0]!.document_id = randomUUID();
      });
      expect(await failing.readbackV2(receipt.head)).toEqual({
        outcome: 'dependency_unavailable', reason: 'catalog_publication_manifest_invalid',
      });
    }],
    ['RP1-D-001b', async () => {
      const { receipt } = await publishDark();
      const failing = publisher((sql, rows) => {
        if (sql.includes('octet_length(full_facts)')) rows[0]!.sku_id = randomUUID();
      });
      expect(await failing.readbackV2(receipt.head)).toEqual({
        outcome: 'dependency_unavailable', reason: 'catalog_publication_sku_revision_invalid',
      });
    }],
  ] as const)('supplements_draft_transition_matrix %s', async (_rule, verify) => { await verify(); });
});
