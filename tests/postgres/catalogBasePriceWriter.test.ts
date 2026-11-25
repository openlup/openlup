import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseError, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalCatalogPriceSetupCommand, createPostgresCatalogPriceSetupStore } from "@openlup/platform/pricing";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createPostgresPurchaseRenewalWriter, createPostgresRenewalStore, createNativeRenewalCodec, createPostgresPackageEditReadPort } from "@openlup/platform/subscriptions";
import { boundOneTimePurchase } from "./acquisitionAdmissionFixture.js";
import { captureSandboxPurchase, createHistoricalPurchaseDraft } from "../helpers/captureSandboxPurchase.js";
import { journeyCensus } from "../helpers/storeJourney.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const inputsPath = "db/platform/migrations/20261122170000_offer_policy_readiness_inputs.sql";
const writerPath = "db/platform/migrations/20261122180000_catalog_base_price_writer.sql";
const commandsPath = "db/platform/migrations/20261123191000_catalog_publication_commands.sql";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const containers: PostgresContainer[] = [], pools: Pool[] = [];
let owner: Pool;
let genuine: Awaited<ReturnType<typeof genuinePurchase>>;
const actor = randomUUID(), otherActor = randomUUID();
const rpc = async (db: Pool | PoolClient, name: string, values: unknown[] = []) =>
  (await db.query(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS value`, values)).rows[0].value;
async function session(db: PoolClient, id = actor) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: "authenticated" })]);
}
async function transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await owner.connect();
  try { await db.query("BEGIN"); await session(db); return await work(db); }
  finally { await db.query("ROLLBACK"); db.release(); }
}
async function current(db: Pool | PoolClient, sku = genuine.sku) {
  return (await db.query("SELECT id,unit_price_minor FROM public.price_entries WHERE variant_id=$1 AND mode='one_time' AND active AND valid_from<statement_timestamp() AND (valid_to IS NULL OR valid_to>statement_timestamp())", [sku])).rows[0];
}
async function command(db: Pool | PoolClient, delta: Record<string, unknown> = {}) {
  const previous = await current(db);
  return { schemaVersion: 1, commandKey: randomUUID(), variantId: genuine.sku, priceListId: genuine.list,
    mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1200,
    expected: { entryId: previous.id, unitPriceMinor: previous.unit_price_minor }, ...delta };
}
async function apply(db: Pool | PoolClient, value: unknown) {
  const bytes = canonicalCatalogPriceSetupCommand(value);
  return rpc(db, "catalog_price_setup_apply", [bytes, createHash("sha256").update(bytes).digest("hex")]);
}
async function priceSnapshot(db: Pool | PoolClient) {
  const snapshot: Record<string, unknown> = {};
  for (const table of ["price_entries", "catalog_price_setup_receipts", "subscriptions", "subscription_lines", "subscription_renewal_terms",
    "subscription_renewal_term_lines", "subscription_cycles", "subscription_renewal_operations", "subscription_events", "commerce_orders"]) {
    snapshot[table] = (await db.query(`SELECT to_jsonb(t) AS value FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return snapshot;
}
const promotion = {
  id: "example:acquisition", status: "active", trigger_type: "automatic", code: null,
  discount_type: "percentage", discount_value: 50, applies_to_kind: "order_total",
  applies_to_payload: { cart_mode: "subscription", acquisitionTerms: { schemaVersion: "subscription-acquisition.v1", revision: "example:terms-1", delivery2DiscountBps: 3500 } },
  stacking_rule: "exclusive", eligibility: { first_subscription_purchase: true },
  valid_from: "", valid_to: null, redemption_limit_global: null,
  redemption_limit_per_customer: 1, region_availability: ["ZZ"], promotion_engine_version: "promotion-engine.v2",
  benefit_lane: "product", benefit_kind: "target_percentage", benefit_value_bps: 5000, benefit_value_minor: null, v2_mirror_of: null,
};

async function genuinePurchase(db: Pool) {
  const client = (await db.query("INSERT INTO public.clients(email) VALUES('actual-subscription@example.invalid') RETURNING id")).rows[0].id;
  const sku = randomUUID(), list = randomUUID();
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'readiness-agreed','Synthetic agreement')", [sku]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,'READINESS-AGREED','Synthetic agreed item',true)", [sku]);
  await db.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic','ZZ','XXX',statement_timestamp()-interval '1 hour')", [list]);
  await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'any',137,statement_timestamp()-interval '1 hour')", [list, sku]);
  const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
  const line = { sku: "READINESS-AGREED", productSlug: "readiness-agreed", quantity: 2, unitPriceGross: money(137), lineSubtotalGross: money(274),
    tax: { included: true as const, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "Synthetic tax",
      netAmount: money(274), vatAmount: money(0), grossAmount: money(274) } };
  const order = await createHistoricalPurchaseDraft(db, `readiness:${randomUUID()}`,
    { contractVersion: "commerce.v0", quote: { currency: "XXX", taxIncluded: true, lines: [line], discounts: [],
      context: { mode: "subscription", cadenceDays: 28, promoCodes: [] }, subtotalGross: money(274), discountTotalGross: money(0),
      shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(274), netTotal: money(274), taxTotal: money(0) } }, client);
  const at = (await db.query("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value;
  const intent = await rpc(db, "commerce_open_settlement_intent", [`open:${order}`, order, "sandbox", 274, "XXX", "{}", at]);
  await rpc(db, "subscription_declare_provisional_activation", [`declare:${order}`, order, 28, at]);
  await createPostgresDestinationPort(db).registerOrder({ idempotencyKey: `destination:${order}`, orderId: order, now: at,
    address: { recipientName: "Synthetic Buyer", line1: "1 Example Lane", city: "Synthetic", postalCode: "00000", country: "ZZ" } });
  const simulator = createPostgresSandboxPaymentSimulator(db, { dunningTemplateSlug: "example-failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "example-recovered" });
  expect(await captureSandboxPurchase(simulator, { settlementIntentId: intent.settlement.id, key: order, at })).toMatchObject({ status: 200 });
  const reference = (await db.query("SELECT coalesce(external_ref,id::text) AS value FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0].value;
  const writer = createPostgresPurchaseRenewalWriter(db);
  await writer.register(order, { settlementChannelKey: "sandbox", authorizationRef: "example:authorization", unattendedChargeAuthorizedAt: at,
    payerAccountRef: "example:payer", methodRef: "example:method", methodEvidenceRef: "example:evidence", stockSourceKey: "example:stock",
    templateId: "example:template", cadenceDays: 28, currency: "XXX", lines: [{ lineOrdinal: 1, sku: line.sku, quantity: 2, unitAmountMinor: 137 }],
    shippingAmountMinor: 0, acquisitionRef: "example:acquisition",
    renewalTerms: { version: "native.renewal-terms.v1", linePricing: [{ sku: line.sku, quantity: 2, unitAmountMinor: 137, isAddon: false, quoteLine: line }] } });
  const activation = await rpc(db, "subscription_activate_from_captured_payment", [`activate:${order}`, order, createHash("sha256").update(reference).digest("hex")]);
  await writer.complete(order);
  // Obtain independent governing quote evidence through the real accepted-edit
  // producer. Purchase-backed quotes alone have no historical admission proof.
  const edit = (await db.query(`SELECT template_version,
    to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
    to_char((statement_timestamp()+interval '15 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires
    FROM public.subscriptions WHERE id=$1`, [activation.subscriptionId])).rows[0];
  const base = [{ variantId: sku, qty: 2 }], addons: never[] = [];
  const compositionConstraint = { kind: "plan_days", value: 56 };
  const request = { planDays: 56, nominalPlanDays: 56, base, addons, compositionConstraint };
  const snapshot = { baseLines: [{ ...base[0], quoteLine: line }], addonLines: [], compositionConstraint };
  const totals = { currentRecurringPrice: money(274), newRecurringPrice: money(274), delta: money(0) };
  const hash = createHash("sha256").update(JSON.stringify({ request, snapshot, totals })).digest("hex"), editActor = randomUUID();
  await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','2') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
  await rpc(db, "subscription_quote_preview_record", [editActor, client, activation.subscriptionId, "update_package_template",
    hash, edit.template_version, edit.expires, request, snapshot, totals, edit.at]);
  const payload = { ...request, ...snapshot, ...totals, expectedTemplateVersion: edit.template_version, acceptedQuoteHash: hash,
    request: { ...request, expectedTemplateVersion: edit.template_version, acceptedQuoteHash: hash } };
  expect(await rpc(db, "subscription_package_edit_apply", [editActor, client, randomUUID(), activation.subscriptionId, payload, edit.at]))
    .toMatchObject({ status: "applied" });
  const next = (await db.query("SELECT to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value FROM public.subscriptions WHERE id=$1", [activation.subscriptionId])).rows[0].value;
  // Historical accepted purchase: the clock-relative fixture predates the
  // bounded recent-order census; retained terms carry its actual quote lines.
  await db.query("UPDATE public.commerce_orders SET created_at=statement_timestamp()-interval '25 hours' WHERE id=$1", [order]);
  return { subscriptionId: activation.subscriptionId, next, sku, list, order };
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Base-price writer requires real PostgreSQL");
  const container = await runPostgresContainer({ name: `catalog-price-writer-${process.pid}`, password: "synthetic-pricing" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Price-writer PostgreSQL unavailable");
  owner = new Pool({ connectionString: container.connectionString }); pools.push(owner);
  await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT NOBYPASSRLS");
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === inputsPath) break;
    await owner.query(readFileSync(unit.file, "utf8"));
  }
  genuine = await genuinePurchase(owner);
  await owner.query(readFileSync(inputsPath, "utf8"));
  await owner.query(readFileSync(writerPath, "utf8"));
  await owner.query(readFileSync("db/platform/migrations/20261123190000_catalog_publication.sql", "utf8"));
  await owner.query(readFileSync(commandsPath, "utf8"));
  await owner.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
  await owner.query("UPDATE public.price_entries SET mode='one_time',unit_price_minor=1000 WHERE variant_id=$1", [genuine.sku]);
  await owner.query(`INSERT INTO public.subscription_price_policy_revisions(id,revision_no,price_list_id,region_code,currency,channel,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest)
    SELECT id,1,$1,'ZZ','XXX','D2C',at,1000,10,'FLOOR_TO_QUANTUM',
      public.catalog_price_setup_policy_digest(id,1,$1,'ZZ','XXX','D2C',at,NULL,1000,10,'FLOOR_TO_QUANTUM')
    FROM (SELECT gen_random_uuid() AS id,date_trunc('milliseconds',statement_timestamp()-interval '1 hour') AS at) v`, [genuine.list]);
  await rpc(owner, "commerce_capture_offer_policy_v2_legacy_baseline");
  promotion.valid_from = (await owner.query("SELECT to_char((statement_timestamp()-interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at")).rows[0].at;
  for (const d of [promotion, { ...promotion, id: "example:bundle", promotion_engine_version: "promotion-engine.v1", discount_value: 5,
    applies_to_payload: { cart_mode: "one_time" }, stacking_rule: "stackable_with_any", eligibility: { min_cart_minor: 12000 },
    benefit_kind: "percentage", benefit_value_bps: 500, redemption_limit_per_customer: null }]) {
    const definition = JSON.stringify(d);
    await owner.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition_fingerprint,definition,active) VALUES($1,$2,$3,true)",
      [d.id, createHash("sha256").update(definition).digest("hex"), definition]);
  }
  for (const id of [actor, otherActor]) {
    await owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [id, `${id}@example.invalid`]);
    await owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',statement_timestamp())", [id]);
  }
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);

it("native_readiness_reads_actual_inputs_without_commerce_locks", async () => transaction(async db => {
  const snapshot = await priceSnapshot(db);
  const readiness = await rpc(db, "commerce_offer_policy_v2_readiness");
  expect(readiness).toMatchObject({ contractVersion: "commerce-offer-policy-v2-readiness.v1",
    evidence: { legacyFrozenCount: 1, legacyFrozenInvalidCount: 0, legacyFrozenBaselineMatches: true, priceMismatchCount: 0, bundlePolicyCount: 1 } });
  expect(readiness.reasons).toEqual(["promotion_watchdog_not_ready", "promotion_claim_sweep_not_ready"]);
  expect((await db.query("SELECT locktype FROM pg_locks WHERE pid=pg_backend_pid() AND locktype IN ('advisory','tuple')")).rows).toEqual([]);
  expect(await priceSnapshot(db)).toEqual(snapshot);
}));

async function unchangedRefusal(db: PoolClient, value: unknown, expected: Record<string, unknown>) {
  const before = await priceSnapshot(db);
  await db.query("SAVEPOINT refusal");
  await expect(apply(db, value)).rejects.toMatchObject(expected);
  await db.query("ROLLBACK TO SAVEPOINT refusal");
  expect(await priceSnapshot(db)).toEqual(before);
}
it("preview_restores_rows_and_readiness_sees_the_provisional_write", async () => transaction(async db => {
  const before = await priceSnapshot(db);
  const preview = await rpc(db, "catalog_price_setup_preview", [genuine.sku, genuine.list, 5]);
  expect(preview.subscription).toMatchObject({ kind: "derived", derivedUnitPriceMinor: 900 });
  expect(preview.readiness.reasons).not.toContain("catalog_1490_legacy_1340_invalid");
  expect(preview.proposed.readiness.reasons).toContain("catalog_1490_legacy_1340_invalid");
  expect(await priceSnapshot(db)).toEqual(before);
  await unchangedRefusal(db, await command(db, { unitPriceMinor: 5 }), { code: "55000", message: "catalog_price_setup_readiness_would_fail" });
}));
it("price_schedule_switches_at_half_open_boundary", async () => transaction(async db => {
  const result = await apply(db, await command(db));
  expect(result.outcome).toBe("committed");
  const boundary = (await db.query(`SELECT old.valid_to=new.valid_from AS exact,
    old.valid_from<=new.valid_from AND old.valid_to>new.valid_from AS old_at,
    new.valid_from<=new.valid_from AND (new.valid_to IS NULL OR new.valid_to>new.valid_from) AS new_at,
    old.valid_from<=new.valid_from-interval '1 microsecond' AND old.valid_to>new.valid_from-interval '1 microsecond' AS old_before,
    new.valid_from<=new.valid_from-interval '1 microsecond' AS new_before
    FROM public.price_entries old,public.price_entries new WHERE old.id=$1 AND new.id=$2`,
    [result.receipt.previous.entryId, result.receipt.current.entryId])).rows[0];
  expect(boundary).toEqual({ exact: true, old_at: false, new_at: true, old_before: true, new_before: false });
}));
it("price_replace_refuses_pending_schedule", async () => transaction(async db => {
  await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'one_time',1500,statement_timestamp()+interval '1 hour')", [genuine.list, genuine.sku]);
  await unchangedRefusal(db, await command(db), { code: "40001", message: "catalog_price_setup_expected_state_mismatch" });
}));
it("stale_expected_base_rolls_back_prices_and_the_provisional_receipt", async () => transaction(async db => {
  await unchangedRefusal(db, await command(db, { expected: { entryId: randomUUID(), unitPriceMinor: 999 } }), { code: "40001" });
}));
it.each([
  ["tier", { minQty: 2 }], ["any", { mode: "any" }], ["net", { amountKind: "net" }],
  ["zero", { unitPriceMinor: 0 }], ["subscription", { mode: "subscription" }],
  ["overflow", { unitPriceMinor: 2147483648 }], ["unknown extension", { expectedContextVersion: 1 }],
])("strict_price_plan_refuses_ignored_tier_%s", async (_name, delta) => transaction(async db => {
  const before = await priceSnapshot(db), bytes = JSON.stringify(await command(db, delta));
  expect(await rpc(db, "catalog_price_setup_apply", [bytes, createHash("sha256").update(bytes).digest("hex")]))
    .toEqual({ outcome: "validation_issue", reason: "command_invalid" });
  expect(await priceSnapshot(db)).toEqual(before);
}));
it.each([
  ["missing SKU", { variantId: randomUUID() }, "sku_not_found"],
  ["missing list", { priceListId: randomUUID() }, "price_list_not_found"],
])("target_refusal_%s_removes_only_its_provisional_receipt", async (_name, delta, reason) => transaction(async db => {
  const before = await priceSnapshot(db);
  expect(await apply(db, await command(db, delta))).toEqual({ outcome: "validation_issue", reason });
  expect(await priceSnapshot(db)).toEqual(before);
}));
it("receipt_identity_checks_precede_changed_targets", async () => transaction(async db => {
  const a = await command(db), result = await apply(db, a);
  const before = await priceSnapshot(db);
  expect(await apply(db, { ...a, unitPriceMinor: 1300 })).toEqual({ outcome: "conflict", reason: "command_key_reused" });
  expect(await priceSnapshot(db)).toEqual(before);
  await session(db, otherActor);
  expect(await apply(db, a)).toEqual({ outcome: "unauthorized", reason: "operator_mismatch" });
  expect(await priceSnapshot(db)).toEqual(before);
  await session(db);
  await db.query("UPDATE public.catalog_skus SET status='archived' WHERE id=$1", [genuine.sku]);
  const archived = await priceSnapshot(db);
  expect(await apply(db, a)).toEqual({ ...result, outcome: "replayed" });
  expect(await priceSnapshot(db)).toEqual(archived);
}));
it("A_to_B_reconnect_replay_A_returns_the_original_receipt", async () => {
  const first = await owner.connect();
  let a: Awaited<ReturnType<typeof command>>, result: Awaited<ReturnType<typeof apply>>;
  try {
    await first.query("BEGIN"); await session(first); a = await command(first); result = await apply(first, a);
    expect(result.outcome).toBe("committed"); await first.query("COMMIT");
  } finally { first.release(true); }
  const second = await owner.connect();
  try {
    await second.query("BEGIN"); await session(second);
    expect((await apply(second, await command(second, { unitPriceMinor: 1300 }))).outcome).toBe("committed");
    await second.query("COMMIT");
  } finally { second.release(true); }
  await transaction(async db => {
    const before = await priceSnapshot(db);
    expect(await apply(db, a!)).toEqual({ ...result!, outcome: "replayed" });
    expect((await current(db)).unit_price_minor).toBe(1300);
    expect(await priceSnapshot(db)).toEqual(before);
  });
});
it("price_schedule_refuses_concurrent_overlap", async () => {
  const first = await owner.connect(), second = await owner.connect();
  try {
    await first.query("BEGIN"); await second.query("BEGIN"); await session(first); await session(second);
    const a = await command(first), b = { ...a, commandKey: randomUUID(), unitPriceMinor: 1400 };
    expect((await apply(first, a)).outcome).toBe("committed");
    expect((await second.query("SELECT pg_try_advisory_xact_lock(hashtextextended('catalog-price-setup:'||$1::text||':'||$2::text,0)) AS acquired", [genuine.list, genuine.sku])).rows).toEqual([{ acquired: false }]);
    const competing = apply(second, b); const refused = expect(competing).rejects.toMatchObject({ code: "40001" });
    await first.query("COMMIT"); await refused;
    await second.query("ROLLBACK");
    expect((await owner.query("SELECT count(*)::integer AS n FROM public.catalog_price_setup_receipts WHERE idempotency_key=$1", [b.commandKey])).rows).toEqual([{ n: 0 }]);
  } finally { await first.query("ROLLBACK"); await second.query("ROLLBACK"); first.release(); second.release(); }
});
it("known_second_invalid_SKU_aggregation_defect_is_preserved", async () => transaction(async db => {
  const id = randomUUID();
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1::uuid,$2::uuid,($1::uuid)::text,'Synthetic invalid SKU')", [id, genuine.sku]);
  expect((await rpc(db, "commerce_offer_policy_v2_readiness")).reasons).toContain("catalog_1490_legacy_1340_invalid");
  expect((await apply(db, await command(db, { unitPriceMinor: 5 }))).outcome).toBe("committed");
  expect((await rpc(db, "commerce_offer_policy_v2_readiness")).evidence.priceMismatchCount).toBe(2);
}));
it("original_open_end_digest_still_verifies_after_a_policy_close", async () => transaction(async db => {
  await db.query("UPDATE public.subscription_price_policy_revisions SET effective_to=statement_timestamp()+interval '1 hour' WHERE price_list_id=$1", [genuine.list]);
  expect((await rpc(db, "commerce_offer_policy_v2_readiness")).evidence.subscriptionPricePolicyDerivesBand).toBe(true);
}));
it.each([
  ["settlement_context_unverified", "DELETE FROM public.commerce_settings WHERE key='settlement_region'"],
  ["native_cohort_unverified", "DELETE FROM public.commerce_offer_policy_rollout_baselines"],
  ["native_agreement_domain_unverified", "UPDATE public.subscription_lines SET quantity=quantity+1"],
  ["native_promotion_domain_unverified", "UPDATE public.commerce_promotion_definitions SET definition=definition-'discount_value'"],
])("hard_input_%s_always_rolls_back_the_writer", async (reason, mutation) => transaction(async db => {
  await db.query(mutation);
  await unchangedRefusal(db, await command(db), { code: "55000", message: `catalog_price_setup_${reason}` });
}));
it.each([
  ["G019", { quoteSnapshot: { quote: { context: { pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v2" } } } } }, "native_order_policy_pair_unverified"],
  ["G031", {}, "native_order_admission_unverified"],
] as const)("%s_provisional_write_has_complete_ROLLBACK", async (_guard, metadata, reason) => transaction(async db => {
  const order = (await db.query("INSERT INTO public.commerce_orders(status,currency_code,total_amount_minor,metadata) VALUES('pending_payment','XXX',100,$1) RETURNING id", [metadata])).rows[0].id;
  await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)", [order]);
  // A test-only trigger exposes a previously excluded real order after the
  // provisional price insert. Neither readiness nor its inputs is stubbed.
  await db.query(`CREATE FUNCTION pg_temp.expose_price_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    UPDATE public.commerce_orders SET status='paid' WHERE id='${order}'::uuid; RETURN NEW; END $$`);
  await db.query("CREATE TRIGGER expose_price_order AFTER INSERT ON public.price_entries FOR EACH ROW EXECUTE FUNCTION pg_temp.expose_price_order()");
  await unchangedRefusal(db, await command(db), { code: "55000", message: `catalog_price_setup_${reason}` });
}));
it("authenticated_execute_keeps_tables_and_internal_readiness_private", async () => transaction(async db => {
  await db.query("SET LOCAL ROLE authenticated");
  expect((await apply(db, await ownerCommand())).outcome).toBe("committed");
  for (const sql of ["SELECT * FROM public.catalog_price_setup_receipts", "SELECT public.commerce_offer_policy_v2_readiness()", "SELECT public.catalog_price_setup_require_human_admin()"] ) {
    await db.query("SAVEPOINT denied"); await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" }); await db.query("ROLLBACK TO SAVEPOINT denied");
  }
}));
async function ownerCommand() { return command(owner); }
it.each(["no session", "distributor", "machine", "revoked"])("authority_%s_precedes_bytes_and_targets", async kind => transaction(async db => {
  const id = kind === "no session" ? null : otherActor;
  if (kind === "distributor") await db.query("UPDATE public.platform_human_memberships SET role='distributor' WHERE principal_id=$1", [otherActor]);
  if (kind === "machine") await db.query("INSERT INTO public.platform_control_operators(principal_id,active) VALUES($1,true)", [otherActor]);
  if (kind === "revoked") await db.query("SELECT public.platform_revoke_human_membership($2::uuid,$1::uuid,'Synthetic revocation')", [otherActor, actor]);
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [id ? JSON.stringify({ sub: id }) : "{}"]);
  const before = await priceSnapshot(db);
  await db.query("SAVEPOINT denied");
  await expect(rpc(db, "catalog_price_setup_apply", ["{}", "0".repeat(64)])).rejects.toMatchObject({ code: "42501" });
  await db.query("ROLLBACK TO SAVEPOINT denied"); expect(await priceSnapshot(db)).toEqual(before);
}));
it("catalog_price_change_preserves_active_agreements", async () => {
  const before = await journeyCensus(owner);
  const editBefore = await createPostgresPackageEditReadPort(owner).readLines(genuine.subscriptionId);
  const renewal = createPostgresRenewalStore(owner, createNativeRenewalCodec(), work => transaction(work));
  const renewalBefore = await renewal.buildCycleSnapshots({ subscriptionId: genuine.subscriptionId, scheduledAt: genuine.next, scheduledInstant: Date.parse(genuine.next) });
  const db = await owner.connect();
  try {
    await db.query("BEGIN"); await session(db);
    expect((await apply(db, await command(db, { unitPriceMinor: 1700 }))).outcome).toBe("committed");
    await db.query("COMMIT");
  } finally { db.release(); }
  const after = await journeyCensus(owner);
  for (const table of Object.keys(before)) if (!["price_entries", "catalog_price_setup_receipts"].includes(table)) expect(after[table], table).toEqual(before[table]);
  expect((await current(owner)).unit_price_minor).toBe(1700);
  expect(await createPostgresPackageEditReadPort(owner).readLines(genuine.subscriptionId)).toEqual(editBefore);
  expect(await renewal.buildCycleSnapshots({ subscriptionId: genuine.subscriptionId, scheduledAt: genuine.next, scheduledInstant: Date.parse(genuine.next) })).toEqual(renewalBefore);
  expect(renewalBefore.pricingSnapshot).toMatchObject({ currency: "XXX", totalAmountMinor: 274 });
  // Exercise the actual resume routine after setting up a due pause window.
  await transaction(async connection => {
    await connection.query("UPDATE public.subscriptions SET status='paused' WHERE id=$1", [genuine.subscriptionId]);
    await connection.query("INSERT INTO public.subscription_pause_windows(subscription_id,pause_preset,idempotency_key,starts_at,ends_at) VALUES($1,'2_weeks','synthetic:resume',statement_timestamp()-interval '2 days',statement_timestamp()-interval '1 day')", [genuine.subscriptionId]);
    expect(await rpc(connection, "subscription_auto_resume_due", [100])).toMatchObject({ ok: true, resumed: 1 });
    expect(await createPostgresPackageEditReadPort(connection).readLines(genuine.subscriptionId)).toEqual(editBefore);
    expect((await connection.query("SELECT next_cycle_at=$2::timestamptz+interval '1 day' AS expected_clock FROM public.subscriptions WHERE id=$1", [genuine.subscriptionId, genuine.next])).rows).toEqual([{ expected_clock: true }]);
    const saved = (await connection.query("SELECT unit_price_minor,quantity,currency_code FROM public.subscription_lines WHERE subscription_id=$1", [genuine.subscriptionId])).rows;
    expect(saved).toEqual([{ unit_price_minor: "137", quantity: 2, currency_code: "XXX" }]);
  });
});

it.each([
  ["zero base", "UPDATE public.price_entries SET unit_price_minor=0 WHERE mode='one_time'"],
  ["net base", "UPDATE public.price_entries SET amount_kind='net' WHERE mode='one_time'"],
  ["tier", "UPDATE public.price_entries SET min_qty=2 WHERE mode='one_time'"],
  ["any override", "INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) SELECT price_list_id,variant_id,'any',100,statement_timestamp()-interval '1 minute' FROM public.price_entries WHERE active AND mode='one_time'"],
  ["stored override after policy history", "INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) SELECT price_list_id,variant_id,'subscription',100,statement_timestamp()-interval '1 minute' FROM public.price_entries WHERE active AND mode='one_time'"],
  ["missing base", "UPDATE public.price_entries SET active=false WHERE mode='one_time'"],
] as const)("native_readiness_price_shape_%s", async (_name, mutate) => transaction(async db => {
  await db.query(mutate);
  const before = await priceSnapshot(db), readiness = await rpc(db, "commerce_offer_policy_v2_readiness");
  expect(readiness.reasons).toContain("catalog_1490_legacy_1340_invalid");
  expect(readiness.evidence.priceMismatchCount).toBe(1);
  expect(await priceSnapshot(db)).toEqual(before);
}));
it("new_native_routines_have_no_ambient_service_or_anonymous_execution", async () => {
  const rights = await owner.query(`SELECT role_name,has_function_privilege(role_name,'public.catalog_price_setup_apply(text,text)','EXECUTE') AS apply,
    has_function_privilege(role_name,'public.catalog_price_setup_preview(uuid,uuid,integer)','EXECUTE') AS preview
    FROM unnest(ARRAY['anon','service_role']) role_name ORDER BY role_name`);
  expect(rights.rows).toEqual([{ role_name: "anon", apply: false, preview: false }, { role_name: "service_role", apply: false, preview: false }]);
});
it.each([
  ["G019", { quoteSnapshot: { quote: { context: { pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v2" } } } } }, "native_order_policy_pair_unverified"],
  ["G031", {}, "native_order_admission_unverified"],
] as const)("%s_before_write_has_complete_ROLLBACK", async (_guard, metadata, reason) => transaction(async db => {
  const order = (await db.query("INSERT INTO public.commerce_orders(status,currency_code,total_amount_minor,metadata) VALUES('paid','XXX',100,$1) RETURNING id", [metadata])).rows[0].id;
  await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)", [order]);
  await unchangedRefusal(db, await command(db), { code: "55000", message: `catalog_price_setup_${reason}` });
}));

// Keep one database statement clock across fixture writes and the observed read.
// These are real native control rows; no readiness/input function is replaced.
const successfulControls = `INSERT INTO public.platform_job_controls(job_name,active_driver,enabled,last_status,last_success_at,metadata)
 VALUES('platform-watchdog','worker',true,'success',statement_timestamp(),'{"promotionReady":true}'),
 ('promotion-claim-sweep','worker',true,'success',statement_timestamp(),'{}')
 ON CONFLICT(job_name) DO UPDATE SET enabled=excluded.enabled,last_status=excluded.last_status,
 last_success_at=excluded.last_success_at,metadata=excluded.metadata;`;
const sqlJson = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
async function census(db: PoolClient, setup: string, evidence: Record<string, unknown>, reasons: string[] = []) {
  await db.query(`DO $proof$ DECLARE observed jsonb; BEGIN ${successfulControls} ${setup}
    observed:=public.commerce_offer_policy_v2_readiness();
    IF observed->>'contractVersion' IS DISTINCT FROM 'commerce-offer-policy-v2-readiness.v1' OR observed->'checkedAt' IS DISTINCT FROM to_jsonb(statement_timestamp()) OR observed->'ready' IS DISTINCT FROM to_jsonb(${reasons.length === 0}) OR NOT (observed->'evidence' @> ${sqlJson(evidence)}) OR observed->'reasons' IS DISTINCT FROM ${sqlJson(reasons)} THEN
      RAISE EXCEPTION 'native_readiness_census_mismatch' USING DETAIL=observed::text;
    END IF; END $proof$;`);
}

it.each(["platform-watchdog", "promotion-claim-sweep"] as const)("readiness_heartbeat_%s_success", async name => transaction(async db => {
  await census(db, "", { promotionWatchdogReady: true, promotionClaimSweepReady: true });
  expect((await db.query("SELECT last_status FROM public.platform_job_controls WHERE job_name=$1", [name])).rows[0].last_status).toBe("success");
}));
for (const [job, flag, reason, limit] of [
  ["platform-watchdog", "promotionWatchdogReady", "promotion_watchdog_not_ready", "6 hours"],
  ["promotion-claim-sweep", "promotionClaimSweepReady", "promotion_claim_sweep_not_ready", "15 minutes"],
] as const) {
  it.each([
    ["now", "statement_timestamp()", true],
    ["upper_inside", "statement_timestamp()-interval '1 microsecond'", true],
    ["future", "statement_timestamp()+interval '1 microsecond'", false],
    ["freshness_exact", `statement_timestamp()-interval '${limit}'`, true],
    ["freshness_inside", `statement_timestamp()-interval '${limit}'+interval '1 microsecond'`, true],
    ["freshness_outside", `statement_timestamp()-interval '${limit}'-interval '1 microsecond'`, false],
    ["missing_success_time", "NULL", false],
  ] as const)(`readiness_heartbeat_${job}_%s`, async (_name, instant, ready) => transaction(async db => {
    await census(db, `UPDATE public.platform_job_controls SET last_success_at=${instant} WHERE job_name='${job}';`,
      { [flag]: ready }, ready ? [] : [reason]);
  }));
  it.each([
    ["missing", `DELETE FROM public.platform_job_controls WHERE job_name='${job}';`],
    ["disabled", `UPDATE public.platform_job_controls SET enabled=false WHERE job_name='${job}';`],
    ...["failed", "running", "skipped"].map(status => [status, `UPDATE public.platform_job_controls SET last_status='${status}' WHERE job_name='${job}';`]),
    ["null_status", `UPDATE public.platform_job_controls SET last_status=NULL WHERE job_name='${job}';`],
  ])(`readiness_heartbeat_${job}_%s`, async (_name, setup) => transaction(async db => {
    await census(db, setup, { [flag]: false }, [reason]);
  }));
}
it.each(["{}", '{"promotionReady":false}', '{"promotionReady":null}', '{"promotionReady":"yes"}', "null"])(
  "readiness_watchdog_promotion_evidence_%s", async metadata => transaction(async db => {
    await census(db, `UPDATE public.platform_job_controls SET metadata=${sqlJson(JSON.parse(metadata))} WHERE job_name='platform-watchdog';`,
      { promotionWatchdogReady: false }, ["promotion_watchdog_not_ready"]);
  }));
it("readiness_sweep_does_not_require_watchdog_promotion_metadata", async () => transaction(async db => {
  await census(db, `UPDATE public.platform_job_controls SET metadata='{"promotionReady":false}' WHERE job_name='promotion-claim-sweep';`,
    { promotionWatchdogReady: true, promotionClaimSweepReady: true });
}));

const legacyPair = `INSERT INTO public.commerce_promotion_definitions(promotion_id,definition_fingerprint,definition,active)
 SELECT 'example:legacy',repeat('a',64),definition||jsonb_build_object('id','example:legacy','promotion_engine_version','promotion-engine.v1',
 'discount_value',44.404,'benefit_kind','percentage','benefit_value_bps',NULL,'applies_to_payload',
 jsonb_set(applies_to_payload,'{acquisitionTerms,revision}','"legacy-50-35"')) ,true
 FROM public.catalog_price_setup_promotions() p JOIN public.commerce_promotion_definitions d ON d.promotion_id=p.id WHERE p.id='example:acquisition';`;
const pairedAcquisition = legacyPair + `
 INSERT INTO public.commerce_promotion_definitions(promotion_id,definition_fingerprint,definition,active)
 SELECT 'example:mirror',repeat('b',64),definition||jsonb_build_object('id','example:mirror','v2_mirror_of','example:legacy',
 'applies_to_payload',jsonb_set(applies_to_payload,'{acquisitionTerms,revision}','"legacy-50-35"')),true
 FROM public.catalog_price_setup_promotions() p JOIN public.commerce_promotion_definitions d ON d.promotion_id=p.id WHERE p.id='example:acquisition';
 UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id='example:acquisition';`;
it("readiness_census_canonical_legacy_pair", async () => transaction(async db => {
  await census(db, pairedAcquisition, { firstSubscriptionLegacyCount: 1, firstSubscriptionPairCount: 1, firstSubscriptionActiveCount: 1,
    bundlePolicyCount: 1, activePriceListCount: 1, activeCoreSkuCount: 1, priceMismatchCount: 0, subscriptionPricePolicyCount: 1,
    subscriptionPricePolicyDerivesBand: true, legacyFrozenCount: 1, legacyFrozenInvalidCount: 0, legacyFrozenBaselineMatches: true,
    automaticV2MoneyCheckedCount: 0, automaticV2MoneyMismatchCount: 0 });
}));
it.each([
  ["payload", { applies_to_payload: { cart_mode: "subscription", acquisitionTerms: { schemaVersion: "subscription-acquisition.v1", revision: "legacy-50-35", delivery2DiscountBps: 3501 } } }],
  ["stacking", { stacking_rule: "stackable_with_any" }], ["eligibility", { eligibility: { first_subscription_purchase: false } }],
  ["global_limit", { redemption_limit_global: 1 }], ["customer_limit", { redemption_limit_per_customer: 2 }],
  ["regions", { region_availability: ["ZZ", "YY"] }],
] as const)("readiness_census_mirror_shared_%s", async (_name, delta) => transaction(async db => {
  await census(db, pairedAcquisition + `UPDATE public.commerce_promotion_definitions SET definition=definition||${sqlJson(delta)} WHERE promotion_id='example:mirror';`,
    { firstSubscriptionLegacyCount: 1, firstSubscriptionPairCount: 1, firstSubscriptionActiveCount: 0 }, ["first_subscription_mirror_not_ready"]);
}));
it.each([
  ["inactive", "UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id='example:mirror';"],
  ["start", "UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{valid_from}',to_jsonb((definition->>'valid_from')::timestamptz-interval '1 microsecond')) WHERE promotion_id='example:mirror';"],
  ["end", "UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{valid_to}',to_jsonb(statement_timestamp()+interval '1 hour')) WHERE promotion_id='example:mirror';"],
])("readiness_census_mirror_%s", async (_name, setup) => transaction(async db => {
  await census(db, pairedAcquisition + setup, { firstSubscriptionLegacyCount: 1, firstSubscriptionPairCount: 1, firstSubscriptionActiveCount: 0 },
    ["first_subscription_mirror_not_ready"]);
}));
it.each([
  ["not_effective", "UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id='example:acquisition';"],
  ["invalid", `UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,cart_mode}','"one_time"') WHERE promotion_id='example:acquisition';`],
  ["ambiguous", `INSERT INTO public.commerce_promotion_definitions(promotion_id,definition_fingerprint,definition,active)
    SELECT 'example:overlap',repeat('c',64),definition||'{"id":"example:overlap"}',true FROM public.commerce_promotion_definitions WHERE promotion_id='example:acquisition';`],
])("readiness_census_acquisition_%s", async (_name, setup) => transaction(async db => {
  await census(db, setup, { firstSubscriptionLegacyCount: 0, firstSubscriptionPairCount: 0, firstSubscriptionActiveCount: 0, acquisition: null },
    ["first_subscription_pair_invalid"]);
}));
it("readiness_census_acquisition_public_envelope_and_native_fingerprints", async () => transaction(async db => {
  const agreements = await rpc(db, "catalog_price_setup_agreement_evidence");
  const r = await rpc(db, "commerce_offer_policy_v2_readiness");
  expect(r.evidence.legacyFrozenFingerprint).toBe(agreements.fingerprint);
  expect(r.evidence.acquisition).toMatchObject({ contractVersion: "commerce-acquisition-readiness.v1", initialDiscountBps: 5000,
    delivery2DiscountBps: 3500, kind: "v2_standalone", standaloneCount: 1, legacyPairCount: 0 });
  expect(r.evidence.acquisition).not.toHaveProperty("schemaVersion");
  expect(r.evidence.acquisition).not.toHaveProperty("sourcePromotionId");
}));
it.each([
  ["engine", { promotion_engine_version: "promotion-engine.v2" }], ["trigger", { trigger_type: "referral" }],
  ["code", { trigger_type: "coupon_code", code: "EXAMPLE" }], ["discount_type", { discount_type: "fixed_amount" }],
  ["discount_value", { discount_value: 4 }], ["scope", { applies_to_kind: "line_with_variant" }],
  ["payload", { applies_to_payload: { cart_mode: "subscription" } }], ["stacking", { stacking_rule: "exclusive" }],
  ["eligibility", { eligibility: { min_cart_minor: 13000 } }], ["status", { status: "paused" }],
  ["lane", { benefit_lane: "shipping" }], ["kind", { benefit_kind: "target_percentage" }],
  ["basis_points", { benefit_value_bps: 600 }], ["global_limit", { redemption_limit_global: 1 }],
  ["customer_limit", { redemption_limit_per_customer: 1 }], ["region", { region_availability: ["YY"] }],
] as const)("readiness_census_bundle_%s", async (_name, delta) => transaction(async db => {
  await census(db, `UPDATE public.commerce_promotion_definitions SET definition=definition||${sqlJson(delta)} WHERE promotion_id='example:bundle';`,
    { bundlePolicyCount: 0 }, ["bundle_5_policy_invalid"]);
}));
it("readiness_census_bundle_duplicate", async () => transaction(async db => {
  await census(db, `INSERT INTO public.commerce_promotion_definitions(promotion_id,definition_fingerprint,definition,active)
    SELECT 'example:bundle-copy',repeat('d',64),definition||'{"id":"example:bundle-copy"}',true FROM public.commerce_promotion_definitions WHERE promotion_id='example:bundle';`,
  { bundlePolicyCount: 2 }, ["bundle_5_policy_invalid"]);
}));
it.each([
  ["start_exact", "valid_from", "statement_timestamp()", 1],
  ["start_inside", "valid_from", "statement_timestamp()-interval '1 microsecond'", 1],
  ["start_future", "valid_from", "statement_timestamp()+interval '1 microsecond'", 0],
  ["end_exact", "valid_to", "statement_timestamp()", 1],
  ["end_inside", "valid_to", "statement_timestamp()+interval '1 microsecond'", 1],
  ["end_outside", "valid_to", "statement_timestamp()-interval '1 microsecond'", 0],
] as const)("readiness_census_bundle_%s", async (_name, key, instant, count) => transaction(async db => {
  await census(db, `UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{${key}}',to_jsonb(${instant})) WHERE promotion_id='example:bundle';`,
    { bundlePolicyCount: count }, count ? [] : ["bundle_5_policy_invalid"]);
}));

// Components below execute verbatim blocks from the production routine. They do
// not replace a native function or claim that guarded order contexts are admitted.
// Separate entry-point witnesses prove those contexts still hard-refuse.
const nativeReadinessSource = readFileSync(writerPath, "utf8").split("CREATE FUNCTION public.commerce_offer_policy_v2_readiness()")[1].split("$_$;")[0];
const nativeDeclarations = nativeReadinessSource.slice(nativeReadinessSource.indexOf("DECLARE"), nativeReadinessSource.indexOf("\nBEGIN"));
function readinessBlock(start: string, end: string) {
  const from = nativeReadinessSource.indexOf(start), to = nativeReadinessSource.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error("Native readiness block markers changed");
  return nativeReadinessSource.slice(from, to);
}
async function censusComponent(db: PoolClient, setup: string, block: string, observed: string, expected: unknown) {
  await db.query(`DO $proof$ ${nativeDeclarations} BEGIN ${setup} ${block}
    IF ${observed} IS DISTINCT FROM ${sqlJson(expected)} THEN
      RAISE EXCEPTION 'native_readiness_component_mismatch' USING DETAIL=(${observed})::text;
    END IF; END $proof$;`);
}
const moneyBlock = readinessBlock("  WITH automatic_v2_orders AS (", "  IF v_automatic_v2_money_mismatch_count <> 0 THEN");
const moneyObserved = "jsonb_build_object('checked',v_automatic_v2_money_checked_count,'mismatched',v_automatic_v2_money_mismatch_count)";
const automaticOrder = `UPDATE public.commerce_orders SET created_at=statement_timestamp(),status='paid',
 metadata=jsonb_set(metadata,'{quoteSnapshot,quote,context,pricingPolicy}',
 '{"offerPolicyVersion":"commerce.offer-policy.v2","promotionEngineVersion":"promotion-engine.v2"}')
 WHERE id=(SELECT order_id FROM public.subscription_activations LIMIT 1);`;
it("readiness_component_automatic_money_valid_native_order", async () => transaction(async db => {
  await censusComponent(db, automaticOrder, moneyBlock, moneyObserved, { checked: 1, mismatched: 0 });
}));
it("readiness_automatic_money_entry_guard_remains_fail_closed", async () => transaction(async db => {
  await expect(census(db, automaticOrder, {})).rejects.toMatchObject({ code: "55000", message: "catalog_price_setup_native_order_guard_unverified" });
}));
it.each([
  ["at_24h", "statement_timestamp()-interval '24 hours'", 1],
  ["inside_24h", "statement_timestamp()-interval '24 hours'+interval '1 microsecond'", 1],
  ["outside_24h", "statement_timestamp()-interval '24 hours'-interval '1 microsecond'", 0],
  ["at_now", "statement_timestamp()", 1], ["future", "statement_timestamp()+interval '1 microsecond'", 0],
] as const)("readiness_component_automatic_money_%s", async (_name, instant, count) => transaction(async db => {
  await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET created_at=${instant};`, moneyBlock, moneyObserved,
    { checked: count, mismatched: 0 });
}));
it.each(["paid", "fulfillment_pending", "fulfilled", "refunded", "pending_payment", "cancelled", "expired"])(
  "readiness_component_automatic_money_status_%s", async status => transaction(async db => {
    await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET status='${status}';`, moneyBlock, moneyObserved,
      { checked: ["paid", "fulfillment_pending", "fulfilled", "refunded"].includes(status) ? 1 : 0, mismatched: 0 });
  }));
it.each(["subtotalGross", "discountTotalGross", "shippingGross", "shippingDiscountGross", "totalGross"])(
  "readiness_component_automatic_money_amount_%s", async field => transaction(async db => {
    await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,${field},amountMinor}','999');`,
      moneyBlock, moneyObserved, { checked: 1, mismatched: 1 });
  }));
it.each(["subtotalGross", "discountTotalGross", "shippingGross", "shippingDiscountGross", "totalGross"])(
  "readiness_component_automatic_money_currency_%s", async field => transaction(async db => {
    await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,${field},currency}','"YYY"');`,
      moneyBlock, moneyObserved, { checked: 1, mismatched: 1 });
  }));
for (const field of ["subtotalGross", "discountTotalGross", "shippingGross", "shippingDiscountGross", "totalGross"]) {
  it.each([null, "invalid", -1, "12345678901234567"])(`readiness_component_automatic_money_scalar_${field}_%s`, async amount => transaction(async db => {
    const optionalNull = amount === null && ["shippingGross", "shippingDiscountGross"].includes(field);
    await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,${field},amountMinor}',${sqlJson(amount)});`,
      moneyBlock, moneyObserved, { checked: 1, mismatched: optionalNull ? 0 : 1 });
  }));
}
it.each(["shippingGross", "shippingDiscountGross"])("readiness_component_automatic_money_optional_%s", async field => transaction(async db => {
  await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET metadata=metadata#-'{quoteSnapshot,quote,${field}}';`,
    moneyBlock, moneyObserved, { checked: 1, mismatched: 0 });
}));
it("readiness_component_automatic_money_order_currency", async () => transaction(async db => {
  await censusComponent(db, automaticOrder + "UPDATE public.commerce_orders SET currency_code='YYY';", moneyBlock, moneyObserved, { checked: 1, mismatched: 1 });
}));
it("readiness_component_automatic_money_engine_scope", async () => transaction(async db => {
  await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,context,pricingPolicy}',
    '{"offerPolicyVersion":"commerce.offer-policy.v1","promotionEngineVersion":"promotion-engine.v1"}');`, moneyBlock, moneyObserved, { checked: 0, mismatched: 0 });
}));
it("readiness_component_automatic_money_malformed_quote_is_excluded", async () => transaction(async db => {
  await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote}','[]');`, moneyBlock, moneyObserved, { checked: 0, mismatched: 0 });
}));

const freshBaseContext = `UPDATE public.price_lists SET status='archived';
 INSERT INTO public.price_lists(name,region_code,currency,valid_from) VALUES('Synthetic census','ZZ','XXX',statement_timestamp()-interval '1 hour');
 INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
 SELECT p.id,s.id,'one_time',1000,statement_timestamp()-interval '1 hour' FROM public.price_lists p CROSS JOIN public.catalog_skus s
 WHERE p.status='active' AND s.sku='READINESS-AGREED';`;
const storedEntry = `INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
 SELECT p.id,s.id,'subscription',900,statement_timestamp()-interval '1 hour' FROM public.price_lists p CROSS JOIN public.catalog_skus s
 WHERE p.status='active' AND s.sku='READINESS-AGREED';`;
function policyEntry(from = "statement_timestamp()-interval '1 hour'", until = "NULL::timestamptz", channel = "D2C", discount = 1000, quantum = 10) {
  return `INSERT INTO public.subscription_price_policy_revisions(id,revision_no,price_list_id,region_code,currency,channel,effective_from,effective_to,discount_bps,rounding_quantum_minor,rounding_rule,digest)
 SELECT v.id,1,p.id,p.region_code,p.currency,'${channel}',v.first,v.last,${discount},${quantum},'FLOOR_TO_QUANTUM',
 public.catalog_price_setup_policy_digest(v.id,1,p.id,p.region_code,p.currency,'${channel}',v.first,v.last,${discount},${quantum},'FLOOR_TO_QUANTUM')
 FROM public.price_lists p CROSS JOIN (SELECT gen_random_uuid() AS id,(${from}) AS first,(${until}) AS last) v WHERE p.status='active';`;
}
it("readiness_census_stored_lane_without_policy_history", async () => transaction(async db => {
  await census(db, freshBaseContext + storedEntry, { activePriceListCount: 1, priceMismatchCount: 0,
    subscriptionPricePolicyCount: 0, subscriptionPricePolicyDerivesBand: false });
}));
it("readiness_census_other_channel_history_does_not_select_derived_lane", async () => transaction(async db => {
  await census(db, freshBaseContext + storedEntry + policyEntry(undefined, undefined, "B2B"), { priceMismatchCount: 0,
    subscriptionPricePolicyCount: 0, subscriptionPricePolicyDerivesBand: false });
}));
it("readiness_census_future_history_never_falls_back_to_stored", async () => transaction(async db => {
  await census(db, freshBaseContext + storedEntry + policyEntry("statement_timestamp()+interval '1 hour'"),
    { priceMismatchCount: 1, subscriptionPricePolicyCount: 0 }, ["catalog_1490_legacy_1340_invalid"]);
}));
it.each([
  ["start_exact", "statement_timestamp()", "NULL::timestamptz", 1],
  ["start_inside", "statement_timestamp()-interval '1 microsecond'", "NULL::timestamptz", 1],
  ["start_future", "statement_timestamp()+interval '1 microsecond'", "NULL::timestamptz", 0],
  ["end_exact", "statement_timestamp()-interval '1 hour'", "statement_timestamp()", 0],
  ["end_inside", "statement_timestamp()-interval '1 hour'", "statement_timestamp()+interval '1 microsecond'", 1],
  ["end_outside", "statement_timestamp()-interval '1 hour'", "statement_timestamp()-interval '1 microsecond'", 0],
] as const)("readiness_census_policy_%s", async (_name, from, until, count) => transaction(async db => {
  await census(db, freshBaseContext + policyEntry(from, until), { subscriptionPricePolicyCount: count,
    priceMismatchCount: count ? 0 : 1, subscriptionPricePolicyDerivesBand: count === 1 }, count ? [] : ["catalog_1490_legacy_1340_invalid"]);
}));
it.each([
  ["none", "UPDATE public.price_lists SET status='draft';", 0, 0, 0],
  ["region", "UPDATE public.commerce_settings SET value_text='YY' WHERE key='settlement_region';", 0, 0, 0],
  ["duplicate", freshBaseContext.replace("UPDATE public.price_lists SET status='archived';", "") + storedEntry, 2, 1, 0],
] as const)("readiness_census_list_%s", async (_name, setup, lists, skus, mismatches) => transaction(async db => {
  const extraReason = _name === "region" ? ["first_subscription_pair_invalid", "bundle_5_policy_invalid"] : [];
  await census(db, setup, { activePriceListCount: lists, activeCoreSkuCount: skus, priceMismatchCount: mismatches },
    [...extraReason, "catalog_1490_legacy_1340_invalid"]);
}));
it.each([
  ["start_exact", "valid_from", "statement_timestamp()", 1],
  ["start_inside", "valid_from", "statement_timestamp()-interval '1 microsecond'", 1],
  ["start_future", "valid_from", "statement_timestamp()+interval '1 microsecond'", 0],
  ["end_exact", "valid_to", "statement_timestamp()", 0],
  ["end_inside", "valid_to", "statement_timestamp()+interval '1 microsecond'", 1],
  ["end_outside", "valid_to", "statement_timestamp()-interval '1 microsecond'", 0],
] as const)("readiness_census_list_%s", async (_name, column, instant, count) => transaction(async db => {
  await census(db, `UPDATE public.price_lists SET ${column}=${instant};`, { activePriceListCount: count, activeCoreSkuCount: count, subscriptionPricePolicyCount: count, subscriptionPricePolicyDerivesBand: count === 1 },
    count ? [] : ["catalog_1490_legacy_1340_invalid"]);
}));
it.each([
  ["draft", "status='draft'", 0], ["archived", "status='archived'", 0], ["addon", "is_addon=true", 0],
  ["neither_mode", "sellable_standalone=false,sellable_in_subscription=false", 0],
  ["standalone_only", "sellable_standalone=true,sellable_in_subscription=false", 1],
  ["subscription_only", "sellable_standalone=false,sellable_in_subscription=true", 1],
] as const)("readiness_census_sku_%s", async (_name, assignments, count) => transaction(async db => {
  await census(db, `UPDATE public.catalog_skus SET ${assignments};`, { activeCoreSkuCount: count, priceMismatchCount: 0 },
    count ? [] : ["catalog_1490_legacy_1340_invalid"]);
}));
it.each([
  ["start_exact", "valid_from", "statement_timestamp()", 0],
  ["start_inside", "valid_from", "statement_timestamp()-interval '1 microsecond'", 0],
  ["start_future", "valid_from", "statement_timestamp()+interval '1 microsecond'", 1],
  ["end_exact", "valid_to", "statement_timestamp()", 1],
  ["end_inside", "valid_to", "statement_timestamp()+interval '1 microsecond'", 0],
  ["end_outside", "valid_to", "statement_timestamp()-interval '1 microsecond'", 1],
] as const)("readiness_census_entry_%s", async (_name, column, instant, mismatches) => transaction(async db => {
  await census(db, `UPDATE public.price_entries SET ${column}=${instant} WHERE mode='one_time' AND active;`,
    { priceMismatchCount: mismatches, subscriptionPricePolicyDerivesBand: true }, mismatches ? ["catalog_1490_legacy_1340_invalid"] : []);
}));
it("readiness_census_entry_other_list_is_not_joined", async () => transaction(async db => {
  await census(db, `INSERT INTO public.price_lists(name,region_code,currency) VALUES('Synthetic foreign','YY','XXX');
    INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    SELECT p.id,s.id,'one_time',999,statement_timestamp()-interval '1 hour' FROM public.price_lists p CROSS JOIN public.catalog_skus s WHERE p.region_code='YY';`,
    { priceMismatchCount: 0, activePriceListCount: 1 });
}));
it("readiness_census_entry_other_variant_is_not_joined", async () => transaction(async db => {
  await census(db, `INSERT INTO public.catalog_skus(product_id,sku,title,status)
    SELECT product_id,'CENSUS-FOREIGN','Synthetic foreign','archived' FROM public.catalog_skus LIMIT 1;
    INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    SELECT p.id,s.id,'one_time',999,statement_timestamp()-interval '1 hour' FROM public.price_lists p CROSS JOIN public.catalog_skus s WHERE s.sku='CENSUS-FOREIGN';`,
    { priceMismatchCount: 0, activeCoreSkuCount: 1 });
}));
it.each([
  ["base_zero", "UPDATE public.price_entries SET unit_price_minor=0 WHERE mode='one_time' AND price_list_id IN (SELECT id FROM public.price_lists WHERE status='active');"],
  ["subscription_zero", "UPDATE public.price_entries SET unit_price_minor=0 WHERE mode='subscription' AND price_list_id IN (SELECT id FROM public.price_lists WHERE status='active');"],
  ["subscription_missing", "DELETE FROM public.price_entries WHERE mode='subscription' AND price_list_id IN (SELECT id FROM public.price_lists WHERE status='active');"],
  ["two_bases_one_valid", `INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    SELECT price_list_id,variant_id,'one_time',0,statement_timestamp()-interval '1 minute' FROM public.price_entries WHERE mode='one_time' AND price_list_id IN (SELECT id FROM public.price_lists WHERE status='active');`],
  ["two_subscription_one_valid", `INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    SELECT price_list_id,variant_id,'subscription',0,statement_timestamp()-interval '1 minute' FROM public.price_entries WHERE mode='subscription' AND price_list_id IN (SELECT id FROM public.price_lists WHERE status='active');`],
] as const)("readiness_census_stored_%s", async (_name, setup) => transaction(async db => {
  await census(db, freshBaseContext + storedEntry + setup, { priceMismatchCount: 1 }, ["catalog_1490_legacy_1340_invalid"]);
}));
it.each([["no_discount", 0, 10, 0], ["full_discount", 10000, 10, 1], ["unit_quantum", 1000, 1, 0], ["large_quantum", 1000, 1001, 1]] as const)(
  "readiness_census_derived_%s", async (_name, discount, quantum, mismatch) => transaction(async db => {
    await census(db, freshBaseContext + policyEntry(undefined, undefined, "D2C", discount, quantum),
      { priceMismatchCount: mismatch, subscriptionPricePolicyDerivesBand: mismatch === 0 }, mismatch ? ["catalog_1490_legacy_1340_invalid"] : []);
  }));
it("readiness_census_legacy_currency_is_checked_against_settlement", async () => transaction(async db => {
  await census(db, "UPDATE public.commerce_settings SET value_text='YYY' WHERE key='settlement_currency';",
    { activePriceListCount: 0, legacyFrozenInvalidCount: 1, legacyFrozenBaselineMatches: true },
    ["catalog_1490_legacy_1340_invalid", "legacy_frozen_records_invalid"]);
}));
it("readiness_census_explicit_fixture_is_excluded", async () => transaction(async db => {
  await census(db, `INSERT INTO public.subscriptions(client_id,cadence_days,price_list_id,currency_code,offer_policy_assignment_state,is_test_fixture)
    SELECT client_id,28,price_list_id,'YYY','legacy_frozen',true FROM public.subscriptions LIMIT 1;`, { legacyFrozenCount: 1, legacyFrozenInvalidCount: 0 });
}));
it("readiness_census_pending_subscription_is_excluded", async () => transaction(async db => {
  await census(db, `INSERT INTO public.subscriptions(client_id,cadence_days,price_list_id,currency_code)
    SELECT client_id,28,price_list_id,'YYY' FROM public.subscriptions LIMIT 1;`, { legacyFrozenCount: 1, legacyFrozenInvalidCount: 0 });
}));
const legacyDecisionBlock = readinessBlock("  SELECT count(*) INTO v_legacy_invalid_count", "  -- Audited never-populated zero");
it("readiness_component_legacy_policy_pair", async () => transaction(async db => {
  await censusComponent(db, `INSERT INTO public.subscriptions(client_id,cadence_days,price_list_id,currency_code,offer_policy_assignment_state,offer_policy_version,promotion_engine_version)
    SELECT client_id,28,price_list_id,currency_code,'legacy_frozen','commerce.offer-policy.v2','promotion-engine.v2' FROM public.subscriptions LIMIT 1;`,
    legacyDecisionBlock, "to_jsonb(v_legacy_invalid_count)", 1);
  await expect(rpc(db, "commerce_offer_policy_v2_readiness")).rejects.toMatchObject({ code: "55000", message: "catalog_price_setup_native_cohort_unverified" });
}));
it("readiness_component_legacy_zero_line_money", async () => transaction(async db => {
  await censusComponent(db, "UPDATE public.subscription_lines SET unit_price_minor=0;", legacyDecisionBlock, "to_jsonb(v_legacy_invalid_count)", 1);
  await expect(rpc(db, "commerce_offer_policy_v2_readiness")).rejects.toMatchObject({ code: "55000", message: "catalog_price_setup_native_agreement_domain_unverified" });
}));
const baselineBlock = readinessBlock("  -- Native governing retained", "  -- The scheduled watchdog");
it.each([
  ["missing", "DELETE FROM public.commerce_offer_policy_rollout_baselines;"],
  ["count", "UPDATE public.commerce_offer_policy_rollout_baselines SET expected_count=expected_count+1;"],
  ["fingerprint", "UPDATE public.commerce_offer_policy_rollout_baselines SET expected_fingerprint=md5('different cohort');"],
])("readiness_component_baseline_%s_refuses_reread_drift", async (_name, change) => transaction(async db => {
  await expect(censusComponent(db, `v_inputs:=public.catalog_price_setup_readiness_inputs(); ${change}`, baselineBlock,
    "to_jsonb(v_legacy_baseline_matches)", true)).rejects.toMatchObject({ code: "55000", message: "catalog_price_setup_native_cohort_unverified" });
}));
const acquisitionBlock = readinessBlock("  BEGIN\n    v_acquisition :=", "  SELECT count(*) INTO v_bundle_count");
it("readiness_component_acquisition_unknown_hard_failure_is_rethrown", async () => transaction(async db => {
  await expect(censusComponent(db, "UPDATE public.commerce_promotion_definitions SET definition=definition-'discount_value' WHERE promotion_id='example:acquisition';",
    acquisitionBlock, "to_jsonb(v_reasons)", [])).rejects.toMatchObject({ code: "55000", message: "catalog_price_setup_native_promotion_domain_unverified" });
}));

const canonicalBlock = readinessBlock("  WITH canonical_legacy AS (", "  BEGIN\n    v_acquisition :=");
const canonicalObserved = "jsonb_build_array(v_first_legacy_count,v_first_pair_count,v_first_active_count)";
// Invalid definitions stay native evidence. The public selector may refuse them
// earlier; this component isolates the census rather than weakening that guard.
it.each([
  ["engine", { promotion_engine_version: "promotion-engine.v2", benefit_value_bps: 4440 }],
  ["trigger", { trigger_type: "referral" }],
  ["code", { trigger_type: "coupon_code", code: "EXAMPLE", discount_value: 44, benefit_value_bps: 4400 }],
  ["discount_type", { discount_type: "fixed_amount" }], ["discount_value", { discount_value: 44 }],
  ["scope", { applies_to_kind: "line_with_variant" }], ["payload", { applies_to_payload: { cart_mode: "one_time" } }],
  ["stacking", { stacking_rule: "stackable_with_any" }], ["eligibility", { eligibility: { first_subscription_purchase: false } }],
  ["customer_limit", { redemption_limit_per_customer: 2 }], ["global_limit", { redemption_limit_global: 1 }],
  ["status", { status: "paused" }], ["region", { region_availability: ["YY"] }],
] as const)("readiness_component_legacy_filter_%s", async (_name, delta) => transaction(async db => {
  await censusComponent(db, pairedAcquisition + `UPDATE public.commerce_promotion_definitions SET definition=definition||${sqlJson(delta)} WHERE promotion_id='example:legacy';`,
    canonicalBlock, canonicalObserved, [0, 0, 0]);
}));
it.each([
  ["link", { v2_mirror_of: "example:absent" }], ["engine", { promotion_engine_version: "promotion-engine.v1" }],
  ["trigger", { trigger_type: "referral" }], ["code", { trigger_type: "coupon_code", code: "EXAMPLE" }],
  ["discount_type", { discount_type: "fixed_amount" }], ["discount_value", { discount_value: 49 }],
  ["scope", { applies_to_kind: "line_with_variant" }], ["lane", { benefit_lane: "shipping" }],
  ["kind", { benefit_kind: "percentage" }], ["basis_points", { benefit_value_bps: 4900 }], ["null_basis_points", { benefit_value_bps: null }],
  ["minor", { benefit_kind: "fixed_amount", benefit_value_bps: null, benefit_value_minor: 1 }],
] as const)("readiness_component_mirror_filter_%s", async (_name, delta) => transaction(async db => {
  await censusComponent(db, pairedAcquisition + `UPDATE public.commerce_promotion_definitions SET definition=definition||${sqlJson(delta)} WHERE promotion_id='example:mirror';`,
    canonicalBlock, canonicalObserved, [1, 0, 0]);
}));
it.each([
  ["start_exact", "valid_from", "statement_timestamp()", 1],
  ["start_inside", "valid_from", "statement_timestamp()-interval '1 microsecond'", 1],
  ["start_future", "valid_from", "statement_timestamp()+interval '1 microsecond'", 0],
  ["end_exact", "valid_to", "statement_timestamp()", 0],
  ["end_inside", "valid_to", "statement_timestamp()+interval '1 microsecond'", 1],
  ["end_outside", "valid_to", "statement_timestamp()-interval '1 microsecond'", 0],
] as const)("readiness_component_legacy_window_%s", async (_name, key, instant, count) => transaction(async db => {
  await censusComponent(db, pairedAcquisition + `UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{${key}}',to_jsonb(${instant})) WHERE promotion_id IN ('example:legacy','example:mirror');`,
    canonicalBlock, canonicalObserved, [count, count, count]);
}));
it("readiness_census_bundle_mirror_link_is_excluded", async () => transaction(async db => {
  await census(db, `UPDATE public.commerce_promotion_definitions SET definition=definition||'{"v2_mirror_of":"example:acquisition"}' WHERE promotion_id='example:bundle';`,
    { bundlePolicyCount: 0 }, ["bundle_5_policy_invalid"]);
}));
it("readiness_census_policy_digest_must_verify", async () => transaction(async db => {
  await censusComponent(db, freshBaseContext + policyEntry().replace("public.catalog_price_setup_policy_digest(v.id,1,p.id,p.region_code,p.currency,'D2C',v.first,v.last,1000,10,'FLOOR_TO_QUANTUM')", "repeat('a',64)"),
    readinessBlock("  SELECT count(*) INTO v_active_price_list_count", "  -- Native governing retained"),
    "jsonb_build_array(v_subscription_policy_count,v_subscription_policy_derives_band,v_price_mismatch_count)", [1, false, 1]);
  await expect(rpc(db, "commerce_offer_policy_v2_readiness")).rejects.toMatchObject({ code: "55000", message: "catalog_price_setup_native_policy_domain_unverified" });
}));
it.each([
  ["rounding_rule", policyEntry().replaceAll("FLOOR_TO_QUANTUM", "CEIL_TO_QUANTUM")],
  ["quantum_zero", policyEntry(undefined, undefined, "D2C", 1000, 0)],
  ["discount_negative", policyEntry(undefined, undefined, "D2C", -1)],
  ["discount_over_limit", policyEntry(undefined, undefined, "D2C", 10001)],
] as const)("readiness_policy_native_constraint_%s", async (_name, setup) => transaction(async db => {
  await db.query(freshBaseContext);
  await expect(db.query(setup)).rejects.toMatchObject({ code: "23514" });
}));
it.each(["subtotalGross", "discountTotalGross", "shippingGross", "shippingDiscountGross", "totalGross"])(
  "readiness_component_automatic_money_16_digits_%s", async field => transaction(async db => {
    await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,${field},amountMinor}',to_jsonb(lpad(metadata#>>'{quoteSnapshot,quote,${field},amountMinor}',16,'0')));`,
      moneyBlock, moneyObserved, { checked: 1, mismatched: 0 });
  }));
it.each([false, true])("readiness_component_automatic_money_reason_%s", async mismatch => transaction(async db => {
  const block = readinessBlock("  WITH automatic_v2_orders AS (", "  RETURN jsonb_build_object(");
  await censusComponent(db, automaticOrder + (mismatch ? `UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,totalGross,amountMinor}','999');` : ""),
    block, "to_jsonb(v_reasons)", mismatch ? ["automatic_v2_money_invalid"] : []);
}));

const policyReadBlock = readinessBlock("  SELECT count(*), COALESCE(bool_and(", "  -- The runtime price authority");
it.each([false, true])("readiness_component_policy_read_%s", async present => transaction(async db => {
  await censusComponent(db, freshBaseContext + (present ? policyEntry() : ""), policyReadBlock,
    "jsonb_build_array(v_subscription_policy_count,v_policy_well_formed,v_policy_discount_bps,v_policy_quantum)",
    present ? [1, true, 1000, 10] : [0, false, null, null]);
}));
const shapeReadBlock = readinessBlock("  WITH active_list AS (", "  ), derived_shape AS (") + `
  ) SELECT jsonb_build_array(base_entries,base_valid,subscription_entries,subscription_valid,overriding_or_drifted_entries)
  INTO v_inputs FROM price_shape;`;
it.each([
  ["net", "UPDATE public.price_entries SET amount_kind='net' WHERE mode='one_time' AND price_list_id IN (SELECT id FROM public.price_lists WHERE status='active');", [1, 0, 1, 1, 1]],
  ["tier", "UPDATE public.price_entries SET min_qty=2 WHERE mode='one_time' AND price_list_id IN (SELECT id FROM public.price_lists WHERE status='active');", [0, 0, 1, 1, 1]],
  ["any", `INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    SELECT price_list_id,variant_id,'any',100,statement_timestamp()-interval '1 minute' FROM public.price_entries WHERE mode='one_time' AND price_list_id IN (SELECT id FROM public.price_lists WHERE status='active');`, [1, 1, 1, 1, 1]],
] as const)("readiness_component_entry_override_%s", async (_name, setup, shape) => transaction(async db => {
  await censusComponent(db, freshBaseContext + storedEntry + setup, shapeReadBlock, "v_inputs", shape);
}));
it("readiness_missing_settlement_currency_fails_closed", async () => transaction(async db => {
  await db.query("DELETE FROM public.commerce_settings WHERE key='settlement_currency'");
  await expect(rpc(db, "commerce_offer_policy_v2_readiness")).rejects.toMatchObject({ code: "55000", message: "catalog_price_setup_settlement_context_unverified" });
}));

it.each(["created_at", "id"])("readiness_census_latest_list_selection_%s", async order => transaction(async db => {
  const newContext = freshBaseContext.replace("UPDATE public.price_lists SET status='archived';", "")
    .replace("INSERT INTO public.price_lists(name,region_code,currency,valid_from)", "INSERT INTO public.price_lists(id,name,region_code,currency,valid_from)")
    .replace("VALUES('Synthetic census'", "VALUES('ffffffff-ffff-ffff-ffff-ffffffffffff','Synthetic census'");
  await census(db, `UPDATE public.price_lists SET created_at=statement_timestamp()-interval '2 hours';` + newContext + storedEntry +
    (order === "id" ? "UPDATE public.price_lists SET created_at=statement_timestamp()-interval '2 hours';" : ""),
    { activePriceListCount: 2, subscriptionPricePolicyCount: 0, subscriptionPricePolicyDerivesBand: false, priceMismatchCount: 0 },
    ["catalog_1490_legacy_1340_invalid"]);
}));
it.each(["region_code", "currency"])("readiness_policy_native_context_FK_%s", async field => transaction(async db => {
  await db.query(freshBaseContext);
  const setup = policyEntry().replace(`p.region_code,p.currency,'D2C',v.first`,
    field === "region_code" ? "'YY',p.currency,'D2C',v.first" : "p.region_code,'YYY','D2C',v.first");
  await expect(db.query(setup)).rejects.toMatchObject({ code: "23503" });
}));

const historyReadBlock = readinessBlock("  SELECT count(*) INTO v_policy_history_count", "  WITH active_list AS (");
it.each([
  ["start_exact", "valid_from", "statement_timestamp()", 1],
  ["start_inside", "valid_from", "statement_timestamp()-interval '1 microsecond'", 1],
  ["start_future", "valid_from", "statement_timestamp()+interval '1 microsecond'", 0],
  ["end_exact", "valid_to", "statement_timestamp()", 0],
  ["end_inside", "valid_to", "statement_timestamp()+interval '1 microsecond'", 1],
  ["end_outside", "valid_to", "statement_timestamp()-interval '1 microsecond'", 0],
] as const)("readiness_component_history_list_%s", async (_name, column, instant, count) => transaction(async db => {
  await censusComponent(db, `UPDATE public.price_lists SET ${column}=${instant};`, historyReadBlock, "to_jsonb(v_policy_history_count)", count);
}));

it.each([
  ["automatic_code", { code: "EXAMPLE" }],
  ["target_minor", { benefit_value_minor: 1 }],
] as const)("readiness_native_promotion_coupling_%s", async (_name, delta) => transaction(async db => {
  await db.query(`UPDATE public.commerce_promotion_definitions SET definition=definition||${sqlJson(delta)} WHERE promotion_id='example:acquisition';`);
  await expect(rpc(db, "commerce_offer_policy_v2_readiness")).rejects.toMatchObject({ code: "55000", message: "catalog_price_setup_native_promotion_domain_unverified" });
}));
it.each([
  ["offer_version", "commerce.offer-policy.v2", "promotion-engine.v1"],
  ["engine_version", "commerce.offer-policy.v1", "promotion-engine.v2"],
] as const)("readiness_native_legacy_pair_constraint_%s", async (_name, offer, engine) => transaction(async db => {
  await expect(db.query(`INSERT INTO public.subscriptions(client_id,cadence_days,price_list_id,currency_code,offer_policy_assignment_state,offer_policy_version,promotion_engine_version)
    SELECT client_id,28,price_list_id,currency_code,'legacy_frozen',$1,$2 FROM public.subscriptions LIMIT 1;`, [offer, engine])).rejects.toMatchObject({ code: "23514" });
}));
it("readiness_census_unrelated_zero_line_does_not_invalidate_legacy", async () => transaction(async db => {
  await census(db, `WITH pending AS (
    INSERT INTO public.subscriptions(client_id,cadence_days,price_list_id,currency_code)
    SELECT client_id,28,price_list_id,currency_code FROM public.subscriptions LIMIT 1 RETURNING id)
    INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,unit_price_minor,sort_order,currency_code)
    SELECT p.id,l.variant_id,1,0,0,l.currency_code FROM pending p CROSS JOIN public.subscription_lines l LIMIT 1;`, { legacyFrozenInvalidCount: 0 });
}));

it("readiness_census_acquisition_null_basis_points", async () => transaction(async db => {
  // The native decoder preserves SQL UNKNOWN for this nullable shape; the
  // acquisition selector still refuses it with the ordinary donor reason.
  await census(db, `UPDATE public.commerce_promotion_definitions SET definition=definition||'{"benefit_kind":"percentage","benefit_value_bps":null}' WHERE promotion_id='example:acquisition';`,
    { acquisition: null }, ["first_subscription_pair_invalid"]);
}));

it.each([
  ["legacy_count_two", pairedAcquisition + `
    UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id='example:mirror';
    INSERT INTO public.commerce_promotion_definitions(promotion_id,definition_fingerprint,definition,active)
    SELECT 'example:legacy-second',repeat('e',64),definition||'{"id":"example:legacy-second"}',true
    FROM public.commerce_promotion_definitions WHERE promotion_id='example:legacy';`, [2, 1, 0]],
  ["pair_count_zero", legacyPair + "UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id='example:acquisition';", [1, 0, 0]],
  ["active_count_one", pairedAcquisition + "UPDATE public.commerce_promotion_definitions SET active=true WHERE promotion_id='example:acquisition';", [1, 1, 1]],
] as const)("readiness_reason_precedence_%s", async (_name, setup, counts) => transaction(async db => {
  await census(db, setup, { firstSubscriptionLegacyCount: counts[0], firstSubscriptionPairCount: counts[1],
    firstSubscriptionActiveCount: counts[2], acquisition: null }, ["first_subscription_pair_invalid"]);
}));

it.each([
  ["foreign_currency", "currency", "'YYY'"],
  ["inactive_newest", "status", "'draft'"],
] as const)("readiness_list_selection_excludes_%s", async (_name, column, value) => transaction(async db => {
  await census(db, `UPDATE public.price_lists SET created_at=statement_timestamp()-interval '2 hours';
    INSERT INTO public.price_lists(name,region_code,currency,status,valid_from,created_at)
    VALUES('Synthetic excluded list','ZZ',${column === "currency" ? value : "'XXX'"},${column === "status" ? value : "'active'"},statement_timestamp()-interval '1 hour',statement_timestamp());`,
    { activePriceListCount: 1, activeCoreSkuCount: 1, priceMismatchCount: 0, subscriptionPricePolicyCount: 1, subscriptionPricePolicyDerivesBand: true });
}));
it.each([
  ["zero_subscription", "subscription", 1], ["zero_tier", "one_time", 2],
] as const)("readiness_base_minimum_excludes_%s", async (_name, mode, qty) => transaction(async db => {
  await census(db, `INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,valid_from)
    SELECT price_list_id,variant_id,'${mode}',${qty},0,statement_timestamp()-interval '1 minute' FROM public.price_entries WHERE mode='one_time' AND active;`,
    { priceMismatchCount: 1, subscriptionPricePolicyDerivesBand: true }, ["catalog_1490_legacy_1340_invalid"]);
}));
it.each([
  ["subscription_tier", "min_qty=2"], ["subscription_net", "amount_kind='net'"],
] as const)("readiness_subscription_validity_requires_%s", async (_name, change) => transaction(async db => {
  await censusComponent(db, freshBaseContext + storedEntry + `UPDATE public.price_entries SET ${change} WHERE mode='subscription' AND price_list_id IN (SELECT id FROM public.price_lists WHERE status='active');`,
    shapeReadBlock, "v_inputs", [1, 1, 1, 0, 1]);
}));

it("readiness_unit_base_is_valid_even_when_the_derived_band_is_zero", async () => transaction(async db => {
  await census(db, "UPDATE public.price_entries SET unit_price_minor=1 WHERE mode='one_time';",
    { priceMismatchCount: 1, subscriptionPricePolicyDerivesBand: false }, ["catalog_1490_legacy_1340_invalid"]);
}));
it("readiness_stored_subscription_accepts_one_minor_unit", async () => transaction(async db => {
  await census(db, freshBaseContext + storedEntry + "UPDATE public.price_entries SET unit_price_minor=1 WHERE mode='subscription';", { priceMismatchCount: 0 });
}));
it.each([[9999, 0], [10000, 1]] as const)("readiness_derived_one_basis_point_base_%s", async (base, derived) => transaction(async db => {
  await census(db, freshBaseContext + policyEntry(undefined, undefined, "D2C", 9999, 1) + `UPDATE public.price_entries SET unit_price_minor=${base} WHERE price_list_id IN (SELECT id FROM public.price_lists WHERE status='active');`,
    { priceMismatchCount: derived ? 0 : 1, subscriptionPricePolicyDerivesBand: derived > 0 }, derived ? [] : ["catalog_1490_legacy_1340_invalid"]);
  const list = (await db.query("SELECT id FROM public.price_lists WHERE status='active'")).rows[0].id;
  expect((await rpc(db, "catalog_price_setup_preview", [genuine.sku, list])).subscription.derivedUnitPriceMinor).toBe(derived);
}));
it("readiness_policy_full_discount_is_well_formed", async () => transaction(async db => {
  await censusComponent(db, freshBaseContext + policyEntry(undefined, undefined, "D2C", 10000), policyReadBlock,
    "jsonb_build_array(v_subscription_policy_count,v_policy_well_formed,v_policy_discount_bps,v_policy_quantum)", [1, true, 10000, 10]);
}));

it.each([
  ["none", "", { kind: "unresolved", reason: "subscription_price_not_found" }],
  ["one", storedEntry, { kind: "stored", unitPriceMinor: 900 }],
  ["two", storedEntry + storedEntry.replaceAll("'1 hour'", "'2 hours'"), { kind: "unresolved", reason: "subscription_price_ambiguous" }],
  ["future_policy", policyEntry("statement_timestamp()+interval '1 hour'"), { kind: "unresolved", reason: "subscription_policy_not_effective" }],
] as const)("preview_subscription_lane_%s", async (_name, setup, expected) => transaction(async db => {
  await db.query(freshBaseContext + setup);
  const list = (await db.query("SELECT id FROM public.price_lists WHERE status='active'")).rows[0].id;
  expect((await rpc(db, "catalog_price_setup_preview", [genuine.sku, list])).subscription).toMatchObject(expected);
}));
it("preview_ambiguous_base_has_no_selected_current", async () => transaction(async db => {
  await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    SELECT price_list_id,variant_id,'one_time',1001,statement_timestamp()-interval '1 minute' FROM public.price_entries WHERE mode='one_time' AND active;`);
  expect(await rpc(db, "catalog_price_setup_preview", [genuine.sku, genuine.list])).toMatchObject({ outcome: "preview", current: null, currentCount: 2 });
}));
it.each(["entry", "amount"] as const)("expected_base_%s_mismatch_alone_refuses", async field => transaction(async db => {
  const c = await command(db);
  await unchangedRefusal(db, { ...c, expected: { ...c.expected, ...(field === "entry" ? { entryId: randomUUID() } : { unitPriceMinor: c.expected.unitPriceMinor + 1 }) } }, { code: "40001" });
}));
it("receipt_lookup_and_refusal_cleanup_are_key_scoped", async () => transaction(async db => {
  await apply(db, await command(db));
  const b = await command(db, { unitPriceMinor: 1300 }), result = await apply(db, b), before = await priceSnapshot(db);
  expect(await apply(db, b)).toEqual({ ...result, outcome: "replayed" });
  expect(await apply(db, await command(db, { variantId: randomUUID() }))).toEqual({ outcome: "validation_issue", reason: "sku_not_found" });
  expect(await priceSnapshot(db)).toEqual(before);
}));

it.each([
  ["archived", "status='archived'", false], ["draft", "status='draft'", false], ["addon", "is_addon=true", false],
  ["neither", "sellable_standalone=false,sellable_in_subscription=false", false],
  ["standalone", "sellable_standalone=true,sellable_in_subscription=false", true],
  ["subscription", "sellable_standalone=false,sellable_in_subscription=true", true],
  ["other_gate_list", "", false],
] as const)("preview_gate_membership_%s", async (name, change, expected) => transaction(async db => {
  if (change) await db.query(`UPDATE public.catalog_skus SET ${change} WHERE id=$1`, [genuine.sku]);
  if (name === "other_gate_list") await db.query(freshBaseContext.replace("UPDATE public.price_lists SET status='archived';", ""));
  expect((await rpc(db, "catalog_price_setup_preview", [genuine.sku, genuine.list])).inGate).toBe(expected);
}));
for (const method of ["preview", "apply"] as const) {
  it.each([
    ["draft", "'draft'", "'ZZ'", "'XXX'", "statement_timestamp()-interval '1 hour'", "NULL", false],
    ["region", "'active'", "'YY'", "'XXX'", "statement_timestamp()-interval '1 hour'", "NULL", false],
    ["currency", "'active'", "'ZZ'", "'YYY'", "statement_timestamp()-interval '1 hour'", "NULL", false],
    ["future", "'active'", "'ZZ'", "'XXX'", "statement_timestamp()+interval '1 microsecond'", "NULL", false],
    ["end_exact", "'active'", "'ZZ'", "'XXX'", "statement_timestamp()-interval '1 hour'", "statement_timestamp()", false],
    ["start_exact", "'active'", "'ZZ'", "'XXX'", "statement_timestamp()", "NULL", true],
  ] as const)(`${method}_target_list_%s`, async (_name, status, region, currency, from, to, valid) => transaction(async db => {
    const c = await command(db, { expected: { entryId: null, unitPriceMinor: null } });
    await db.query(`DO $proof$ DECLARE target uuid:=gen_random_uuid(); bytes text; observed jsonb; BEGIN
      INSERT INTO public.price_lists(id,name,region_code,currency,status,valid_from,valid_to)
      VALUES(target,'Synthetic target',${region},${currency},${status},${from},${to});
      bytes:=(${sqlJson(c)}||jsonb_build_object('priceListId',target))::text;
      observed:=${method === "apply" ? "public.catalog_price_setup_apply(bytes,encode(sha256(convert_to(bytes,'UTF8')),'hex'))" : `public.catalog_price_setup_preview('${genuine.sku}',target,1200)`};
      IF observed->>'outcome' IS DISTINCT FROM '${valid ? method === "apply" ? "committed" : "preview" : "validation_issue"}'
        ${valid ? method === "preview" ? "OR observed->'inGate' IS DISTINCT FROM 'true'::jsonb" : "" : "OR observed->>'reason' IS DISTINCT FROM 'price_list_not_active'"} THEN
        RAISE EXCEPTION 'target_list_guard_mismatch' USING DETAIL=observed::text;
      END IF; END $proof$;`);
  }));
  it(`${method}_archived_and_missing_targets_refuse`, async () => transaction(async db => {
    const c = await command(db);
    await db.query("UPDATE public.catalog_skus SET status='archived' WHERE id=$1", [genuine.sku]);
    const invoke = (v: typeof c) => method === "apply" ? apply(db, v) : rpc(db, "catalog_price_setup_preview", [v.variantId, v.priceListId, 1200]);
    expect(await invoke(c)).toEqual({ outcome: "validation_issue", reason: "sku_archived" });
    expect(await invoke({ ...c, variantId: randomUUID() })).toEqual({ outcome: "validation_issue", reason: "sku_not_found" });
    await db.query("UPDATE public.catalog_skus SET status='active' WHERE id=$1", [genuine.sku]);
    expect(await invoke({ ...c, priceListId: randomUUID() })).toEqual({ outcome: "validation_issue", reason: "price_list_not_found" });
  }));
  it.each([false, true])(`${method}_pending_exact_boundary_ambiguous_%s`, async ambiguous => transaction(async db => {
    const c = await command(db);
    await db.query(`DO $proof$ DECLARE bytes text; observed jsonb; BEGIN
      ${ambiguous ? `INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES('${genuine.list}','${genuine.sku}','one_time',1001,statement_timestamp());` : `UPDATE public.price_entries SET valid_from=statement_timestamp() WHERE id='${c.expected.entryId}';`}
      bytes:=${sqlJson(c)}::text;
      ${method === "apply" && !ambiguous ? `BEGIN
        PERFORM public.catalog_price_setup_apply(bytes,encode(sha256(convert_to(bytes,'UTF8')),'hex'));
        RAISE EXCEPTION 'pending_boundary_was_admitted';
        EXCEPTION WHEN serialization_failure THEN NULL; END;` : `observed:=${method === "apply" ? "public.catalog_price_setup_apply(bytes,encode(sha256(convert_to(bytes,'UTF8')),'hex'))" : `public.catalog_price_setup_preview('${genuine.sku}','${genuine.list}',1200)`};
        IF observed->>'reason' IS DISTINCT FROM '${ambiguous ? "base_price_ambiguous" : "expected_state_mismatch"}' THEN RAISE EXCEPTION 'pending_boundary_reason_mismatch' USING DETAIL=observed::text; END IF;`}
      END $proof$;`);
  }));
}
it("preview_zero_amount_and_unproposed_current_are_distinct", async () => transaction(async db => {
  expect(await rpc(db, "catalog_price_setup_preview", [genuine.sku, genuine.list, 0])).toEqual({ outcome: "validation_issue", reason: "unit_price_invalid" });
  expect((await rpc(db, "catalog_price_setup_preview", [genuine.sku, genuine.list, 1])).outcome).toBe("preview");
  const c = await command(db);
  await db.query(`DO $proof$ DECLARE observed jsonb; BEGIN
    UPDATE public.price_entries SET valid_from=statement_timestamp() WHERE id='${c.expected.entryId}';
    observed:=public.catalog_price_setup_preview('${genuine.sku}','${genuine.list}',NULL);
    IF observed#>>'{current,entryId}' IS DISTINCT FROM '${c.expected.entryId}' OR observed ? 'proposed' THEN RAISE EXCEPTION 'unproposed_current_mismatch'; END IF;
    END $proof$;`);
}));
it.each([
  ["inactive", "active=false"], ["tier", "min_qty=2"], ["any", "mode='any'"], ["subscription", "mode='subscription'"],
] as const)("writer_ignores_other_base_rows_%s", async (_name, change) => transaction(async db => {
  const c = await command(db);
  await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    VALUES('${genuine.list}','${genuine.sku}','one_time',999,statement_timestamp()-interval '2 hours');
    UPDATE public.price_entries SET ${change} WHERE unit_price_minor=999;`);
  expect((await apply(db, c)).outcome).toBe("committed");
}));

it.each([
  ["expected_extra", { expected: { entryId: null, unitPriceMinor: null, extra: 1 } }],
  ["schema_version", { schemaVersion: 2 }], ["key_null", { commandKey: null }], ["key_empty", { commandKey: "" }],
  ["key_long", { commandKey: "x".repeat(241) }], ["key_trim", { commandKey: " padded " }],
  ["variant_null", { variantId: null }], ["variant_bad", { variantId: "not-a-uuid" }],
  ["list_null", { priceListId: null }], ["list_bad", { priceListId: "not-a-uuid" }],
  ["amount_string", { unitPriceMinor: "1200" }], ["amount_decimal", { unitPriceMinor: 1.5 }],
  ["expected_array", { expected: [] }], ["expected_missing_entry", { expected: { unitPriceMinor: null } }],
  ["expected_missing_amount", { expected: { entryId: null } }],
  ["expected_entry_only_null", { expected: { entryId: null, unitPriceMinor: 1000 } }],
  ["expected_amount_only_null", { expected: { entryId: randomUUID(), unitPriceMinor: null } }],
  ["expected_bad_entry", { expected: { entryId: "not-a-uuid", unitPriceMinor: 1000 } }],
  ["expected_string_amount", { expected: { entryId: randomUUID(), unitPriceMinor: "1000" } }],
  ["expected_negative_amount", { expected: { entryId: randomUUID(), unitPriceMinor: -1 } }],
  ["expected_overflow", { expected: { entryId: randomUUID(), unitPriceMinor: 2147483648 } }],
] as const)("native_command_guard_%s", async (_name, delta) => transaction(async db => {
  const bytes = JSON.stringify(await command(db, delta));
  expect(await rpc(db, "catalog_price_setup_apply", [bytes, createHash("sha256").update(bytes).digest("hex")]))
    .toEqual({ outcome: "validation_issue", reason: "command_invalid" });
}));
it.each([
  ["sql_null", null, "0".repeat(64), "command_fingerprint_invalid"],
  ["one_byte", "0", null, "command_fingerprint_invalid"], ["two_bytes", "{}", null, "command_invalid"],
  ["bad_json", "{broken}", null, "command_invalid"], ["json_array", "[]", null, "command_invalid"],
  ["unicode_nul", '{"x":"\\u0000"}', null, "command_invalid"],
] as const)("native_raw_bytes_%s", async (_name, bytes, suppliedHash, reason) => transaction(async db => {
  const hash = suppliedHash ?? createHash("sha256").update(bytes!).digest("hex");
  expect(await rpc(db, "catalog_price_setup_apply", [bytes, hash])).toEqual({ outcome: "validation_issue", reason });
}));
it.each([null, "0".repeat(64)])("native_fingerprint_alone_refuses_%s", async fingerprint => transaction(async db => {
  expect(await rpc(db, "catalog_price_setup_apply", [JSON.stringify(await command(db)), fingerprint]))
    .toEqual({ outcome: "validation_issue", reason: "command_fingerprint_invalid" });
}));
it.each([4096, 4097])("native_byte_limit_%s", async size => transaction(async db => {
  const json = JSON.stringify(await command(db)), bytes = json.padEnd(size, " ");
  const answer = await rpc(db, "catalog_price_setup_apply", [bytes, createHash("sha256").update(bytes).digest("hex")]);
  if (size === 4096) expect(answer.outcome).toBe("committed");
  else expect(answer).toEqual({ outcome: "validation_issue", reason: "command_fingerprint_invalid" });
}));
it.each([1, 240])("native_command_key_limit_%s", async size => transaction(async db => {
  expect((await apply(db, await command(db, { commandKey: "x".repeat(size) }))).outcome).toBe("committed");
}));
it.each(["unit", "expected"] as const)("native_integer_maximum_%s", async field => transaction(async db => {
  const c = await command(db);
  if (field === "unit") c.unitPriceMinor = 2147483647;
  else { await db.query("UPDATE public.price_entries SET unit_price_minor=2147483647 WHERE id=$1", [c.expected.entryId]); c.expected.unitPriceMinor = 2147483647; }
  expect((await apply(db, c)).outcome).toBe("committed");
}));
it("native_one_digit_amount_reaches_readiness_and_zero_expected_is_legal", async () => transaction(async db => {
  await unchangedRefusal(db, await command(db, { unitPriceMinor: 1 }), { code: "55000", message: "catalog_price_setup_readiness_would_fail" });
  const c = await command(db);
  await db.query("UPDATE public.price_entries SET unit_price_minor=0 WHERE id=$1", [c.expected.entryId]);
  expect((await apply(db, { ...c, expected: { ...c.expected, unitPriceMinor: 0 } })).outcome).toBe("committed");
  const one = await command(db);
  await db.query("UPDATE public.price_entries SET unit_price_minor=1 WHERE id=$1", [one.expected.entryId]);
  expect((await apply(db, { ...one, expected: { ...one.expected, unitPriceMinor: 1 } })).outcome).toBe("committed");
}));
it("native_first_base_and_pending_receipt_are_explicit", async () => transaction(async db => {
  const c = await command(db);
  await db.query("UPDATE public.price_entries SET active=false WHERE id=$1", [c.expected.entryId]);
  const first = { ...c, expected: { entryId: null, unitPriceMinor: null } };
  expect(await apply(db, first)).toMatchObject({ outcome: "committed", receipt: { previous: null } });
  const pending = await command(db), bytes = canonicalCatalogPriceSetupCommand(pending), hash = createHash("sha256").update(bytes).digest("hex");
  await db.query("INSERT INTO public.catalog_price_setup_receipts(scope,idempotency_key,request_fingerprint,status,metadata) VALUES('catalog.price_setup.base',$1,$2,'in_progress','{}')", [pending.commandKey, hash]);
  expect(await rpc(db, "catalog_price_setup_apply", [bytes, hash])).toEqual({ outcome: "conflict", reason: "command_in_progress" });
}));
it.each(["subtotalGross", "discountTotalGross", "shippingGross", "shippingDiscountGross", "totalGross"])(
  "readiness_money_rejects_17_digit_padded_%s", async field => transaction(async db => {
    await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,${field},amountMinor}',to_jsonb(lpad(metadata#>>'{quoteSnapshot,quote,${field},amountMinor}',17,'0')));`,
      moneyBlock, moneyObserved, { checked: 1, mismatched: 1 });
  }));

function nativePriceSelection(routine: "preview" | "apply") {
  const source = routine === "preview"
    ? readFileSync(writerPath, "utf8").split("CREATE FUNCTION public.catalog_price_setup_preview(")[1]
    : readFileSync(commandsPath, "utf8").split("CREATE FUNCTION public.catalog_price_setup_apply_claimed(")[1];
  if (routine === "preview") return source.slice(source.indexOf("  SELECT count(*) FILTER"), source.indexOf("  -- The subscription price"));
  const count = source.indexOf("    SELECT count(*) FILTER"), selected = source.indexOf("  SELECT * INTO v_current", count);
  return source.slice(count, source.indexOf("\n    IF ", count)) + source.slice(selected, source.indexOf("\n  IF ", selected));
}
for (const routine of ["preview", "apply"] as const) {
  it.each(["other_list", "other_variant", "any", "subscription", "tier", "inactive", "future", "expired", "end_exact", "start_exact"] as const)(
    `${routine}_native_selection_excludes_%s`, async kind => transaction(async db => {
      const foreignList = randomUUID(), foreignSku = randomUUID(), primary = randomUUID(), decoy = randomUUID();
      await db.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Synthetic foreign','YY','XXX')", [foreignList]);
      await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status) VALUES($1::uuid,$2::uuid,($1::uuid)::text,'Synthetic foreign','archived')", [foreignSku, genuine.sku]);
      const block = nativePriceSelection(routine);
      await db.query(`DO $proof$ DECLARE v_now timestamptz:=statement_timestamp();
        v_list_id uuid:='${genuine.list}'; v_variant_id uuid:='${genuine.sku}'; v_list public.price_lists%ROWTYPE; v_sku public.catalog_skus%ROWTYPE;
        v_current public.price_entries%ROWTYPE; v_current_count integer; v_pending_count integer;
        BEGIN v_list.id:=v_list_id; v_sku.id:=v_variant_id;
        UPDATE public.price_entries SET active=false;
        INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,active,unit_price_minor,valid_from,valid_to)
        VALUES('${decoy}','${kind === "other_list" ? foreignList : genuine.list}','${kind === "other_variant" ? foreignSku : genuine.sku}',
          '${kind === "any" || kind === "subscription" ? kind : "one_time"}',${kind === "tier" ? 2 : 1},${kind !== "inactive"},999,
          v_now${kind === "future" ? "+interval '1 microsecond'" : "-interval '2 hours'"},
          ${kind === "expired" ? "v_now-interval '1 microsecond'" : (kind === "end_exact" || kind === "start_exact") ? "v_now" : "NULL"});
        INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from)
        VALUES('${primary}',v_list_id,v_variant_id,'one_time',1000,v_now${kind === "start_exact" ? "" : "-interval '1 hour'"});
        ${block}
        IF v_current_count IS DISTINCT FROM 1 OR v_pending_count IS DISTINCT FROM ${kind === "future" || kind === "start_exact" ? 1 : 0}
          OR v_current.id IS DISTINCT FROM '${primary}'::uuid THEN
          RAISE EXCEPTION 'native_price_selection_mismatch' USING DETAIL=jsonb_build_array(v_current_count,v_pending_count,v_current.id)::text;
        END IF; END $proof$;`);
    }));
}
it("writer_native_lock_predicates_select_exact_open_rows", async () => {
  const foreignList = randomUUID(), foreignSku = randomUUID();
  const kinds = ["open", "future", "finite", "expired", "end_exact", "inactive", "tier", "any", "subscription", "other_list", "other_variant"] as const;
  const rows = kinds.map(kind => ({ kind, id: randomUUID(), locked: ["open", "future", "finite"].includes(kind) }));
  const db = await owner.connect(), probe = await owner.connect();
  try {
    await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Synthetic lock list','YY','XXX')", [foreignList]);
    await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status) VALUES($1::uuid,$2::uuid,($1::uuid)::text,'Synthetic lock item','archived')", [foreignSku, genuine.sku]);
    await owner.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,active,unit_price_minor,valid_from,valid_to) VALUES ${rows.map(r =>
      `('${r.id}','${r.kind === "other_list" ? foreignList : genuine.list}','${r.kind === "other_variant" ? foreignSku : genuine.sku}',
      '${r.kind === "any" || r.kind === "subscription" ? r.kind : "one_time"}',${r.kind === "tier" ? 2 : 1},${r.kind !== "inactive"},999,
      statement_timestamp()${r.kind === "future" ? "+interval '1 hour'" : "-interval '2 hours'"},
      ${r.kind === "finite" ? "statement_timestamp()+interval '1 hour'" : r.kind === "expired" ? "statement_timestamp()-interval '1 microsecond'" : r.kind === "end_exact" ? "statement_timestamp()" : "NULL"})`).join(",")}`);
    await db.query("BEGIN"); await probe.query("BEGIN");
    const source = readFileSync(commandsPath, "utf8").split("CREATE FUNCTION public.catalog_price_setup_apply_claimed(")[1];
    const start = source.indexOf("    PERFORM 1 FROM public.price_entries"), end = source.indexOf("    -- 7.", start);
    await db.query(`DO $proof$ DECLARE v_list_id uuid:='${genuine.list}'; v_variant_id uuid:='${genuine.sku}';
      v_now timestamptz:=(SELECT valid_to FROM public.price_entries WHERE id='${rows.find(r => r.kind === "end_exact")!.id}');
      BEGIN ${source.slice(start, end)} END $proof$;`);
    for (const row of rows) {
      await probe.query("SAVEPOINT row_probe");
      const attempt = probe.query("SELECT id FROM public.price_entries WHERE id=$1 FOR NO KEY UPDATE NOWAIT", [row.id]);
      if (row.locked) await expect(attempt, row.kind).rejects.toMatchObject({ code: "55P03" });
      else expect((await attempt).rows, row.kind).toHaveLength(1);
      await probe.query("ROLLBACK TO SAVEPOINT row_probe"); await probe.query("RELEASE SAVEPOINT row_probe");
    }
  } finally {
    await db.query("ROLLBACK"); await probe.query("ROLLBACK"); db.release(); probe.release();
    await owner.query("DELETE FROM public.price_entries WHERE id=ANY($1::uuid[])", [rows.map(r => r.id)]);
    await owner.query("DELETE FROM public.catalog_skus WHERE id=$1", [foreignSku]);
    await owner.query("DELETE FROM public.price_lists WHERE id=$1", [foreignList]);
  }
});

it("preview_positive_replacement_restores_the_exact_price_shape", async () => transaction(async db => {
  const before = await priceSnapshot(db), answer = await rpc(db, "catalog_price_setup_preview", [genuine.sku, genuine.list, 1200]);
  expect(answer.proposed.readiness).toEqual(answer.readiness);
  expect(answer.proposed.readiness.reasons).not.toContain("catalog_1490_legacy_1340_invalid");
  expect(await priceSnapshot(db)).toEqual(before);
}));
it.each([
  ["region", "'YY'", "'XXX'", "'active'", "statement_timestamp()-interval '1 hour'", "NULL"],
  ["currency", "'ZZ'", "'YYY'", "'active'", "statement_timestamp()-interval '1 hour'", "NULL"],
  ["status", "'ZZ'", "'XXX'", "'draft'", "statement_timestamp()-interval '1 hour'", "NULL"],
  ["future", "'ZZ'", "'XXX'", "'active'", "statement_timestamp()+interval '1 hour'", "NULL"],
  ["expired", "'ZZ'", "'XXX'", "'active'", "statement_timestamp()-interval '1 hour'", "statement_timestamp()-interval '1 minute'"],
] as const)("preview_gate_ignores_newest_%s_list", async (_name, region, currency, status, from, to) => transaction(async db => {
  await db.query(`UPDATE public.price_lists SET created_at=statement_timestamp()-interval '2 hours';
    INSERT INTO public.price_lists(name,region_code,currency,status,valid_from,valid_to,created_at)
    VALUES('Synthetic excluded gate',${region},${currency},${status},${from},${to},statement_timestamp());`);
  expect((await rpc(db, "catalog_price_setup_preview", [genuine.sku, genuine.list])).inGate).toBe(true);
}));
it.each(["preview", "apply"] as const)("%s_accepts_finite_open_list_and_entry", async method => transaction(async db => {
  const c = await command(db);
  await db.query("UPDATE public.price_lists SET valid_to=statement_timestamp()+interval '1 hour' WHERE id=$1", [genuine.list]);
  await db.query("UPDATE public.price_entries SET valid_to=statement_timestamp()+interval '1 hour' WHERE id=$1", [c.expected.entryId]);
  if (method === "apply") expect((await apply(db, c)).outcome).toBe("committed");
  else expect(await rpc(db, "catalog_price_setup_preview", [genuine.sku, genuine.list, 1200])).toMatchObject({ outcome: "preview", inGate: true, currentCount: 1, current: { entryId: c.expected.entryId } });
}));
it("preview_accepts_an_effective_policy_with_a_finite_end", async () => transaction(async db => {
  await db.query("UPDATE public.subscription_price_policy_revisions SET effective_to=statement_timestamp()+interval '1 hour' WHERE price_list_id=$1", [genuine.list]);
  expect((await rpc(db, "catalog_price_setup_preview", [genuine.sku, genuine.list])).subscription).toMatchObject({ kind: "derived", discountBps: 1000 });
}));
it("preview_other_channel_policy_is_not_history", async () => transaction(async db => {
  await db.query(freshBaseContext + storedEntry + policyEntry(undefined, undefined, "B2B"));
  const list = (await db.query("SELECT id FROM public.price_lists WHERE status='active'")).rows[0].id;
  expect((await rpc(db, "catalog_price_setup_preview", [genuine.sku, list])).subscription).toEqual({ kind: "stored", unitPriceMinor: 900 });
}));
it.each(["other_channel", "future", "closed", "adjacent"] as const)("preview_policy_selection_excludes_%s_revision", async kind => transaction(async db => {
  const other = policyEntry(kind === "future" ? "statement_timestamp()+interval '1 hour'" : "statement_timestamp()-interval '2 hours'",
    kind === "future" || kind === "other_channel" ? "NULL::timestamptz" : kind === "adjacent" ? "statement_timestamp()" : "statement_timestamp()-interval '1 hour'",
    kind === "other_channel" ? "B2B" : "D2C", 2000);
  const currentPolicy = policyEntry(kind === "adjacent" ? "statement_timestamp()" : "statement_timestamp()-interval '30 minutes'",
    kind === "future" ? "statement_timestamp()+interval '1 hour'" : "NULL::timestamptz")
    .replace("SELECT v.id,1,p.id", "SELECT v.id,2,p.id").replace("digest(v.id,1,p.id", "digest(v.id,2,p.id");
  await db.query(`DO $proof$ DECLARE observed jsonb; BEGIN ${freshBaseContext} ${other} ${currentPolicy}
    observed:=public.catalog_price_setup_preview('${genuine.sku}',(SELECT id FROM public.price_lists WHERE status='active'),NULL);
    IF NOT(observed->'subscription' @> '{"kind":"derived","discountBps":1000,"derivedUnitPriceMinor":900}') THEN
      RAISE EXCEPTION 'preview_selected_wrong_policy' USING DETAIL=observed::text;
    END IF; END $proof$;`);
}));
it("preview_policy_end_exact_is_not_effective", async () => transaction(async db => {
  await db.query(`DO $proof$ DECLARE observed jsonb; BEGIN ${freshBaseContext} ${policyEntry(undefined, "statement_timestamp()")}
    observed:=public.catalog_price_setup_preview('${genuine.sku}',(SELECT id FROM public.price_lists WHERE status='active'),NULL);
    IF observed->'subscription' IS DISTINCT FROM '{"kind":"unresolved","reason":"subscription_policy_not_effective"}'::jsonb THEN
      RAISE EXCEPTION 'preview_policy_end_boundary_mismatch' USING DETAIL=observed::text;
    END IF; END $proof$;`);
}));

it.each(["subtotalGross", "discountTotalGross", "shippingGross", "shippingDiscountGross", "totalGross"])(
  "readiness_money_empty_scalar_%s", async field => transaction(async db => {
    await censusComponent(db, automaticOrder + `UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{quoteSnapshot,quote,${field},amountMinor}','""');`,
      moneyBlock, moneyObserved, { checked: 1, mismatched: 1 });
  }));
it("readiness_money_accepts_one_digit_native_subtotal_and_total", async () => transaction(async db => {
  const quote = { context: { pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" } },
    subtotalGross: { amountMinor: 7, currency: "XXX" }, discountTotalGross: { amountMinor: 0, currency: "XXX" }, totalGross: { amountMinor: 7, currency: "XXX" } };
  await censusComponent(db, `WITH fresh AS (INSERT INTO public.commerce_orders(status,currency_code,total_amount_minor,metadata)
    VALUES('paid','XXX',7,${sqlJson({ quoteSnapshot: { quote } })}) RETURNING id)
    INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,1,1,7,7 FROM fresh;`,
    moneyBlock, moneyObserved, { checked: 1, mismatched: 0 });
  await expect(rpc(db, "commerce_offer_policy_v2_readiness")).rejects.toMatchObject({ code: "55000", message: "catalog_price_setup_native_order_guard_unverified" });
}));
it("readiness_positive_one_minor_legacy_line_is_not_nonpositive", async () => transaction(async db => {
  await censusComponent(db, "UPDATE public.subscription_lines SET unit_price_minor=1;", legacyDecisionBlock, "to_jsonb(v_legacy_invalid_count)", 0);
  await expect(rpc(db, "commerce_offer_policy_v2_readiness")).rejects.toMatchObject({ code: "55000", message: "catalog_price_setup_native_agreement_domain_unverified" });
}));
it.each(["other_list", "other_variant", "tier", "inactive", "future", "expired", "end_exact", "start_exact", "finite"] as const)(
  "preview_stored_selection_%s", async kind => transaction(async db => {
    await db.query(freshBaseContext);
    const foreignSku = randomUUID();
    await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status) VALUES($1::uuid,$2::uuid,($1::uuid)::text,'Synthetic stored selection','archived')", [foreignSku, genuine.sku]);
    const source = readFileSync(writerPath, "utf8").split("CREATE FUNCTION public.catalog_price_setup_preview(")[1];
    const start = source.indexOf("    SELECT count(*), min(entry.unit_price_minor)"), end = source.indexOf("    v_subscription :=", start);
    await db.query(`DO $proof$ DECLARE v_now timestamptz:=statement_timestamp(); v_list public.price_lists%ROWTYPE; v_sku public.catalog_skus%ROWTYPE;
      v_stored_count integer; v_stored_minor integer; BEGIN
      SELECT * INTO v_list FROM public.price_lists WHERE status='active'; v_sku.id:='${genuine.sku}';
      INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,active,unit_price_minor,valid_from,valid_to)
      VALUES(${kind === "other_list" ? "'"+genuine.list+"'::uuid" : "v_list.id"},'${kind === "other_variant" ? foreignSku : genuine.sku}','subscription',${kind === "tier" ? 2 : 1},${kind !== "inactive"},1,
        v_now${kind === "future" ? "+interval '1 microsecond'" : "-interval '2 hours'"},${kind === "expired" ? "v_now-interval '1 microsecond'" : kind === "end_exact" ? "v_now" : kind === "start_exact" || kind === "finite" ? "v_now-interval '1 microsecond'" : "NULL"});
      INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from,valid_to)
      VALUES(v_list.id,v_sku.id,'subscription',900,v_now${kind === "start_exact" ? "" : "-interval '1 hour'"},${kind === "finite" ? "v_now+interval '1 microsecond'" : "NULL"});
      ${source.slice(start,end)}
      IF v_stored_count IS DISTINCT FROM 1 OR v_stored_minor IS DISTINCT FROM 900 THEN
        RAISE EXCEPTION 'stored_selection_mismatch' USING DETAIL=jsonb_build_array(v_stored_count,v_stored_minor)::text;
      END IF; END $proof$;`);
  }));

it("preview_gate_end_exact_keeps_the_eligible_list", async () => transaction(async db => {
  await db.query(`DO $proof$ DECLARE observed jsonb; BEGIN
    UPDATE public.price_lists SET created_at=statement_timestamp()-interval '2 hours';
    INSERT INTO public.price_lists(name,region_code,currency,valid_from,valid_to,created_at)
    VALUES('Synthetic boundary list','ZZ','XXX',statement_timestamp()-interval '1 hour',statement_timestamp(),statement_timestamp());
    observed:=public.catalog_price_setup_preview('${genuine.sku}','${genuine.list}',NULL);
    IF observed->'inGate' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'preview_gate_end_was_inclusive'; END IF;
    END $proof$;`);
}));
it("writer_refuses_two_finite_effective_bases", async () => transaction(async db => {
  const c = await command(db);
  await db.query("UPDATE public.price_entries SET valid_to=statement_timestamp()+interval '1 hour' WHERE id=$1", [c.expected.entryId]);
  await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from,valid_to) VALUES($1,$2,'one_time',1001,statement_timestamp()-interval '2 hours',statement_timestamp()+interval '1 hour')", [genuine.list, genuine.sku]);
  expect(await apply(db, c)).toEqual({ outcome: "validation_issue", reason: "base_price_ambiguous" });
}));

it.each(["claimed", "wrapper"] as const)("serializes distinct keys when %s owns the price context first", async first => {
  const leader = await owner.connect(), follower = await owner.connect();
  try {
    await leader.query("BEGIN"); await session(leader);
    await follower.query("BEGIN"); await session(follower);
    const a = await command(leader);
    const b = { ...a, commandKey: randomUUID() };
    async function claimed(db: PoolClient, value: typeof a) {
      const bytes = canonicalCatalogPriceSetupCommand(value);
      const claim = await rpc(db, "catalog_price_setup_claim", [bytes, createHash("sha256").update(bytes).digest("hex")]);
      expect(claim).toMatchObject({ outcome: "claimed" });
      await rpc(db, "catalog_price_setup_lock_context", [value.priceListId, value.variantId]);
      return (await db.query("SELECT public.catalog_price_setup_apply_claimed($1,statement_timestamp()) AS value", [claim])).rows[0].value;
    }
    const firstApply = first === "claimed" ? claimed : apply;
    const nextApply = first === "claimed" ? apply : claimed;
    expect(await firstApply(leader, a)).toMatchObject({ outcome: "committed" });
    const next = nextApply(follower, b);
    // The winner still owns its row and context locks. A distinct key must wait.
    expect(await Promise.race([next.then(() => "finished"), new Promise(resolve => setTimeout(() => resolve("waiting"), 100))]))
      .toBe("waiting");
    await leader.query("ROLLBACK");
    expect(await next).toMatchObject({ outcome: "committed", receipt: { commandKey: b.commandKey } });
  } finally {
    await Promise.all([leader.query("ROLLBACK"), follower.query("ROLLBACK")]);
    leader.release(); follower.release();
  }
});

it("opens both previews on an occupied store and exposes the existing readiness remedies", async () => transaction(async db => {
  const start = manifest.forward.findIndex((unit: {file:string}) => unit.file === writerPath);
  for (const unit of manifest.forward.slice(start + 1)) {
    if (unit.file === commandsPath || unit.file.endsWith("_catalog_publication.sql")) continue;
    await db.query(readFileSync(unit.file,"utf8"));
  }
  await db.query(successfulControls);
  const order = await boundOneTimePurchase(db,"READINESS-AGREED",(await current(db)).unit_price_minor,"XXX","readiness-agreed");
  const reader = "price_setup_preview_witness";
  await db.query(`CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT EXECUTE ON FUNCTION public.commerce_offer_policy_v2_readiness(), public.catalog_price_setup_preview(uuid,uuid,integer) TO ${reader}`);
  const read = async (proposed?: number) => {
    await db.query(`SET LOCAL ROLE ${reader}`);
    try {
      const verdict = await rpc(db,"commerce_offer_policy_v2_readiness");
      const preview = await rpc(db,"catalog_price_setup_preview",[genuine.sku,genuine.list,proposed ?? null]);
      return {verdict,preview};
    } finally { await db.query("RESET ROLE"); }
  };
  const observed = await read();
  expect(observed.verdict).toMatchObject({ready:true,evidence:{automaticV2MoneyCheckedCount:1}});
  expect(observed.preview.readiness.reasons).toEqual([]);
  const comparison = await read(1);
  expect(comparison.preview.proposed.readiness.reasons).toContain("catalog_1490_legacy_1340_invalid");
  const cases: [string,string[]][] = [
    ["UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id='example:acquisition'",["first_subscription_pair_invalid"]],
    [pairedAcquisition + "UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id='example:mirror'",["first_subscription_mirror_not_ready"]],
    ["UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id='example:bundle'",["bundle_5_policy_invalid"]],
    ["UPDATE public.price_entries SET unit_price_minor=1 WHERE mode='one_time'",["catalog_1490_legacy_1340_invalid"]],
    ["UPDATE public.platform_job_controls SET enabled=false WHERE job_name='platform-watchdog'",["promotion_watchdog_not_ready"]],
    ["UPDATE public.platform_job_controls SET enabled=false WHERE job_name='promotion-claim-sweep'",["promotion_claim_sweep_not_ready"]],
    ["UPDATE public.commerce_settings SET value_text='XTS' WHERE key='settlement_currency'",
      ["catalog_1490_legacy_1340_invalid","legacy_frozen_records_invalid","automatic_v2_money_invalid"]],
  ];
  for (const [sql,reasons] of cases) {
    await db.query("SAVEPOINT remedy");
    await db.query(sql);
    expect((await read()).verdict.reasons).toEqual(reasons);
    await db.query("ROLLBACK TO SAVEPOINT remedy");
    expect((await read()).verdict.reasons).toEqual([]);
  }
  await db.query(`UPDATE public.outbox_events SET metadata=metadata-'boundary'
    WHERE aggregate_id=$1 AND event_type='commerce.order_draft.created'`,[order]);
  await db.query("SAVEPOINT future_read");
  await db.query(`SET LOCAL ROLE ${reader}`);
  for (const proposed of [null,1200]) {
    await db.query("SAVEPOINT preview_attempt");
    const error: unknown = await rpc(db,"catalog_price_setup_preview",[genuine.sku,genuine.list,proposed])
      .catch((failure:unknown) => failure);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(Object.getPrototypeOf(error as DatabaseError)).toBe(DatabaseError.prototype);
    expect(error).toMatchObject({code:"55000",message:"catalog_price_setup_native_order_guard_unverified"});
    expect(Reflect.ownKeys(error as DatabaseError).filter(key => key !== "stack" && key !== "message").sort()).toEqual([
      "code","column","constraint","dataType","detail","file","hint","internalPosition","internalQuery","length",
      "line","name","position","routine","schema","severity","table","where",
    ].sort());
    await db.query("ROLLBACK TO SAVEPOINT preview_attempt");
  }
  await db.query("ROLLBACK TO SAVEPOINT future_read");
  await db.query("UPDATE public.commerce_orders SET created_at=statement_timestamp()-interval '24 hours 1 microsecond' WHERE id=$1",[order]);
  expect((await read(1200)).verdict.ready).toBe(true);
}), postgresSetupTimeoutMs);

it("replays the original v1 bytes after writer upgrade and refuses a fresh v1 edit of the exclusive list", async () => {
  const db = await owner.connect();
  try {
    const fresh = async () => {
      await db.query("BEGIN");
      await session(db);
    };
    await fresh();
    const legacy = await command(db), canonical = canonicalCatalogPriceSetupCommand(legacy);
    const fingerprint = createHash("sha256").update(canonical).digest("hex");
    const raw = async () => (await db.query("SELECT public.catalog_price_setup_apply($1,$2)::text AS bytes",
      [canonical, fingerprint])).rows[0].bytes as string;
    expect(JSON.parse(await raw())).toHaveProperty("outcome", "committed");
    await db.query("COMMIT");
    await fresh();
    const beforeUpgrade = Buffer.from(await raw(), "utf8");
    expect(JSON.parse(beforeUpgrade.toString("utf8"))).toHaveProperty("outcome", "replayed");
    await db.query("COMMIT");
    for (const suffix of ["_catalog_price_list_basis.sql", "_catalog_price_writer_v2.sql"]) {
      const file = manifest.forward.find((unit: { file: string }) => unit.file.endsWith(suffix)).file;
      await db.query(readFileSync(file, "utf8"));
    }
    await db.query("UPDATE public.price_lists SET amount_basis='tax_exclusive' WHERE id=$1", [legacy.priceListId]);
    await fresh();
    const beforeReplay = await priceSnapshot(db);
    expect(Buffer.from(await raw(), "utf8")).toEqual(beforeUpgrade);
    expect(await apply(db, await command(db))).toEqual({ outcome: "validation_issue", reason: "catalog_price_setup_basis_mismatch" });
    expect(await priceSnapshot(db)).toEqual(beforeReplay);
    await db.query("COMMIT");
  } finally { await db.query("ROLLBACK"); db.release(); }
});
