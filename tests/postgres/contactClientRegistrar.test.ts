// Characterize the reference adopter's exact lowercase lookup without plus/dot
// folding: a canonical peer wins, otherwise a new canonical contact is created.
// Refresh unlinked defaults and journey facts; never UPDATE a linked row.
// Source citations and the reference revision are in the private task record.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresContactClientRegistrar, createPostgresCustomerChallengeStore, createPostgresAccountLinkStore,
  createPostgresPrivacyStore, createPostgresPrivacyUnitOfWork, createIdentityPersonalDataContributor,
  createPersonalDataContributorRegistry, createPrivacyOperations, type EnsureContactClientResult,
  type PrivacyStore } from "@openlup/platform/identity";
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions } from "@openlup/platform/migrations";
import { createPostgresCustomerOrderHistoryReadStore, readPostgresCustomerAccountClient } from "@openlup/platform/account-support";
import { createPostgresNativeCheckoutPersistence } from "@openlup/platform/commerce/server/native-checkout";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { closePostgres, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady,
  postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const name = `m19-st-reg-${process.pid}`, volume = `${name}-data`, admin = randomUUID();
const pools: Pool[] = [], ports: { close(): Promise<void> }[] = [];
let container: PostgresContainer | undefined, owner: Pool, runtime: Pool, runtimeUrl: string;
let registrar: ReturnType<typeof createPostgresContactClientRegistrar>;
let challenges: ReturnType<typeof createPostgresCustomerChallengeStore>;
const input = (email: string) => ({ email, acquisitionSource: "checkout", lifecycleStage: "lead" as const });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const success = (result: EnsureContactClientResult) => { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code); return result; };
const pool = (connectionString: string, options?: string) => { const value = new Pool({ connectionString, options }); pools.push(value); return value; };

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Contact registrar requires real PostgreSQL");
  execFileSync("docker", ["volume", "create", volume]);
  container = await runPostgresContainer({ name, password: "synthetic-conformance",
    runOptions: ["-e", "PGDATA=/var/lib/postgresql/data/contact-data", "-v", `${volume}:/var/lib/postgresql/data/contact-data`] });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Contact PostgreSQL unavailable");
  owner = pool(container.connectionString);
  await owner.query(`CREATE ROLE contact_runtime LOGIN PASSWORD 'synthetic-runtime' NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
    CREATE ROLE contact_restore LOGIN PASSWORD 'synthetic-restore' NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
  const installation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
    migrationLogin: "postgres", runtimeLogin: "contact_runtime", restoreLogin: "contact_restore" } as const;
  const migrator = pool(container.connectionString, qualifiedPostgresStartupOptions(installation));
  // The installed package's complete immutable SQL history, not a reduced fixture.
  const runner = createPlatformPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => migrator });
  await runner.apply(); expect((await runner.status()).pending).toEqual([]);
  const url = new URL(container.connectionString); url.username = "contact_runtime"; url.password = "synthetic-runtime";
  runtimeUrl = url.toString(); runtime = pool(runtimeUrl);
  registrar = createPostgresContactClientRegistrar({ connectionString: runtimeUrl }); ports.push(registrar);
  challenges = createPostgresCustomerChallengeStore({ connectionString: runtimeUrl }); ports.push(challenges);
  expect((await runtime.query(`SELECT current_user, r.rolsuper, r.rolbypassrls,
    pg_has_role(current_user,'service_role','USAGE') AS service FROM pg_roles r WHERE rolname=current_user`)).rows)
    .toEqual([{ current_user: "contact_runtime", rolsuper: false, rolbypassrls: false, service: true }]);
  // Human administrator and install-time fictional catalogue only. All journey
  // clients, orders and principals below are created through native writers.
  await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'contact-admin@example.test')", [admin]);
  await owner.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy',now())`, [admin]);
  const sku = randomUUID(), list = randomUUID();
  await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'contact-proof','Contact proof')", [sku]);
  await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,'CONTACT-PROOF','Contact proof',true)", [sku]);
  await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Contact proof','ZZ','XXX')", [list]);
  await owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,200)", [list, sku]);
}, postgresSetupTimeoutMs);

afterAll(async () => {
  try { await closePostgres(container, pools, ports.map(port => () => port.close())); }
  finally { execFileSync("docker", ["volume", "rm", volume]); }
}, postgresTeardownTimeoutMs);

const row = async (id: string) => (await owner.query("SELECT to_jsonb(c)::text AS bytes, xmin::text AS version, ctid::text AS position FROM public.clients c WHERE id=$1", [id])).rows[0];
async function signIn(email: string) {
  const tokenHash = hash(randomUUID());
  expect(await challenges.issue({ email, tokenHash, expiresAt: new Date(Date.now() + 600_000).toISOString() })).toEqual({ deliverable: true });
  const redeemed = await challenges.redeem({ tokenHash, now: new Date().toISOString() });
  expect(redeemed).not.toBeNull(); return redeemed!;
}
function orderHistory(principalId: string, clientId: string) {
  return createPostgresCustomerOrderHistoryReadStore(runtime, { principalId, clientId,
    readInvoiceSummaries: async () => { throw new Error("invoice_owner_not_part_of_contact_proof"); } });
}
async function draft(clientId: string) {
  const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
  return createPostgresNativeCheckoutPersistence(runtime).createOrderDraft({ idempotencyKey: `contact:${randomUUID()}`,
    quoteSnapshot: { contractVersion: "commerce.v0", quote: { currency: "XXX", taxIncluded: true,
      lines: [{ sku: "CONTACT-PROOF", productSlug: "contact-proof", quantity: 1, unitPriceGross: money(200), lineSubtotalGross: money(200),
        tax: { included: true, country: "ZZ", category: "standard", vatRateBps: 2000, legalBasis: "Synthetic test tax", netAmount: money(167), vatAmount: money(33), grossAmount: money(200) } }],
      discounts: [], context: { mode: "one_time", cadenceDays: null, promoCodes: [] }, subtotalGross: money(200), discountTotalGross: money(0),
      shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(200), netTotal: money(167), taxTotal: money(33) } } }, { clientId });
}
function privacy(store: PrivacyStore<PgQueryExecutor> = createPostgresPrivacyStore(), id = randomUUID()) {
  const unitOfWork = createPostgresPrivacyUnitOfWork({ connectionString: runtimeUrl }); ports.push(unitOfWork);
  const retainedContactFields = Object.fromEntries(["lifecycle_stage", "acquisition_source", "metadata"].map(key => [key,
    { owner: "clients", resource: `clients.${key}`, disposition: "retain" as const, reasonCode: "CHECKOUT_PROVENANCE", remote: false }]));
  const registry = createPersonalDataContributorRegistry([createIdentityPersonalDataContributor(store, { retainedContactFields }, () => id)], { requiredContributorIds: ["identity"] });
  return createPrivacyOperations({ store, unitOfWork, registry, now: () => new Date(), randomId: () => id });
}

it("creates one unlinked contact, then reuses its identity and existing provenance", async () => {
  const first = success(await registrar.ensureContactClient(input("first@example.test")));
  expect(first).toMatchObject({ created: true, linked: false });
  expect((await owner.query("SELECT email,principal_id,acquisition_source,lifecycle_stage FROM public.clients WHERE id=$1", [first.clientId])).rows)
    .toEqual([{ email: "first@example.test", principal_id: null, acquisition_source: "checkout", lifecycle_stage: "lead" }]);
  expect(await registrar.ensureContactClient({ ...input("first@example.test"), acquisitionSource: "different", lifecycleStage: "customer" }))
    .toEqual({ ...first, created: false });
  expect((await owner.query("SELECT acquisition_source,lifecycle_stage FROM public.clients WHERE id=$1", [first.clientId])).rows)
    .toEqual([{ acquisition_source: "checkout", lifecycle_stage: "lead" }]);
});

it("converges 24 concurrent calls across pools on one client and one creator", async () => {
  const strongerDefault = new URL(runtimeUrl);
  strongerDefault.searchParams.set("options", "-c default_transaction_isolation=repeatable\\ read");
  const second = createPostgresContactClientRegistrar({ connectionString: strongerDefault.toString() }); ports.push(second);
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? second : registrar).ensureContactClient(input("race@example.test"))));
  const contacts = results.map(success);
  expect(new Set(contacts.map(value => value.clientId)).size).toBe(1);
  expect(contacts.filter(value => value.created)).toHaveLength(1);
  expect((await owner.query("SELECT id FROM public.clients WHERE lower(email)='race@example.test'")).rows).toHaveLength(1);
});

it("normalizes case/outer whitespace but preserves plus tags and dots", async () => {
  const first = success(await registrar.ensureContactClient(input("  Case.Name@Example.Test  ")));
  expect(await registrar.ensureContactClient(input("case.name@example.test"))).toEqual({ ...first, created: false });
  const plus = success(await registrar.ensureContactClient(input("case.name+tag@example.test")));
  const dotted = success(await registrar.ensureContactClient(input("casename@example.test")));
  expect(new Set([first.clientId, plus.clientId, dotted.clientId]).size).toBe(3);
});

it("returns a linked client with every stored byte and row version unchanged", async () => {
  const contact = success(await registrar.ensureContactClient(input("linked@example.test")));
  const session = await signIn("linked@example.test");
  await owner.query(`UPDATE public.clients SET first_name='Existing',last_name='Person',phone='000',country='ZZ',
    metadata='{"existing":["unchanged"]}',updated_at='2026-01-01 01:02:03.123456+00' WHERE id=$1`, [contact.clientId]);
  const before = await row(contact.clientId);
  expect(await registrar.ensureContactClient({ ...input("linked@example.test"), acquisitionSource: "other", lifecycleStage: "customer",
    profileDefaults: { firstName: "Attempted", lastName: "Replacement", phone: "999", country: "YY" },
    journey: { idempotencyKey: "linked-replacement", locale: "en", mode: "subscription" } }))
    .toEqual({ ok: true, clientId: contact.clientId, created: false, linked: true });
  expect(await row(contact.clientId)).toEqual(before);
  expect((await owner.query("SELECT principal_id FROM public.clients WHERE id=$1", [contact.clientId])).rows[0].principal_id).toBe(session.principalId);
});

it("initializes and refreshes unlinked defaults without letting empty defaults erase them", async () => {
  const email = "defaults@example.test";
  const first = success(await registrar.ensureContactClient({ ...input(email),
    profileDefaults: { firstName: "Initial", lastName: "Person", phone: "111", country: "ZZ" },
    journey: { idempotencyKey: "initial-journey", locale: "en", mode: "one_time" } }));
  const fields = async () => (await owner.query("SELECT first_name,last_name,phone,country,updated_at::text,metadata FROM public.clients WHERE id=$1", [first.clientId])).rows[0];
  const initial = await fields();
  expect(initial).toMatchObject({ first_name: "Initial", last_name: "Person", phone: "111", country: "ZZ",
    metadata: { checkout: { lastIntentIdempotencyKey: "initial-journey", locale: "en", mode: "one_time", clientMatchReason: "client_created" } } });
  await owner.query("UPDATE public.clients SET metadata=metadata || '{\"unrelated\":true}'::jsonb WHERE id=$1", [first.clientId]);
  expect(await registrar.ensureContactClient({ ...input(email), profileDefaults: { firstName: "Refreshed", lastName: "", phone: null, country: "YY" },
    journey: { idempotencyKey: "updated-journey", locale: "pl", mode: "subscription" } }))
    .toEqual({ ...first, created: false });
  const refreshed = await fields();
  expect(refreshed).toMatchObject({ first_name: "Refreshed", last_name: "Person", phone: "111", country: "YY",
    metadata: { unrelated: true, checkout: { lastIntentIdempotencyKey: "updated-journey", locale: "pl", mode: "subscription", clientMatchReason: "client_match_exact_email" } } });
  expect(refreshed.updated_at).not.toBe(initial.updated_at);
  await registrar.ensureContactClient({ ...input(email), profileDefaults: { firstName: "", lastName: "", phone: "", country: "" } });
  expect(await fields()).toMatchObject({ ...refreshed, updated_at: expect.any(String) });
  const session = await signIn(email);
  expect(await readPostgresCustomerAccountClient(runtime, { clientId: first.clientId, principalId: session.principalId }))
    .toMatchObject({ id: first.clientId, first_name: "Refreshed", last_name: "Person", phone: "111" });
});

it("fills previously blank unlinked defaults and treats absent optional fields as no profile input", async () => {
  const first = success(await registrar.ensureContactClient(input("blank-defaults@example.test")));
  await registrar.ensureContactClient({ ...input("blank-defaults@example.test"), profileDefaults: { firstName: "Filled", phone: "222" } });
  expect((await owner.query("SELECT first_name,last_name,phone,country FROM public.clients WHERE id=$1", [first.clientId])).rows)
    .toEqual([{ first_name: "Filled", last_name: null, phone: "222", country: null }]);
});

it("preserves opaque legacy metadata exactly when no journey is supplied", async () => {
  const contact = success(await registrar.ensureContactClient(input("opaque-metadata@example.test")));
  await owner.query("UPDATE public.clients SET metadata='[\"opaque\",{\"existing\":true}]'::jsonb WHERE id=$1", [contact.clientId]);
  const before = (await owner.query("SELECT metadata::text FROM public.clients WHERE id=$1", [contact.clientId])).rows[0].metadata;
  await registrar.ensureContactClient({ ...input("opaque-metadata@example.test"), profileDefaults: { firstName: "Guest" } });
  expect((await owner.query("SELECT metadata::text,first_name FROM public.clients WHERE id=$1", [contact.clientId])).rows)
    .toEqual([{ metadata: before, first_name: "Guest" }]);
});

it("rechecks the unlinked UPDATE predicate after a concurrent challenge redemption commits", async () => {
  const email = "link-race@example.test";
  const contact = success(await registrar.ensureContactClient({ ...input(email), profileDefaults: { firstName: "Protected" } }));
  const tokenHash = hash(randomUUID());
  expect(await challenges.issue({ email, tokenHash, expiresAt: new Date(Date.now() + 600_000).toISOString() })).toEqual({ deliverable: true });
  const redeemer = await runtime.connect();
  let refreshing: Promise<EnsureContactClientResult> | undefined;
  let before: unknown;
  try {
    await redeemer.query("BEGIN");
    // Exercise the actual redemption and its row lock under the restricted login.
    // No erasure races in this witness; ordinary application sign-in uses the adapter.
    await redeemer.query("LOCK TABLE public.customer_identity_challenges IN EXCLUSIVE MODE");
    expect((await redeemer.query("SELECT public.customer_identity_challenge_redeem($1,now()) AS result", [tokenHash])).rows[0].result).toHaveProperty("principalId");
    before = (await redeemer.query("SELECT to_jsonb(c)::text AS bytes,xmin::text AS version,ctid::text AS position FROM public.clients c WHERE id=$1", [contact.clientId])).rows[0];
    refreshing = registrar.ensureContactClient({ ...input(email), profileDefaults: { firstName: "Must not win", phone: "999" },
      journey: { idempotencyKey: "must-not-update", locale: "en", mode: "one_time" } });
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      waiting = Number((await owner.query("SELECT count(*) AS count FROM pg_stat_activity WHERE usename='contact_runtime' AND wait_event_type='Lock' AND query LIKE 'UPDATE public.clients SET%'" )).rows[0].count) > 0;
      if (waiting) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await redeemer.query("COMMIT");
  } finally {
    await redeemer.query("ROLLBACK"); redeemer.release();
  }
  expect(await refreshing).toEqual({ ok: true, clientId: contact.clientId, created: false, linked: true });
  expect(await row(contact.clientId)).toEqual(before);
});

it("refuses malformed input before opening a database connection", async () => {
  const unopened = createPostgresContactClientRegistrar({ connectionString: "postgres://unreachable.invalid/unopened" });
  try {
    expect(await unopened.ensureContactClient(input("not-an-email"))).toEqual({ ok: false, code: "contact_client_email_invalid" });
    expect(await unopened.ensureContactClient({ ...input("valid@example.test"), acquisitionSource: "" })).toEqual({ ok: false, code: "contact_client_input_invalid" });
    expect(await unopened.ensureContactClient({ ...input("valid@example.test"), principalId: randomUUID() } as Parameters<typeof unopened.ensureContactClient>[0]))
      .toEqual({ ok: false, code: "contact_client_input_invalid" });
  } finally { await unopened.close(); }
});

it.each([false, true])("matches the reference exact email with canonical peer=%s and preserves challenge continuation", async peer => {
  const email = `legacy-${peer}@example.test`;
  // Deliberate malformed legacy identity fixture, not a journey creation path.
  const padded = (await owner.query("INSERT INTO public.clients(email) VALUES($1) RETURNING id", [` ${email} `])).rows[0].id;
  const canonical = peer ? success(await registrar.ensureContactClient(input(email))) : null;
  const before = await row(padded);
  const ensured = success(await registrar.ensureContactClient(input(email)));
  expect(ensured.created).toBe(!peer);
  if (canonical) expect(ensured.clientId).toBe(canonical.clientId);
  expect(ensured.clientId).not.toBe(padded);
  expect(await row(padded)).toEqual(before);
  expect((await owner.query("SELECT email FROM public.clients WHERE id=$1", [ensured.clientId])).rows[0].email).toBe(email);
  const order = await draft(ensured.clientId), session = await signIn(email);
  expect(await readPostgresCustomerAccountClient(runtime, { clientId: ensured.clientId, principalId: session.principalId })).toMatchObject({ id: ensured.clientId, email });
  const orders = await orderHistory(session.principalId, ensured.clientId).readCustomerOrders(ensured.clientId, [], 20);
  expect(orders.map(value => value.id)).toEqual([order.orderDraft.orderId.replace(/^order_/, "")]);
  expect(await row(padded)).toEqual(before);
  // A separate native reconciliation path trims stored legacy email. Its existing
  // ambiguity diagnostic is a limit of that path, not a checkout refusal.
  const linking = createPostgresAccountLinkStore({ connectionString: runtimeUrl });
  try { await expect(linking.findAccountByEmail(email)).rejects.toThrow("account_normalized_email_ambiguous"); }
  finally { await linking.close(); }
});

it("rolls back an insertion when a deferred database failure aborts commit", async () => {
  await owner.query(`CREATE FUNCTION public.contact_proof_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.email='rollback@example.test' THEN RAISE EXCEPTION 'synthetic_contact_commit_failure'; END IF; RETURN NEW; END $$;
    CREATE CONSTRAINT TRIGGER contact_proof_fail AFTER INSERT ON public.clients DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.contact_proof_fail()`);
  try {
    await expect(registrar.ensureContactClient(input("rollback@example.test"))).rejects.toMatchObject({ message: "synthetic_contact_commit_failure" });
    expect((await owner.query("SELECT id FROM public.clients WHERE email='rollback@example.test'")).rows).toEqual([]);
  } finally { await owner.query("DROP TRIGGER contact_proof_fail ON public.clients; DROP FUNCTION public.contact_proof_fail()"); }
});

it("continues from a guest contact and native draft through challenge to the same owned account/order", async () => {
  const contact = success(await registrar.ensureContactClient(input("journey@example.test")));
  const order = await draft(contact.clientId);
  const session = await signIn("journey@example.test");
  expect(await readPostgresCustomerAccountClient(runtime, { clientId: contact.clientId, principalId: session.principalId })).toMatchObject({ id: contact.clientId, email: "journey@example.test" });
  const orders = await orderHistory(session.principalId, contact.clientId).readCustomerOrders(contact.clientId, [], 20);
  expect(orders.map(value => value.id)).toEqual([order.orderDraft.orderId.replace(/^order_/, "")]);
  expect(await readPostgresCustomerAccountClient(runtime, { clientId: contact.clientId, principalId: randomUUID() })).toBeNull();
});

it("refuses the erased shell but gives the freed address a fresh client with no erased history", async () => {
  const email = "erasure@example.test", old = success(await registrar.ensureContactClient({ ...input(email),
    profileDefaults: { firstName: "Erase this profile" },
    journey: { idempotencyKey: "retained-journey-fact", locale: "en", mode: "one_time" } }));
  await draft(old.clientId);
  await privacy().erase({ principalId: admin }, { subject: { kind: "contact", contactId: old.clientId }, idempotencyKey: randomUUID() });
  const shell = (await owner.query("SELECT email FROM public.clients WHERE id=$1", [old.clientId])).rows[0];
  const before = await row(old.clientId);
  expect(await registrar.ensureContactClient(input(shell.email))).toEqual({ ok: false, code: "account_erased_refused" });
  const fresh = success(await registrar.ensureContactClient(input(email)));
  expect(fresh.clientId).not.toBe(old.clientId); expect(fresh).toMatchObject({ created: true, linked: false });
  const session = await signIn(email);
  expect(await orderHistory(session.principalId, fresh.clientId).readCustomerOrders(fresh.clientId, [], 20)).toEqual([]);
  expect(await readPostgresCustomerAccountClient(runtime, { clientId: old.clientId, principalId: session.principalId })).toBeNull();
  expect(await row(old.clientId)).toEqual(before);
});

it("waits for concurrent erasure to commit before deciding shell refusal and fresh-address creation", async () => {
  const email = "concurrent-erasure@example.test", old = success(await registrar.ensureContactClient(input(email))), id = randomUUID();
  const base = createPostgresPrivacyStore();
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const store: PrivacyStore<PgQueryExecutor> = { ...base, async saveReceipt(...args) { await base.saveReceipt(...args); entered(); await proceed; } };
  const erasing = privacy(store, id).erase({ principalId: admin }, { subject: { kind: "contact", contactId: old.clientId }, idempotencyKey: randomUUID() });
  await arrived;
  const shell = registrar.ensureContactClient(input(`erased+${id}@identity.invalid`));
  const fresh = registrar.ensureContactClient(input(email));
  try {
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      waiting = Number((await owner.query(`SELECT count(*) AS count FROM pg_locks WHERE relation='public.identity_privacy_erasures'::regclass AND mode='ShareLock' AND NOT granted`)).rows[0].count) === 2;
      if (waiting) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
  } finally { release(); }
  await erasing;
  expect(await shell).toEqual({ ok: false, code: "account_erased_refused" });
  expect(success(await fresh).clientId).not.toBe(old.clientId);
});
