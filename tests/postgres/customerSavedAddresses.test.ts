import { randomUUID } from 'node:crypto';
import type { PgQueryExecutor } from '@openlup/platform/data';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createCustomerSavedAddressPrivacyContributor, createPostgresPrivacyStore, createIdentityPersonalDataContributor, createPersonalDataContributorRegistry, createPrivacyOperations } from '@openlup/platform/identity';
import { createAccountEventPrivacyContributor } from '@openlup/platform/account-support';
import type { PrivacyJson } from '@openlup/platform/identity/contracts';
import { captureConnectedNativeStore } from '../../server/adapters/postgres/connectedStoreCapture.js';
import { restoreConnectedNativeStore } from '../../server/adapters/postgres/connectedStoreRestore.js';
import { installAccountMutations, type AccountProfile } from './customerAccountMutations.fixture.js';
import { ADDRESS_AT as at, savedAddressPort, addressId } from './customerSavedAddresses.fixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
const input = () => ({ idempotencyKey: randomUUID(), kind: 'shipping' as const, line1: 'Example Street 1', city: 'Example City', postalCode: '12345', recipientName: 'Example Recipient' });
for (const profile of ['legacy','bootstrap','separate','admin-managed','admin-operator'] as AccountProfile[]) describe(`saved address ownership on ${profile}`, () => {
  let db: Awaited<ReturnType<typeof installAccountMutations>>, transferTarget: typeof db;
  // Provision the isolated restore target under the existing database setup deadline.
  beforeAll(async () => {
    db = await installAccountMutations(profile);
    transferTarget = await installAccountMutations(profile === 'legacy' ? 'bootstrap' : profile, false, 'address-target');
  }, postgresSetupTimeoutMs);
  afterAll(async () => { try { if (transferTarget) await transferTarget.close(); } finally { if (db) await db.close(); } }, postgresTeardownTimeoutMs);
  async function customer() {
    const client = randomUUID(), principal = randomUUID();
    await db.owner.query('INSERT INTO public.platform_human_principals(principal_id,email,created_at) VALUES($1,$2,$3)', [principal,`${principal}@example.invalid`,at]);
    await db.owner.query('INSERT INTO public.clients(id,principal_id,email,created_at,updated_at) VALUES($1,$2,$3,$4,$4)', [client,principal,`${client}@example.invalid`,at]);
    return { client, principal, port: savedAddressPort(db.runtime, principal, client) };
  }
  async function admin() {
    const id = randomUUID(); await db.owner.query('INSERT INTO public.platform_human_principals(principal_id,email,created_at) VALUES($1,$2,$3)', [id,`${id}@example.invalid`,at]);
    await db.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)", [id,at]); await db.owner.query('INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)', [id]); return id;
  }
  const rows = (client: string) => db.owner.query('SELECT to_jsonb(a) AS row,xmin::text FROM public.customer_saved_addresses a WHERE client_id=$1 ORDER BY id', [client]).then(r => r.rows);
  const events = (client: string) => db.owner.query('SELECT to_jsonb(e) AS row,xmin::text FROM public.customer_account_events e WHERE client_id=$1 ORDER BY id', [client]).then(r => r.rows);
  async function capture(store: typeof db) {
    return captureConnectedNativeStore({ sourceId: 'saved-address-source', catalogueId: store.inventory, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
      source: { async withSnapshot(work) { const client = await store.migrator.connect(), restricted = store.installation.generation === 'qualified-admin';
        try { if (restricted) await client.query('GRANT platform_acquisition_owner TO account_m WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY account_m');
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) }); await client.query('COMMIT'); return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { try { if (restricted) await client.query('REVOKE platform_acquisition_owner FROM account_m GRANTED BY account_m'); } finally { client.release(); } }
      } } });
  }
  it(profile === 'legacy' ? 'captures exact address rows, pointers and event payloads and refuses legacy restores without target writes' : 'transfers exact classified rows, pointers and event payloads and replays without rewriting them', async () => {
    const f = await customer(), id = addressId(await f.port.upsertAddress(f.principal, { ...input(), kind: 'both', companyName: 'Private Company', taxId: '1234563218', deliveryNotes: 'Private instructions' }));
    const subscription = randomUUID(); await db.owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,status,shipping_saved_address_id,billing_saved_address_id) VALUES($1,$2,28,$3,'cancelled',$4,$4)", [subscription,f.client,at,id]);
    await db.owner.query("UPDATE public.customer_saved_addresses SET metadata=$2::jsonb,last_used_at=$3 WHERE id=$1", [id,JSON.stringify({ pickupHistory: ['retained private location'] }),at]);
    const packet = await capture(db), expected = await rows(f.client), history = await events(f.client);
    expect(packet.owned.find(table => table.table === 'customer_saved_addresses')?.rows).toHaveLength(1);
    if (profile === 'legacy') {
      expect(packet.owned.find(table => table.table === 'customer_saved_addresses')?.rows.map(row => JSON.parse(row))).toEqual(expected.map(row => row.row));
      const pointers = (await db.owner.query('SELECT to_jsonb(s) AS row FROM public.subscriptions s WHERE id=$1', [subscription])).rows.map(row => row.row);
      expect(packet.compatible.tables.find(table => table.table === 'subscriptions')?.rows.map(row => JSON.parse(row))).toEqual(pointers);
      expect(pointers[0]).toMatchObject({ shipping_saved_address_id: id, billing_saved_address_id: id });
      expect(packet.owned.find(table => table.table === 'customer_account_events')?.rows.map(row => JSON.parse(row))).toEqual(history.map(row => row.row));
      const target = transferTarget;
      if (target.installation.generation === 'legacy') throw new Error('qualified_target_required');
      const freshTarget = await capture(target);
      const unchanged = async (store: typeof db, before: typeof packet) => {
        const after = await capture(store);
        expect(after.compatible).toEqual(before.compatible); expect(after.owned).toEqual(before.owned);
        expect(after.outsideProfileCensus).toEqual(before.outsideProfileCensus); expect(after.emptyOutsideProfile).toEqual(before.emptyOutsideProfile);
      };
      // Deliberately bypass the qualified-only input type to prove the runtime refusal.
      const legacyInstallation = db.installation as unknown as Parameters<typeof restoreConnectedNativeStore>[0]['installation'];
      await expect(restoreConnectedNativeStore({ owner: db.migrator, installation: legacyInstallation, packet: freshTarget, freshTarget: packet }))
        .rejects.toMatchObject({ name: 'PostgresTransferError', code: 'invalid_input' });
      await unchanged(db, packet);
      await expect(restoreConnectedNativeStore({ owner: target.migrator, installation: target.installation, packet, freshTarget }))
        .rejects.toMatchObject({ name: 'PostgresTransferError', code: 'schema_conflict' });
      await unchanged(target, freshTarget);
      return;
    }
    const target = transferTarget;
    if (target.installation.generation === 'legacy') throw new Error('qualified_target_required');
    const request = { owner: target.migrator, installation: target.installation, packet, freshTarget: await capture(target) };
    expect(await restoreConnectedNativeStore(request)).toMatchObject({ replayed: false });
    const actual = async () => (await target.owner.query('SELECT to_jsonb(a) AS row,xmin::text FROM public.customer_saved_addresses a WHERE client_id=$1 ORDER BY id', [f.client])).rows;
    const first = await actual(); expect(first.map(row => row.row)).toEqual(expected.map(row => row.row));
    expect((await target.owner.query('SELECT shipping_saved_address_id,billing_saved_address_id FROM public.subscriptions WHERE id=$1', [subscription])).rows).toEqual([{ shipping_saved_address_id: id, billing_saved_address_id: id }]);
    expect((await target.owner.query('SELECT to_jsonb(e) AS row FROM public.customer_account_events e WHERE client_id=$1 ORDER BY id', [f.client])).rows.map(row => row.row)).toEqual(history.map(row => row.row));
    expect(await restoreConnectedNativeStore(request)).toMatchObject({ replayed: true }); expect(await actual()).toEqual(first);
  });
  it('reads, saves, updates and canonically reuses only the owned address', async () => {
    const f = await customer(); expect(await f.port.getAddressBook(f.principal)).toMatchObject({ addresses: [], ordererProfiles: [] });
    const first = await f.port.upsertAddress(f.principal, { ...input(), line1: ' Example  Street 1 ', recipientName: null, isDefault: true }); const id = addressId(first);
    expect(first?.addresses[0]?.recipientName).toBeNull();
    const second = await f.port.upsertAddress(f.principal, { ...input(), line1: 'example street 1', label: 'Changed' });
    expect(second?.addresses).toHaveLength(1); expect(second?.addresses[0]).toMatchObject({ addressId: id, label: 'Changed', isDefault: false, country: 'ZZ', postalCode: '12-345' });
    const updated = await f.port.upsertAddress(f.principal, { ...input(), addressId: id, line1: 'Different Street', kind: 'billing' });
    expect(updated?.addresses[0]).toMatchObject({ addressId: id, kind: 'billing', line1: 'Different Street' }); expect(await events(f.client)).toHaveLength(3);
  });
  it('clears defaults by exact kind including both, and preserves the committed clear when a later write fails', async () => {
    const f = await customer();
    for (const kind of ['shipping','billing','both'] as const) {
      await f.port.upsertAddress(f.principal, { ...input(), kind, line1: `${kind} First`, isDefault: true });
      await f.port.upsertAddress(f.principal, { ...input(), kind, line1: `${kind} Second`, isDefault: true });
    }
    expect((await f.port.getAddressBook(f.principal))?.addresses.filter(row => row.isDefault).map(row => row.kind).sort()).toEqual(['billing','both','shipping']);
    const foreign = await customer(), other = addressId(await foreign.port.upsertAddress(foreign.principal, input()));
    await expect(f.port.upsertAddress(f.principal, { ...input(), addressId: other, isDefault: true })).rejects.toMatchObject({ code: 'address_not_found' });
    expect((await f.port.getAddressBook(f.principal))?.addresses.filter(row => row.isDefault).map(row => row.kind).sort()).toEqual(['billing','both']);
  });
  it('refuses active or paused shipping/billing use and clears dormant pointers on deletion', async () => {
    const f = await customer(), id = addressId(await f.port.upsertAddress(f.principal, input()));
    for (const field of ['shipping_saved_address_id','billing_saved_address_id']) {
      const subscription = randomUUID(); await db.owner.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,status,${field}) VALUES($1,$2,28,$3,'active',$4)`, [subscription,f.client,at,id]);
      await expect(f.port.deleteAddress(f.principal, { idempotencyKey: randomUUID(), addressId: id })).rejects.toMatchObject({ code: 'address_in_use' });
      await db.owner.query("UPDATE public.subscriptions SET status='paused' WHERE id=$1", [subscription]);
      await expect(f.port.deleteAddress(f.principal, { idempotencyKey: randomUUID(), addressId: id })).rejects.toMatchObject({ code: 'address_in_use' });
      await db.owner.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [subscription]);
    }
    const key = randomUUID(); expect((await f.port.deleteAddress(f.principal, { idempotencyKey: key, addressId: id }))?.addresses).toEqual([]);
    expect((await db.owner.query('SELECT shipping_saved_address_id,billing_saved_address_id FROM public.subscriptions WHERE client_id=$1', [f.client])).rows.every(row => !row.shipping_saved_address_id && !row.billing_saved_address_id)).toBe(true);
    const history = await events(f.client); expect((await f.port.deleteAddress(f.principal, { idempotencyKey: key, addressId: id }))?.addresses).toEqual([]); expect(await events(f.client)).toEqual(history);
  });
  it('isolates principals and clients while retaining zero-row delete acknowledgement for foreign or missing IDs', async () => {
    const f = await customer(), other = await customer(), id = addressId(await f.port.upsertAddress(f.principal, input())), before = await rows(f.client);
    expect(await savedAddressPort(db.runtime, other.principal, f.client).getAddressBook(other.principal)).toBeNull();
    const unlinked = randomUUID(); expect(await savedAddressPort(db.runtime, unlinked, f.client).getAddressBook(unlinked)).toBeNull();
    await expect(f.port.getAddressBook(other.principal)).rejects.toMatchObject({ code: 'address_scope_mismatch' });
    await expect(other.port.upsertAddress(other.principal, { ...input(), addressId: id })).rejects.toMatchObject({ code: 'address_not_found' });
    for (const target of [id, randomUUID()]) expect((await other.port.deleteAddress(other.principal, { idempotencyKey: randomUUID(), addressId: target }))?.addresses).toEqual([]);
    expect(await rows(f.client)).toEqual(before); expect(await events(other.client)).toHaveLength(2);
  });
  it('replays current state without a second write or event and does not roll back a write when append fails', async () => {
    const f = await customer(), request = input(), id = addressId(await f.port.upsertAddress(f.principal, request));
    await f.port.upsertAddress(f.principal, { ...input(), addressId: id, label: 'Later value' }); const before = await rows(f.client), history = await events(f.client);
    expect((await f.port.upsertAddress(f.principal, { ...request, line1: 'Ignored replay payload' }))?.addresses[0]?.label).toBe('Later value'); expect(await rows(f.client)).toEqual(before); expect(await events(f.client)).toEqual(history);
    const broken = savedAddressPort({ query: async (sql, values) => { if (sql.includes('customer_account_event_append')) throw new Error('synthetic_append_failure'); return db.runtime.query(sql, values); } }, f.principal, f.client);
    await expect(broken.upsertAddress(f.principal, { ...input(), addressId: id, label: 'Write survived' })).rejects.toThrow('synthetic_append_failure');
    expect((await f.port.getAddressBook(f.principal))?.addresses[0]?.label).toBe('Write survived'); expect(await events(f.client)).toEqual(history);
  });
  it('refuses malformed requests and denies raw tables and routines to browser roles', async () => {
    const f = await customer(); await expect(f.port.upsertAddress(f.principal, { ...input(), idempotencyKey: 'bad' })).rejects.toMatchObject({ code: 'address_invalid_input' });
    for (const role of ['anon','authenticated']) { const connection = await db.owner.connect(); try { await connection.query(`SET ROLE ${role}`);
      await expect(connection.query('SELECT * FROM public.customer_saved_addresses')).rejects.toMatchObject({ code: '42501' });
      await expect(connection.query('SELECT public.customer_saved_addresses_read($1,$2)', [f.principal,f.client])).rejects.toMatchObject({ code: '42501' });
    } finally { await connection.query('RESET ROLE'); connection.release(); } }
  });
  it('blocks absorption for address rows while an empty lead still absorbs and replays', async () => {
    const f = await customer(), operator = await admin(), blocked = randomUUID(), free = randomUUID();
    for (const id of [blocked, free]) await db.owner.query("INSERT INTO public.clients(id,email,lifecycle_stage,created_at,updated_at) VALUES($1,$2,'lead',$3,$3)", [id,`${id}@example.invalid`,at]);
    await db.owner.query("INSERT INTO public.customer_saved_addresses(client_id,kind,line1,city,postal_code,country) VALUES($1,'shipping','Private Street','Example','12-345','ZZ')", [blocked]);
    const absorb = async (lead: string, key: string) => (await db.runtime.query('SELECT public.customer_support_absorb_lead_v1($1,$2,$3,$4,$5,$6) AS result', [operator,f.client,lead,`${lead}@example.invalid`,key,at])).rows[0].result;
    expect(await absorb(blocked,randomUUID())).toMatchObject({ outcome: 'refused', refusalCode: 'lead_has_commercial_footprint', blockingTables: ['customer_saved_addresses'] });
    expect((await db.owner.query('SELECT count(*)::int n FROM public.customer_saved_addresses WHERE client_id=$1',[blocked])).rows[0].n).toBe(1);
    const key = randomUUID(), first = await absorb(free,key); expect(first).toMatchObject({ outcome: 'applied' }); expect(await absorb(free,key)).toEqual({ ...first, outcome: 'replayed' });
  });
  it('classifies export and erases saved rows without relying on client clearing or event erasure', async () => {
    const f = await customer(), operator = await admin(); await f.port.upsertAddress(f.principal, { ...input(), kind: 'both', companyName: 'Private Company', taxId: '1234563218', deliveryNotes: 'Private text' });
    const store = createPostgresPrivacyStore(), identity = createIdentityPersonalDataContributor(store, { retainedContactFields: Object.fromEntries(['lifecycle_stage','acquisition_source'].map(field => [field,{ owner: 'clients', resource: `clients.${field}`, disposition: 'retain' as const, reasonCode: 'CONTACT_LIFECYCLE_RETENTION', remote: false }])) }, randomUUID);
    const read = async (context: PgQueryExecutor, subject: { contactId: string | null }) => ({ available: true, data: (await context.query('SELECT to_jsonb(e) AS value FROM public.customer_account_events e WHERE client_id=$1 ORDER BY id', [subject.contactId])).rows.map(row => row.value) as PrivacyJson });
    let paused = false, erasurePid = 0;
    let signalPrepared: () => void = () => {}, releasePreparation: () => void = () => {};
    let preparationGate: Promise<void> = Promise.resolve();
    const unitOfWork = { run: async <T>(work: (context: PgQueryExecutor) => Promise<T>) => {
      const connection = await db.owner.connect();
      try { await connection.query('BEGIN'); erasurePid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const context: PgQueryExecutor = { query: async (sql, values) => { const result = await connection.query(sql, values ? [...values] : undefined);
          if (paused && sql.includes('customer_saved_addresses_prepare_erasure')) { signalPrepared(); await preparationGate; } return result; } };
        const value = await work(context); await connection.query('COMMIT'); return value;
      } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    } };
    const registry = createPersonalDataContributorRegistry([identity, createCustomerSavedAddressPrivacyContributor(), createAccountEventPrivacyContributor({ read, assess: async () => 'retain' })], { requiredContributorIds: ['identity','customer-saved-addresses','account-support'] });
    const privacy = createPrivacyOperations({ store, registry, unitOfWork, now: () => new Date(at), randomId: randomUUID });
    const exported = await privacy.export({ principalId: operator }, { kind: 'contact', contactId: f.client });
    expect(exported.documents.find(document => document.contributorId === 'customer-saved-addresses')).toMatchObject({ coverage: { complete: true }, data: [{ tax_id: '1234563218', delivery_notes: 'Private text', canonical_key: expect.stringContaining('example street 1') }] });
    const missing = createPrivacyOperations({ store, registry: createPersonalDataContributorRegistry([identity], { requiredContributorIds: ['identity','customer-saved-addresses','account-support'] }), unitOfWork, now: () => new Date(at), randomId: randomUUID });
    await expect(missing.erase({ principalId: operator }, { subject: { kind: 'contact', contactId: f.client }, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'PRIVACY_CONTRIBUTOR_MISSING' });
    const prepared = new Promise<void>(resolve => { signalPrepared = resolve; });
    preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; }); paused = true;
    const erasing = privacy.erase({ principalId: operator }, { subject: { kind: 'contact', contactId: f.client }, idempotencyKey: randomUUID() });
    await prepared;
    const writer = await db.runtime.connect();
    let receipt: Awaited<typeof erasing>;
    try {
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiting = savedAddressPort(writer, f.principal, f.client).upsertAddress(f.principal, { ...input(), line1: 'Must not survive erasure' }).then(() => null, error => error);
      const deadline = Date.now() + 5000;
      while (!(await db.owner.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked', [erasurePid,writerPid])).rows[0].blocked) {
        if (Date.now() > deadline) throw new Error('Expected saved-address writer to wait on privacy preparation');
        await new Promise(resolve => setTimeout(resolve,10));
      }
      releasePreparation(); receipt = await erasing;
      expect(await waiting).toMatchObject({ code: 'address_scope_mismatch' });
    } finally { releasePreparation(); writer.release(); }
    expect(receipt.obligations).toContainEqual(expect.objectContaining({ resource: 'account-support.account-events', disposition: 'retain' }));
    expect(receipt.obligations).toContainEqual({ owner: 'customer-saved-addresses', resource: 'customer.saved-addresses', disposition: 'erase', reasonCode: 'PRIVATE_SAVED_CONTACT', remote: false });
    expect(await rows(f.client)).toEqual([]); expect((await events(f.client))[0]?.row.payload.deliveryNotes).toBe('Private text');
    expect((await db.owner.query('SELECT principal_id FROM public.clients WHERE id=$1', [f.client])).rows[0].principal_id).toBeNull();
  });
});
