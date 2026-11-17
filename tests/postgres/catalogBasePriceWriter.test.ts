import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalCatalogPriceSetupCommand, createPostgresCatalogPriceSetupStore } from "@openlup/platform/pricing";
import { createPostgresNativeCheckoutPersistence } from "@openlup/platform/commerce/server/native-checkout";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createPostgresPurchaseRenewalWriter, createPostgresRenewalStore, createNativeRenewalCodec, createPostgresPackageEditReadPort } from "@openlup/platform/subscriptions";
import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { journeyCensus } from "../helpers/storeJourney.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const inputsPath = "db/platform/migrations/20261122170000_offer_policy_readiness_inputs.sql";
const writerPath = "db/platform/migrations/20261122180000_catalog_base_price_writer.sql";
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
  const result = await createPostgresNativeCheckoutPersistence(db).createOrderDraft({ idempotencyKey: `readiness:${randomUUID()}`,
    quoteSnapshot: { contractVersion: "commerce.v0", quote: { currency: "XXX", taxIncluded: true, lines: [line], discounts: [],
      context: { mode: "subscription", cadenceDays: 28, promoCodes: [] }, subtotalGross: money(274), discountTotalGross: money(0),
      shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(274), netTotal: money(274), taxTotal: money(0) } } }, { clientId: client });
  const order = result.orderDraft.orderId.replace(/^order_/, "");
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
  await owner.query(readFileSync("db/platform/migrations/20261122190000_catalog_publication.sql", "utf8"));
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
