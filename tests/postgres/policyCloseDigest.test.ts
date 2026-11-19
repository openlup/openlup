import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertSubscriptionPricePolicyDigest, createCommercePriceAuthorityPort, digestSubscriptionPricePolicy,
  type SubscriptionPricePolicyCanonicalInput } from "@openlup/platform/pricing";
import { createPostgresCommercePriceAuthorityReadPort } from "@openlup/platform/commerce/server/postgres";
import { createPostgresCommercePriceAuthorityPort } from "../../server/adapters/postgres/pricingResolver.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const forward = "db/platform/migrations/20261122140000_subscription_price_policy_close_digest.sql";
const resources = storeJourneyResources(), containers: PostgresContainer[] = [], pools: Pool[] = [];
let source: JourneyInstallation, target: JourneyInstallation, legacy: Pool;
let list: string, sku: string, from: string, end: string, after: string;
let legacyClosed: SubscriptionPricePolicyCanonicalInput, legacyFinite: SubscriptionPricePolicyCanonicalInput;
const semantics = { discountBps: 1000, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM" as const };
const context = { regionCode: "ZZ", currency: "XXX", channel: "close" };

async function insert(db: Pool, input: SubscriptionPricePolicyCanonicalInput) {
  const value = { ...input, digest: await digestSubscriptionPricePolicy(input) };
  await db.query(`INSERT INTO public.subscription_price_policy_revisions
    (id,price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,
      rounding_rule,effective_from,effective_to,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [value.id, value.priceListId, value.regionCode, value.currency, value.channel, value.revisionNo,
    value.discountBps, value.roundingQuantumMinor, value.roundingRule, value.effectiveFrom, value.effectiveTo, value.digest]);
  return value;
}
function input(channel: string, effectiveTo: string | null = null): SubscriptionPricePolicyCanonicalInput {
  return { id: randomUUID(), priceListId: list, ...context, channel, revisionNo: 1, ...semantics, effectiveFrom: from, effectiveTo };
}
function query(channel: string, atTime = from) {
  return { ...context, channel, variantId: sku, mode: "subscription" as const, atTime };
}
async function continuity() {
  const rows = await journeyCensus(source.owner);
  delete rows.subscription_price_policy_revisions;
  return rows;
}

beforeAll(async () => {
  source = await resources.installation("policy-close-source");
  target = await resources.installation("policy-close-target");
  const times = (await source.owner.query(`SELECT date_trunc('milliseconds',clock_timestamp()) AS start,
    date_trunc('milliseconds',clock_timestamp())+interval '1 day' AS finish,
    date_trunc('milliseconds',clock_timestamp())+interval '2 days' AS later`)).rows[0];
  from = times.start.toISOString(); end = times.finish.toISOString(); after = times.later.toISOString();
  const product = (await source.owner.query("INSERT INTO public.catalog_products(slug,name) VALUES('policy-close','Synthetic item') RETURNING id")).rows[0].id;
  sku = (await source.owner.query("INSERT INTO public.catalog_skus(product_id,sku,title) VALUES($1,'POLICY-CLOSE','Synthetic SKU') RETURNING id", [product])).rows[0].id;
  list = (await source.owner.query("INSERT INTO public.price_lists(name,region_code,currency,valid_from) VALUES('Synthetic prices','ZZ','XXX',$1) RETURNING id", [from])).rows[0].id;
  await source.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'one_time',1490,$3)", [list, sku, from]);
  const client = (await source.owner.query("INSERT INTO public.clients(email) VALUES('policy-close@example.invalid') RETURNING id")).rows[0].id;
  const subscription = (await source.owner.query("INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at,price_list_id,currency_code) VALUES($1,28,$2,$3,'XXX') RETURNING id", [client, after, list])).rows[0].id;
  await source.owner.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,2,0,1340,'XXX')", [subscription, sku]);
  await source.owner.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,
    settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,'XXX','synthetic','sandbox',$2,'synthetic:authorization')`, [subscription, from]);
  await source.owner.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,'POLICY-CLOSE',2,1340)", [subscription]);
  const cycle = (await source.owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at) VALUES($1,$2) RETURNING id", [subscription, after])).rows[0].id;
  const db = await source.owner.connect();
  try {
    await db.query("BEGIN");
    const order = (await db.query("INSERT INTO public.commerce_orders(client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,'pending_payment','XXX',2680) RETURNING id", [client, cycle])).rows[0].id;
    await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,sku_id,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,$2,2,1340,2680)", [order, sku]);
    await db.query("COMMIT");
  } finally { await db.query("ROLLBACK"); db.release(); }

  // Existing rows are exercised against the issued prefix before this forward exists.
  const container = await runPostgresContainer({ name: `policy-close-upgrade-${process.pid}`, password: "synthetic-policy" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Policy upgrade PostgreSQL unavailable");
  legacy = new Pool({ connectionString: container.connectionString }); pools.push(legacy);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === forward) break;
    await legacy.query(readFileSync(unit.file, "utf8"));
  }
  const oldList = (await legacy.query("INSERT INTO public.price_lists(name,region_code,currency,valid_from) VALUES('Synthetic legacy','ZZ','XXX',$1) RETURNING id", [from])).rows[0].id;
  legacyClosed = { ...input("legacy-closed"), priceListId: oldList };
  legacyFinite = { ...input("legacy-finite", end), priceListId: oldList };
  await insert(legacy, legacyClosed); await insert(legacy, legacyFinite);
  await legacy.query("UPDATE public.subscription_price_policy_revisions SET effective_to=$2 WHERE id=$1", [legacyClosed.id, end]);
  const before = (await legacy.query("SELECT to_jsonb(p) AS value FROM public.subscription_price_policy_revisions p ORDER BY id")).rows;
  await legacy.query(readFileSync(forward, "utf8"));
  expect((await legacy.query("SELECT to_jsonb(p)-'closed_from_open' AS value FROM public.subscription_price_policy_revisions p ORDER BY id")).rows).toEqual(before);
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(containers, pools); await resources.close(); }, postgresTeardownTimeoutMs);

it("policy_close_preserves_original_digest", async () => {
  const policy = await insert(source.owner, input("close"));
  const persisted = await createPostgresCommercePriceAuthorityReadPort(source.runtime)
    .listSubscriptionPolicyHistory({ ...context, priceListId: list });
  expect(await assertSubscriptionPricePolicyDigest(persisted[0].value)).toEqual(policy);
  const before = await continuity();
  for (const table of ["subscriptions", "subscription_lines", "subscription_cycles", "subscription_renewal_terms",
    "subscription_renewal_term_lines", "commerce_orders", "commerce_order_items"]) expect(before[table].length).toBeGreaterThan(0);
  await source.owner.query("UPDATE public.subscription_price_policy_revisions SET effective_to=$2 WHERE id=$1", [policy.id, end]);
  // Both native readers reconnect as the actual restricted runtime login.
  const reconnect = new Pool({ connectionString: source.runtimeUrl }); pools.push(reconnect);
  for (const authority of [createCommercePriceAuthorityPort(createPostgresCommercePriceAuthorityReadPort(reconnect)),
    createPostgresCommercePriceAuthorityPort(reconnect)]) {
    const result = await authority.resolvePrice(query("close"));
    expect(result).toMatchObject({ kind: "subscription_policy", unitPriceMinor: 1340,
      policy: { ...policy, effectiveTo: end, closedFromOpen: true } });
    if (result.kind !== "subscription_policy") throw new Error("Policy evidence missing");
    expect(await assertSubscriptionPricePolicyDigest(result.policy)).toEqual(result.policy);
    await expect(authority.resolvePrice(query("close", end))).rejects.toMatchObject({ code: "subscription_price_policy_not_effective" });
  }
  expect((await source.owner.query("SELECT digest,closed_from_open FROM public.subscription_price_policy_revisions WHERE id=$1", [policy.id])).rows)
    .toEqual([{ digest: policy.digest, closed_from_open: true }]);
  await expect(source.owner.query("UPDATE public.subscription_price_policy_revisions SET effective_to=$2 WHERE id=$1", [policy.id, after]))
    .rejects.toMatchObject({ code: "55000", message: "subscription_price_policy_revision_close_only" });
  await expect(source.owner.query("UPDATE public.subscription_price_policy_revisions SET closed_from_open=false WHERE id=$1", [policy.id]))
    .rejects.toMatchObject({ code: "55000" });
  expect(await continuity()).toEqual(before);
});

it("refuses unverified already-closed adoption and preserves verified finite tuples", async () => {
  const histories = await createPostgresCommercePriceAuthorityReadPort(legacy).listSubscriptionPolicyHistory({ ...context,
    priceListId: legacyClosed.priceListId, channel: legacyClosed.channel });
  await expect(assertSubscriptionPricePolicyDigest(histories[0].value))
    .rejects.toMatchObject({ code: "subscription_price_policy_original_tuple_unverified" });
  const finite = await createPostgresCommercePriceAuthorityReadPort(legacy).listSubscriptionPolicyHistory({ ...context,
    priceListId: legacyFinite.priceListId, channel: legacyFinite.channel });
  await expect(assertSubscriptionPricePolicyDigest(finite[0].value)).resolves.toMatchObject(legacyFinite);
});

it("overlap rollback preserves the shortened window, original digest and whole commerce snapshot", async () => {
  const original = await insert(source.owner, input("rollback"));
  const before = await journeyCensus(source.owner), successor = { ...input("rollback"), revisionNo: 2, effectiveFrom: end };
  const digest = await digestSubscriptionPricePolicy(successor), db = await source.owner.connect();
  try {
    await db.query("BEGIN");
    await db.query("UPDATE public.subscription_price_policy_revisions SET effective_to=$2 WHERE id=$1", [original.id, after]);
    await db.query("UPDATE public.price_lists SET name='must roll back' WHERE id=$1", [list]);
    await expect(db.query(`INSERT INTO public.subscription_price_policy_revisions
      (id,price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,rounding_rule,effective_from,digest)
      VALUES($1,$2,'ZZ','XXX','rollback',2,1000,10,'FLOOR_TO_QUANTUM',$3,$4)`, [successor.id, list, end, digest]))
      .rejects.toMatchObject({ code: "23P01", message: "subscription_price_policy_revision_overlaps" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await journeyCensus(source.owner)).toEqual(before);
});

it("keeps policy mutation and its marker unavailable to the runtime login", async () => {
  await expect(source.runtime.query("UPDATE public.subscription_price_policy_revisions SET closed_from_open=true WHERE false"))
    .rejects.toMatchObject({ code: "42501" });
  await expect(source.runtime.query("UPDATE public.subscription_price_policy_revisions SET effective_to=now() WHERE false"))
    .rejects.toMatchObject({ code: "42501" });
  const open = await insert(source.owner, input("tamper"));
  await expect(source.owner.query("UPDATE public.subscription_price_policy_revisions SET effective_to=$2,digest=$3 WHERE id=$1", [open.id, end, "a".repeat(64)]))
    .rejects.toMatchObject({ code: "55000" });
  await expect(source.owner.query("UPDATE public.subscription_price_policy_revisions SET effective_to=effective_from WHERE id=$1", [open.id]))
    .rejects.toMatchObject({ code: "55000" });
  await expect(source.owner.query("DELETE FROM public.subscription_price_policy_revisions WHERE id=$1", [open.id]))
    .rejects.toMatchObject({ code: "55000" });
  await expect(source.owner.query(`INSERT INTO public.subscription_price_policy_revisions
    (price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,
      rounding_rule,effective_from,digest,closed_from_open)
    VALUES($1,'ZZ','XXX','invalid-window',1,1000,10,'FLOOR_TO_QUANTUM',$2,$3,true)`, [list, from, open.digest]))
    .rejects.toMatchObject({ code: "23514", constraint: "subscription_price_policy_revisions_closed_from_open_check" });
});

it.each([false, true])("transfer_round_trip_matrix preserves the original policy tuple and close marker: %s", async closedFromOpen => {
  const before = await journeyCensus(source.owner);
  const packet = await captureStoreJourney(source.owner, "policy-close-transfer");
  const freshTarget = await captureStoreJourney(target.owner, "policy-close-target");
  expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget }))
    .toMatchObject({ replayed: closedFromOpen });
  expect(await journeyCensus(target.owner)).toEqual(before);
  const rows = before.subscription_price_policy_revisions.map(value => JSON.parse(value));
  expect(rows.filter(value => value.closed_from_open === closedFromOpen).length).toBeGreaterThan(0);
  for (const row of rows.filter(value => value.closed_from_open === closedFromOpen)) {
    const history = await createPostgresCommercePriceAuthorityReadPort(target.runtime).listSubscriptionPolicyHistory({ ...context,
      priceListId: row.price_list_id, channel: row.channel });
    const revision = history.find(value => (value.value as { id: string }).id === row.id)!;
    expect(await assertSubscriptionPricePolicyDigest(revision.value)).toMatchObject({ digest: row.digest,
      effectiveTo: row.effective_to === null ? null : new Date(row.effective_to).toISOString() });
  }
});

const markerRefusal = { code: "55000", message: "subscription_price_policy_revision_close_provenance_requires_restore" };
const markerForward = "db/platform/migrations/20261123160000_subscription_price_policy_close_provenance.sql";
const capabilityTable = "public.subscription_price_policy_restore_capabilities";
const markedInsert = `INSERT INTO public.subscription_price_policy_revisions
  (id,price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,
    rounding_rule,effective_from,effective_to,digest,closed_from_open)
  VALUES($1,$2,'ZZ','XXX',$3,1,1000,10,'FLOOR_TO_QUANTUM',$4,$5,$6,$7)
  RETURNING closed_from_open`;

it.each([
  { rule: "CLM-01 refuses a plain marked finite policy insert", marker: true, finite: true, refusal: markerRefusal },
  { rule: "CLM-03 allows an unmarked finite insert", marker: false, finite: true, refusal: null },
  { rule: "CLM-04 preserves the open-window check", marker: true, finite: false,
    refusal: { code: "23514", constraint: "subscription_price_policy_revisions_closed_from_open_check" } },
])("$rule", async ({ rule, marker, finite, refusal }) => {
  const policy = input(rule.slice(0, 6).toLowerCase(), finite ? end : null);
  const write = source.owner.query(markedInsert, [policy.id, list, policy.channel, from, policy.effectiveTo,
    await digestSubscriptionPricePolicy({ ...policy, effectiveTo: marker ? null : policy.effectiveTo }), marker]);
  if (refusal) await expect(write).rejects.toMatchObject(refusal);
  else await expect(write).resolves.toMatchObject({ rows: [{ closed_from_open: false }] });
});

it("CLM-05 refuses a capability from a different transaction", async () => {
  const old = (await source.owner.query(`INSERT INTO ${capabilityTable} VALUES (pg_current_xact_id()) RETURNING transaction_id::text`)).rows[0].transaction_id;
  try {
    const policy = input("clm-05", end);
    await expect(source.owner.query(markedInsert, [policy.id, list, policy.channel, from, end,
      await digestSubscriptionPricePolicy({ ...policy, effectiveTo: null }), true])).rejects.toMatchObject(markerRefusal);
  } finally {
    await source.owner.query(`DELETE FROM ${capabilityTable} WHERE transaction_id=$1::xid8`, [old]);
  }
});

it("CLM-08 preserves guarded close provenance", async () => {
  const policy = await insert(source.owner, input("clm-08"));
  const result = await source.owner.query(`UPDATE public.subscription_price_policy_revisions SET effective_to=$2
    WHERE id=$1 RETURNING closed_from_open, effective_to, digest`, [policy.id, end]);
  expect(result.rows).toEqual([{ closed_from_open: true, effective_to: new Date(end), digest: policy.digest }]);
});

it("CLM-02 restores the exact marked policy row", async () => {
  const policy = await insert(source.owner, input("clm-02"));
  await source.owner.query("UPDATE public.subscription_price_policy_revisions SET effective_to=$2 WHERE id=$1", [policy.id, end]);
  const expected = await source.owner.query("SELECT to_jsonb(p)::text AS value FROM public.subscription_price_policy_revisions p WHERE id=$1", [policy.id]);
  expect(JSON.parse(expected.rows[0].value).closed_from_open).toBe(true);
  const copy = await resources.installation("policy-marker-target");
  const packet = await captureStoreJourney(source.owner, "policy-marker-source");
  const freshTarget = await captureStoreJourney(copy.owner, "policy-marker-target");
  await expect(restoreConnectedNativeStore({ owner: copy.owner, installation: journeySelection, packet, freshTarget }))
    .resolves.toMatchObject({ replayed: false });
  const restored = await copy.owner.query("SELECT to_jsonb(p)::text AS value FROM public.subscription_price_policy_revisions p WHERE id=$1", [policy.id]);
  expect(restored.rows).toEqual(expected.rows);
});

it("CLM-06 leaves no capability after native restore", async () => {
  const copy = await resources.installation("policy-capability-target");
  const packet = await captureStoreJourney(source.owner, "policy-capability-source");
  const freshTarget = await captureStoreJourney(copy.owner, "policy-capability-target");
  await expect(restoreConnectedNativeStore({ owner: copy.owner, installation: journeySelection, packet, freshTarget }))
    .resolves.toMatchObject({ replayed: false });
  expect((await copy.owner.query(`SELECT transaction_id FROM ${capabilityTable}`)).rows).toEqual([]);
});

it("CLM-09 installs the exact capability storage shape", async () => {
  const shape = await source.owner.query(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
    ARRAY(SELECT a.attname || ':' || pg_catalog.format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull::text
      FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
    ARRAY(SELECT pg_catalog.pg_get_constraintdef(k.oid) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid ORDER BY k.conname) AS constraints,
    ARRAY(SELECT p.polname::text FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid ORDER BY p.polname) AS policies
    FROM pg_catalog.pg_class c WHERE c.oid=$1::regclass`, [capabilityTable]);
  expect(shape.rows).toEqual([{ rls: true, forced: false, columns: ["transaction_id:xid8:true"],
    constraints: ["PRIMARY KEY (transaction_id)"], policies: [] }]);
});

it("CLM-10 refuses runtime capability writes even with a table grant", async () => {
  const db = await source.owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(`GRANT INSERT ON ${capabilityTable} TO transfer_runtime`);
    await db.query("SET LOCAL ROLE transfer_runtime");
    await expect(db.query(`INSERT INTO ${capabilityTable} VALUES (pg_current_xact_id())`))
      .rejects.toMatchObject({ code: "42501", message: expect.stringContaining("row-level security policy") });
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("CLM-11 revokes inherited default public access", async () => {
  const db = await legacy.connect();
  try {
    await db.query("BEGIN");
    await db.query("ALTER DEFAULT PRIVILEGES GRANT INSERT ON TABLES TO PUBLIC");
    await db.query(readFileSync(markerForward, "utf8"));
    const acl = await db.query(`SELECT a.privilege_type FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
      WHERE c.oid=$1::regclass AND a.grantee=0`, [capabilityTable]);
    expect(acl.rows).toEqual([]);
  } finally { await db.query("ROLLBACK"); db.release(); }
});
