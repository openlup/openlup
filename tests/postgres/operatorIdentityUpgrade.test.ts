/** Real complete-catalogue proof. Missing database infrastructure is a failure. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { createPostgresOperatorIdentityStore } from '@openlup/platform/identity';
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';
const A = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const containers: PostgresContainer[] = []; const pools: Pool[] = []; const stores: ReturnType<typeof createPostgresOperatorIdentityStore>[] = [];
let fresh: Pool; let upgrade: Pool; let root: string;
let store: ReturnType<typeof createPostgresOperatorIdentityStore>;
let current: { baseline: { file: string; sha256: string }; forward: { file: string; sha256: string }[]; objectInventorySha256: string };
const runner = (index: number, selectedRoot = process.cwd()) => createPostgresMigrationRunner({ connectionString: containers[index].connectionString }, { root: selectedRoot, poolFactory: () => pools[index] });
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error('Operator identity conformance requires Docker PostgreSQL');
  current = JSON.parse(readFileSync('config/platform-migration-manifest.json', 'utf8'));
  expect(current.forward.at(-1)!.file).toBe('db/platform/migrations/20261018180000_identity_operator_challenges.sql');
  for (const name of ['fresh', 'upgrade']) {
    const container = await runPostgresContainer({ name: `operator-identity-${name}-${process.pid}`, password: 'synthetic-conformance' }); containers.push(container);
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('PostgreSQL unavailable');
    pools.push(new Pool({ connectionString: container.connectionString }));
  }
  [fresh, upgrade] = pools;
  // Exact complete predecessor catalogue, including its live object inventory.
  const before = { ...current, forward: current.forward.slice(0, -1), objectInventorySha256: '8946821ce78565f1eb3a6c344da1a7a7fbacb514235a78d37ac38633019a3ba8' };
  root = mkdtempSync(join(tmpdir(), 'operator-identity-upgrade-'));
  for (const entry of [before.baseline, ...before.forward]) { const file = join(root, entry.file); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, readFileSync(entry.file)); }
  mkdirSync(join(root, 'config')); writeFileSync(join(root, 'config/platform-migration-manifest.json'), JSON.stringify(before));
  await runner(1, root).apply();
  await upgrade.query(`INSERT INTO public.platform_human_principals (principal_id, email) VALUES ($1, 'admin@example.invalid'), ($2, 'machine@example.invalid')`, [A, M]);
  await upgrade.query(`INSERT INTO public.clients (id, email, principal_id) VALUES ($1, 'admin@example.invalid', $2)`, [C, A]);
  await upgrade.query('INSERT INTO public.platform_control_operators (principal_id, active) VALUES ($1, true)', [M]);
  await runner(0).apply();
  store = createPostgresOperatorIdentityStore({ connectionString: containers[0].connectionString }); stores.push(store);
}, 120000);
afterAll(async () => { await Promise.all(stores.map(s => s.close())); await Promise.all(pools.map(p => p.end())); await Promise.all(containers.map(c => c.remove())); if (root) rmSync(root, { recursive: true, force: true }); });
async function issue(value: string) { return store.issue({ email: 'admin@example.invalid', tokenHash: hash(value) }); }
async function resetChallenges() { await fresh.query('DELETE FROM public.operator_identity_challenges'); }
it('bootstrap failure retains a preexisting principal', async () => {
  await fresh.query("INSERT INTO public.platform_human_principals (principal_id, email) VALUES ('55555555-5555-4555-8555-555555555555', 'retained@example.invalid')");
  await fresh.query("ALTER TABLE public.identity_operator_invitations ADD CONSTRAINT synthetic_bootstrap_failure CHECK (NOT email_key = 'retained@example.invalid')");
  try { await expect(store.bootstrapFirstAdministrator({ email: 'retained@example.invalid' })).rejects.toThrow(); }
  finally { await fresh.query('ALTER TABLE public.identity_operator_invitations DROP CONSTRAINT synthetic_bootstrap_failure'); }
  expect((await fresh.query("SELECT principal_id FROM public.platform_human_principals WHERE email = 'retained@example.invalid'")).rows).toHaveLength(1);
});
it('bootstrap race creates one invitation; repeat cannot resurrect any prior authority', async () => {
  const second = createPostgresOperatorIdentityStore({ connectionString: containers[0].connectionString }); stores.push(second);
  const results = await Promise.allSettled([store.bootstrapFirstAdministrator({ email: 'admin@example.invalid' }), second.bootstrapFirstAdministrator({ email: 'admin@example.invalid' })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(String((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason)).toContain('OPERATOR_BOOTSTRAP_ALREADY_INITIALIZED');
  expect((await fresh.query('SELECT * FROM public.platform_human_memberships')).rows).toHaveLength(0);
  expect((await fresh.query('SELECT * FROM public.identity_operator_invitations')).rows).toHaveLength(1);
});
it('activation failure rolls back consumption and invitation acceptance in the same transaction', async () => {
  await issue('rollback');
  await fresh.query('ALTER TABLE public.operator_identity_challenges ADD CONSTRAINT synthetic_consumption_failure CHECK (used_at IS NULL)');
  try { await expect(store.redeem({ tokenHash: hash('rollback') })).rejects.toThrow(); }
  finally { await fresh.query('ALTER TABLE public.operator_identity_challenges DROP CONSTRAINT synthetic_consumption_failure'); }
  expect((await fresh.query('SELECT * FROM public.platform_human_memberships')).rows).toHaveLength(0);
  expect((await fresh.query("SELECT * FROM public.identity_operator_invitation_events WHERE action = 'accept'")).rows).toHaveLength(0);
  expect((await fresh.query('SELECT used_at FROM public.operator_identity_challenges WHERE token_hash = $1', [hash('rollback')])).rows[0].used_at).toBeNull();
});
it('concurrent issuance allows one per minute and first redemption activates exactly once', async () => {
  await resetChallenges();
  const issued = await Promise.all(['one', 'two', 'three'].map(issue)); expect(issued.filter(r => r.deliverable)).toHaveLength(1);
  const winner = ['one', 'two', 'three'][issued.findIndex(r => r.deliverable)];
  const results = await Promise.all([store.redeem({ tokenHash: hash(winner) }), store.redeem({ tokenHash: hash(winner) })]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await fresh.query("SELECT * FROM public.identity_operator_invitation_events WHERE action = 'accept'")).rows).toHaveLength(1);
  expect(await store.findMembership(results.find(Boolean)!.principalId)).toMatchObject({ membershipState: 'active', role: 'admin' });
});
it('already-active admin and distributor logins preserve membership and invitation history', async () => {
  await resetChallenges();
  const activated = (await fresh.query('SELECT principal_id FROM public.identity_operator_invitations')).rows[0].principal_id;
  const cases = [
    { id: activated, email: 'admin@example.invalid', role: 'admin' },
    { id: '66666666-6666-4666-8666-666666666666', email: 'active-admin@example.invalid', role: 'admin' },
    { id: '77777777-7777-4777-8777-777777777777', email: 'active-distributor@example.invalid', role: 'distributor' },
  ];
  for (const member of cases.slice(1)) {
    await fresh.query('INSERT INTO public.platform_human_principals (principal_id, email) VALUES ($1, $2)', [member.id, member.email]);
    await fresh.query("INSERT INTO public.platform_human_memberships (principal_id, role, membership_state, membership_provenance, membership_accepted_at) VALUES ($1, $2, 'active', 'legacy', now())", [member.id, member.role]);
    expect((await fresh.query('SELECT * FROM public.identity_operator_invitations WHERE principal_id = $1', [member.id])).rows).toEqual([]);
  }
  const memberships = (await fresh.query('SELECT * FROM public.platform_human_memberships ORDER BY principal_id')).rows;
  const invitations = (await fresh.query('SELECT * FROM public.identity_operator_invitations ORDER BY principal_id')).rows;
  const events = (await fresh.query('SELECT * FROM public.identity_operator_invitation_events ORDER BY event_id')).rows;
  expect(events.filter(event => event.action === 'accept')).toHaveLength(1);
  for (const member of cases) {
    const tokenHash = hash('repeat-' + member.email);
    expect(await store.issue({ email: member.email, tokenHash })).toMatchObject({ deliverable: true, email: member.email });
    expect(await store.redeem({ tokenHash })).toEqual({ principalId: member.id, email: member.email });
    expect(await store.findMembership(member.id)).toMatchObject({ membershipState: 'active', role: member.role });
    expect((await fresh.query('SELECT used_at FROM public.operator_identity_challenges WHERE token_hash = $1', [tokenHash])).rows[0].used_at).not.toBeNull();
    expect(await store.redeem({ tokenHash })).toBeNull();
  }
  expect((await fresh.query('SELECT * FROM public.platform_human_memberships ORDER BY principal_id')).rows).toEqual(memberships);
  expect((await fresh.query('SELECT * FROM public.identity_operator_invitations ORDER BY principal_id')).rows).toEqual(invitations);
  expect((await fresh.query('SELECT * FROM public.identity_operator_invitation_events ORDER BY event_id')).rows).toEqual(events);
});
it('rolling hour limits count consumed challenges and pruning preserves recent issuance history', async () => {
  await resetChallenges(); const id = (await fresh.query('SELECT principal_id FROM public.identity_operator_invitations')).rows[0].principal_id;
  for (let i = 0; i < 5; i++) await fresh.query(`INSERT INTO public.operator_identity_challenges
    (principal_id, email_fingerprint, token_hash, created_at, expires_at, used_at)
    VALUES ($1, $2, $3, statement_timestamp() - interval '5 minutes', statement_timestamp() + interval '5 minutes', statement_timestamp() - interval '1 minute')`, [id, hash('admin@example.invalid'), hash('used' + i)]);
  expect(await issue('limited')).toEqual({ deliverable: false });
  expect(await store.pruneChallenges({ limit: 500 })).toEqual({ deleted: 0 });
});
it('expired challenges and email changes refuse; revocation denies the next request and redemption', async () => {
  await resetChallenges(); await issue('stale');
  const id = (await fresh.query('SELECT principal_id FROM public.identity_operator_invitations')).rows[0].principal_id;
  await fresh.query("UPDATE public.platform_human_principals SET email = 'changed@example.invalid' WHERE principal_id = $1", [id]);
  expect(await store.redeem({ tokenHash: hash('stale') })).toBeNull();
  await fresh.query("UPDATE public.platform_human_principals SET email = 'admin@example.invalid' WHERE principal_id = $1", [id]);
  await fresh.query("UPDATE public.operator_identity_challenges SET created_at = statement_timestamp() - interval '10 minutes', expires_at = statement_timestamp() WHERE token_hash = $1", [hash('stale')]);
  expect(await store.redeem({ tokenHash: hash('stale') })).toBeNull();
  await resetChallenges(); await issue('revoked');
  await fresh.query("INSERT INTO public.platform_human_principals (principal_id, email) VALUES ($1, 'second-admin@example.invalid')", [A]);
  await fresh.query("INSERT INTO public.platform_human_memberships (principal_id, role, membership_state, membership_provenance, membership_accepted_at) VALUES ($1, 'admin', 'active', 'legacy', now())", [A]);
  await fresh.query('SELECT public.platform_revoke_human_membership($1, $2, $3)', [A, id, 'synthetic revocation']);
  expect(await store.redeem({ tokenHash: hash('revoked') })).toBeNull();
  expect(await store.findMembership(id)).toMatchObject({ membershipState: 'revoked' });
  await expect(store.bootstrapFirstAdministrator({ email: 'admin@example.invalid' })).rejects.toThrow('OPERATOR_BOOTSTRAP_ALREADY_INITIALIZED');
});
it('pruning is bounded, retaining live challenges; effective browser grants refuse login', async () => {
  await resetChallenges();
  const id = (await fresh.query('SELECT principal_id FROM public.identity_operator_invitations')).rows[0].principal_id;
  for (let i = 0; i < 3; i++) await fresh.query(`INSERT INTO public.operator_identity_challenges
    (principal_id, email_fingerprint, token_hash, created_at, expires_at) VALUES ($1, $2, $3, statement_timestamp() - interval '25 hours 10 minutes', statement_timestamp() - interval '25 hours')`, [id, hash('admin@example.invalid'), hash('old' + i)]);
  const retained = [hash('live'), hash('recently-expired')].sort();
  await fresh.query(`INSERT INTO public.operator_identity_challenges
    (principal_id, email_fingerprint, token_hash, created_at, expires_at) VALUES
    ($1, $2, $3, statement_timestamp() - interval '5 minutes', statement_timestamp() + interval '5 minutes'),
    ($1, $2, $4, statement_timestamp() - interval '20 minutes', statement_timestamp() - interval '10 minutes')`, [id, hash('admin@example.invalid'), hash('live'), hash('recently-expired')]);
  expect(await store.pruneChallenges({ limit: 2 })).toEqual({ deleted: 2 });
  expect((await fresh.query('SELECT token_hash FROM public.operator_identity_challenges WHERE token_hash = ANY($1::text[]) ORDER BY token_hash', [retained])).rows.map(row => row.token_hash)).toEqual(retained);
  expect(await store.pruneChallenges({ limit: 500 })).toEqual({ deleted: 1 });
  expect((await fresh.query('SELECT token_hash FROM public.operator_identity_challenges ORDER BY token_hash')).rows.map(row => row.token_hash)).toEqual(retained);
  for (const role of ['anon', 'authenticated']) {
    if (!(await fresh.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length) await fresh.query(`CREATE ROLE ${role} NOLOGIN`);
    expect((await fresh.query("SELECT has_table_privilege($1, 'public.operator_identity_challenges', 'SELECT,INSERT,UPDATE,DELETE') AS allowed", [role])).rows[0].allowed).toBe(false);
    const actor = await fresh.connect();
    try {
      for (const sql of ['SELECT * FROM public.operator_identity_challenges', 'DELETE FROM public.operator_identity_challenges']) {
        await actor.query('BEGIN'); await actor.query(`SET LOCAL ROLE ${role}`);
        await expect(actor.query(sql)).rejects.toMatchObject({ code: '42501' }); await actor.query('ROLLBACK');
      }
    } finally { actor.release(); }
  }
  await fresh.query('GRANT SELECT ON public.operator_identity_challenges TO PUBLIC');
  try { await expect(issue('unsafe')).rejects.toThrow('privileges_unsafe'); }
  finally { await fresh.query('REVOKE SELECT ON public.operator_identity_challenges FROM PUBLIC'); }
});
it('normalized duplicates refuse the forward atomically without changing customer or machine links', async () => {
  await upgrade.query("INSERT INTO public.platform_human_principals (principal_id, email) VALUES ('44444444-4444-4444-8444-444444444444', ' ADMIN@example.invalid ')");
  await expect(runner(1).apply()).rejects.toThrow();
  expect((await upgrade.query('SELECT principal_id FROM public.clients WHERE id = $1', [C])).rows[0].principal_id).toBe(A);
  expect((await upgrade.query('SELECT active FROM public.platform_control_operators WHERE principal_id = $1', [M])).rows[0].active).toBe(true);
  await upgrade.query("DELETE FROM public.platform_human_principals WHERE principal_id = '44444444-4444-4444-8444-444444444444'");
  const before = (await upgrade.query('SELECT * FROM public.clients ORDER BY id')).rows;
  await runner(1).apply(); await runner(1).apply();
  expect((await upgrade.query('SELECT * FROM public.clients ORDER BY id')).rows).toEqual(before);
  expect((await upgrade.query('SELECT catalog_path, sha256, position FROM public.platform_schema_migrations ORDER BY position')).rows)
    .toEqual([current.baseline, ...current.forward].map((row, position) => ({ catalog_path: row.file, sha256: row.sha256, position })));
});

it('installed ledger refuses changed hashes, paths, missing, extra and reordered identities', async () => {
  const rows = (await upgrade.query('SELECT catalog_path, sha256, position FROM public.platform_schema_migrations ORDER BY position')).rows;
  for (const mutate of [
    () => upgrade.query("UPDATE public.platform_schema_migrations SET sha256 = $1 WHERE position = 1", ['0'.repeat(64)]),
    () => upgrade.query("UPDATE public.platform_schema_migrations SET catalog_path = 'db/platform/migrations/unexpected.sql' WHERE position = 1"),
    () => upgrade.query('DELETE FROM public.platform_schema_migrations WHERE position = 1'),
    () => upgrade.query("INSERT INTO public.platform_schema_migrations (catalog_path, sha256, position) VALUES ('db/platform/migrations/extra.sql', $1, 999)", ['0'.repeat(64)]),
    () => upgrade.query('UPDATE public.platform_schema_migrations SET position = 1000 WHERE position = 1'),
  ]) {
    await mutate();
    try { await expect(runner(1).apply()).rejects.toThrow(); }
    finally {
      await upgrade.query('DELETE FROM public.platform_schema_migrations');
      for (const row of rows) await upgrade.query('INSERT INTO public.platform_schema_migrations (catalog_path, sha256, position) VALUES ($1, $2, $3)', [row.catalog_path, row.sha256, row.position]);
    }
  }
});
