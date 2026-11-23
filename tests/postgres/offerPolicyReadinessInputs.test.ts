import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { digestSubscriptionPricePolicy } from "@openlup/platform/pricing";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createPostgresPurchaseRenewalWriter, createPostgresRenewalStore, createNativeRenewalCodec,
  createPostgresPackageEditReadPort } from "@openlup/platform/subscriptions";
import { captureSandboxPurchase, createHistoricalPurchaseDraft } from "../helpers/captureSandboxPurchase.js";
import { journeyCensus } from "../helpers/storeJourney.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const path = "db/platform/migrations/20261122170000_offer_policy_readiness_inputs.sql";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const containers: PostgresContainer[] = [], pools: Pool[] = [];
let owner: Pool, populated: Pool, lostCohort: Pool;
let legacyIds: string[];
let genuine: { subscriptionId: string; next: string };
let continuityBefore: Awaited<ReturnType<typeof journeyCensus>>;
const rpc = async (db: Pool | PoolClient, name: string, values: unknown[] = []) =>
  (await db.query(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS value`, values)).rows[0].value;
const refusal = async (work: Promise<unknown>, message: string) => expect(work).rejects.toMatchObject({ message, code: "55000" });
async function transaction(work: (db: PoolClient) => Promise<void>) {
  const db = await owner.connect();
  try { await db.query("BEGIN"); await work(db); } finally { await db.query("ROLLBACK"); db.release(); }
}
const promotion = {
  id: "example:acquisition", status: "active", trigger_type: "automatic", code: null,
  discount_type: "percentage", discount_value: 50, applies_to_kind: "order_total",
  applies_to_payload: { cart_mode: "subscription", acquisitionTerms: { schemaVersion: "subscription-acquisition.v1", revision: "example:terms-1", delivery2DiscountBps: 3500 } },
  stacking_rule: "exclusive", eligibility: { first_subscription_purchase: true },
  valid_from: "2020-01-01T00:00:00.000Z", valid_to: null, redemption_limit_global: null,
  redemption_limit_per_customer: 1, region_availability: ["ZZ"], promotion_engine_version: "promotion-engine.v2",
  benefit_lane: "product", benefit_kind: "target_percentage", benefit_value_bps: 5000, benefit_value_minor: null, v2_mirror_of: null,
};

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Offer-policy inputs require real PostgreSQL");
  const container = await runPostgresContainer({ name: `offer-policy-inputs-${process.pid}`, password: "synthetic-inputs" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Offer-policy PostgreSQL unavailable");
  owner = new Pool({ connectionString: container.connectionString }); pools.push(owner);
  await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT NOBYPASSRLS");
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === path) break;
    await owner.query(readFileSync(unit.file, "utf8"));
  }
  await owner.query(readFileSync(path, "utf8"));
  const populatedContainer = await runPostgresContainer({ name: `offer-policy-populated-${process.pid}`, password: "synthetic-inputs" });
  containers.push(populatedContainer);
  if (!await waitForPostgresTcpReady(populatedContainer.connectionString)) throw new Error("Populated PostgreSQL unavailable");
  populated = new Pool({ connectionString: populatedContainer.connectionString }); pools.push(populated);
  await populated.query("CREATE ROLE service_role NOLOGIN NOINHERIT NOBYPASSRLS");
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === path) break;
    await populated.query(readFileSync(unit.file, "utf8"));
  }
  const lossContainer = await runPostgresContainer({ name: `offer-policy-loss-${process.pid}`, password: "synthetic-inputs" });
  containers.push(lossContainer);
  if (!await waitForPostgresTcpReady(lossContainer.connectionString)) throw new Error("Loss-case PostgreSQL unavailable");
  lostCohort = new Pool({ connectionString: lossContainer.connectionString }); pools.push(lostCohort);
  await lostCohort.query("CREATE ROLE service_role NOLOGIN NOINHERIT NOBYPASSRLS");
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === path) break;
    await lostCohort.query(readFileSync(unit.file, "utf8"));
  }
  const lossClient = (await lostCohort.query("INSERT INTO public.clients(email) VALUES('lost-cohort@example.invalid') RETURNING id")).rows[0].id;
  await lostCohort.query("INSERT INTO public.subscriptions(client_id,cadence_days) VALUES($1,28)", [lossClient]);
  await lostCohort.query(readFileSync(path, "utf8"));
  const client = (await populated.query("INSERT INTO public.clients(email) VALUES('cohort@example.invalid') RETURNING id")).rows[0].id;
  legacyIds = [];
  for (const status of ["active", "paused", "cancelled"]) {
    legacyIds.push((await populated.query("INSERT INTO public.subscriptions(client_id,status,cadence_days,next_cycle_at) VALUES($1,$2,28,clock_timestamp()+interval '28 days') RETURNING id", [client, status])).rows[0].id);
  }
  genuine = await genuinePurchase(populated);
  legacyIds.push(genuine.subscriptionId);
  continuityBefore = await journeyCensus(populated);
  const before = (await populated.query("SELECT to_jsonb(s) AS value FROM public.subscriptions s ORDER BY id")).rows;
  await populated.query(readFileSync(path, "utf8"));
  expect((await populated.query("SELECT to_jsonb(s)-'offer_policy_version'-'promotion_engine_version'-'offer_policy_assignment_state'-'is_test_fixture' AS value FROM public.subscriptions s ORDER BY id")).rows).toEqual(before);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);

it("never_populated_zero_baseline_is_an_audited_insert_once_delta", async () => transaction(async db => {
  expect((await db.query("SELECT marked_count,marked_fingerprint FROM public.commerce_offer_policy_cohort_marking")).rows)
    .toEqual([{ marked_count: 0, marked_fingerprint: "d41d8cd98f00b204e9800998ecf8427e" }]);
  expect((await db.query("SELECT * FROM public.commerce_offer_policy_rollout_baselines")).rows).toEqual([]);
  const captured = await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline");
  expect(captured).toMatchObject({ created: true, expectedCount: 0 });
  expect(await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline")).toEqual({ ...captured, created: false });
  expect(await rpc(db, "catalog_price_setup_cohort_evidence")).toMatchObject({ count: 0 });
}));

it("missing_marking_provenance_never_means_audited_zero", async () => transaction(async db => {
  await db.query("DELETE FROM public.commerce_offer_policy_cohort_marking");
  await expect(rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline")).rejects.toMatchObject({ message: "offer_policy_legacy_baseline_empty", code: "22023" });
}));

it("populated_marking_becoming_empty_keeps_the_original_empty_raise", async () => {
  const db = await lostCohort.connect();
  try {
    await db.query("BEGIN"); await db.query("DELETE FROM public.subscriptions");
    await expect(rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline")).rejects.toMatchObject({ message: "offer_policy_legacy_baseline_empty", code: "22023" });
  } finally { await db.query("ROLLBACK"); db.release(); }
});

const scalarCases = Object.entries(promotion).filter(([key]) => key !== "id" && !["code", "valid_to", "redemption_limit_global", "redemption_limit_per_customer", "benefit_lane", "benefit_kind", "benefit_value_bps", "benefit_value_minor", "v2_mirror_of"].includes(key));
it.each(scalarCases)("promotion required input %s refuses omission before filtering", async (key) => {
  const value: Record<string, unknown> = structuredClone(promotion); delete value[key];
  await refusal(rpc(owner, "catalog_price_setup_assert_promotion", [value, promotion.id]), "catalog_price_setup_native_promotion_domain_unverified");
});
it.each(scalarCases.filter(([, value]) => value !== null && typeof value !== "object"))("promotion required scalar %s refuses JSON null", async (key) => {
  await refusal(rpc(owner, "catalog_price_setup_assert_promotion", [{ ...promotion, [key]: null }, promotion.id]), "catalog_price_setup_native_promotion_domain_unverified");
});
it.each([
  ["omitted discount value", { discount_value: undefined }], ["wrong discount type", { discount_value: "50" }],
  ["negative discount", { discount_value: -1 }], ["wrong engine type", { promotion_engine_version: 2 }],
  ["fractional limit", { redemption_limit_global: 1.5 }], ["overflow limit", { redemption_limit_global: 2147483648 }],
  ["zero limit", { redemption_limit_global: 0 }], ["array member type", { region_availability: [1] }],
  ["invalid time", { valid_from: "invalid" }], ["reversed window", { valid_to: "2019-01-01T00:00:00.000Z" }],
  ["code coupling", { code: "EXAMPLE" }], ["benefit coupling", { benefit_value_minor: 1 }],
  ["wrong mirror type", { v2_mirror_of: 42 }], ["wrong ID type", { id: 123 }],
] as const)("promotion_domain_refuses_%s", async (_label, delta) => {
  await refusal(rpc(owner, "catalog_price_setup_assert_promotion", [{ ...promotion, ...delta }, promotion.id]), "catalog_price_setup_native_promotion_domain_unverified");
});
it("source_nullable_checks_preserve_SQL_unknown_and_JSON_null", async () => {
  await rpc(owner, "catalog_price_setup_assert_promotion", [{ ...promotion, benefit_kind: null, benefit_lane: null, benefit_value_bps: null, eligibility: null, applies_to_payload: null }, promotion.id]);
});

it.each([
  ["v1 pair", "commerce.offer-policy.v1", "promotion-engine.v1", true],
  ["v2 pair", "commerce.offer-policy.v2", "promotion-engine.v2", true],
  ["missing pair", undefined, undefined, true], ["JSON null fallbacks", null, null, true],
  ["missing side v2", undefined, "promotion-engine.v2", false], ["mixed", "commerce.offer-policy.v1", "promotion-engine.v2", false],
  ["empty", "", "", false], ["unsupported", "unknown", "unknown", false],
] as const)("order_policy_pair_%s_without_subscription_link", async (_label, offerPolicyVersion, promotionEngineVersion, valid) => {
  const operation = rpc(owner, "catalog_price_setup_order_policy_pair", [{ quoteSnapshot: { quote: { context: { pricingPolicy: { offerPolicyVersion, promotionEngineVersion } } } } }]);
  if (valid) await operation; else await refusal(operation, "catalog_price_setup_native_order_policy_pair_unverified");
});

it("marking_preserves_all_statuses_and_future_inserts_default_pending", async () => {
  expect((await populated.query("SELECT offer_policy_version,promotion_engine_version,offer_policy_assignment_state,is_test_fixture FROM public.subscriptions")).rows)
    .toEqual(legacyIds.map(() => ({ offer_policy_version: "commerce.offer-policy.v1", promotion_engine_version: "promotion-engine.v1", offer_policy_assignment_state: "legacy_frozen", is_test_fixture: false })));
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    const row = (await db.query("INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at) SELECT client_id,28,clock_timestamp()+interval '28 days' FROM public.subscriptions LIMIT 1 RETURNING offer_policy_assignment_state")).rows[0];
    expect(row).toEqual({ offer_policy_assignment_state: "pending_acquisition" });
    const value = await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline");
    expect(value).toMatchObject({ expectedCount: legacyIds.length, created: true });
    expect((await db.query("SELECT marked_count FROM public.commerce_offer_policy_cohort_marking")).rows[0].marked_count).toBe(legacyIds.length);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("capture_concurrency_returns_the_original_without_overwrite", async () => {
  const [a, b] = await Promise.all([populated.connect(), populated.connect()]);
  try {
    const values = await Promise.all([rpc(a, "commerce_capture_offer_policy_v2_legacy_baseline"), rpc(b, "commerce_capture_offer_policy_v2_legacy_baseline")]);
    expect(values.map(v => v.created).sort()).toEqual([false, true]);
    expect({ ...values[0], created: false }).toEqual({ ...values[1], created: false });
    expect(values[0].expectedCount).toBe(legacyIds.length);
    expect(await rpc(a, "catalog_price_setup_cohort_evidence")).toMatchObject({ count: legacyIds.length, fingerprint: values[0].expectedFingerprint });
  } finally { a.release(); b.release(); await populated.query("DELETE FROM public.commerce_offer_policy_rollout_baselines"); }
});

it.each(["addition", "removal", "same-count ID substitution"])("cohort_membership_drift_refuses_%s", async change => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN"); const captured = await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline");
    if (change === "addition") await db.query("INSERT INTO public.subscriptions(client_id,cadence_days,offer_policy_assignment_state) SELECT client_id,28,'legacy_frozen' FROM public.subscriptions LIMIT 1");
    else if (change === "removal") await db.query("DELETE FROM public.subscriptions WHERE id=$1", [legacyIds[0]]);
    else await db.query("UPDATE public.subscriptions SET id=$2 WHERE id=$1", [legacyIds[0], randomUUID()]);
    expect(await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline")).toEqual({ ...captured, created: false });
    await refusal(rpc(db, "catalog_price_setup_cohort_evidence"), "catalog_price_setup_native_cohort_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("positive_baseline_is_never_converted_to_zero", async () => {
  const db = await lostCohort.connect();
  try {
    await db.query("BEGIN"); await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline");
    await db.query("DELETE FROM public.subscriptions");
    await expect(rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline")).rejects.toMatchObject({ message: "offer_policy_legacy_baseline_empty", code: "22023" });
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it.each(["offer_policy_version", "promotion_engine_version", "offer_policy_assignment_state", "is_test_fixture"])("cohort_evidence_%s_is_immutable", async column => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    const value = column === "is_test_fixture" ? true : column === "offer_policy_version" ? "commerce.offer-policy.v2" : column === "promotion_engine_version" ? "promotion-engine.v2" : "pending_acquisition";
    await expect(db.query(`UPDATE public.subscriptions SET ${column}=$1 WHERE id=$2`, [value, legacyIds[0]]))
      .rejects.toMatchObject({ message: "subscription_offer_policy_immutable", code: "23514" });
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("baseline_service_SELECT_INSERT_and_capture_preserve_RLS", async () => transaction(async db => {
  await db.query("SET LOCAL ROLE service_role");
  expect((await db.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  expect((await db.query("SELECT row_security_active('public.commerce_offer_policy_rollout_baselines') AS active")).rows[0].active).toBe(true);
  await db.query("INSERT INTO public.commerce_offer_policy_rollout_baselines(baseline_key,expected_count,expected_fingerprint) VALUES('legacy_frozen.v1',0,md5(''))");
  expect((await db.query("SELECT expected_count FROM public.commerce_offer_policy_rollout_baselines")).rows[0].expected_count).toBe(0);
  expect(await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline")).toMatchObject({ created: false, expectedCount: 0 });
}));

it.each([
  "UPDATE public.commerce_offer_policy_rollout_baselines SET expected_count=2",
  "DELETE FROM public.commerce_offer_policy_rollout_baselines",
  "UPDATE public.commerce_offer_policy_cohort_marking SET marked_count=2",
  "DELETE FROM public.commerce_offer_policy_cohort_marking",
  "INSERT INTO public.commerce_offer_policy_cohort_marking VALUES('legacy_frozen.v1',now(),0,md5(''))",
])("ordinary_service_cannot_mutate_audit_evidence: %s", async sql => transaction(async db => {
  await db.query("SET LOCAL ROLE service_role"); await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
}));

it.each(["anon", "authenticated"])("browser_%s_cannot_capture_or_read_baselines", async role => transaction(async db => {
  await db.query(`SET LOCAL ROLE ${role}`);
  await expect(rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline")).rejects.toMatchObject({ code: "42501" });
}));

it("direct_zero_insert_enforces_the_same_marking_provenance", async () => transaction(async db => {
  await db.query("DELETE FROM public.commerce_offer_policy_cohort_marking");
  await db.query("SET LOCAL ROLE service_role");
  await expect(db.query("INSERT INTO public.commerce_offer_policy_rollout_baselines(baseline_key,expected_count,expected_fingerprint) VALUES('legacy_frozen.v1',0,md5(''))"))
    .rejects.toMatchObject({ code: "22023", message: "offer_policy_legacy_baseline_empty" });
}));

it.each([null, "zz", "Z", "ZZZ", "12"])("settlement_region_refuses_%s_before_selection", async region => transaction(async db => {
  await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region',$1) ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text", [region]);
  await refusal(rpc(db, "catalog_price_setup_region_code"), "catalog_price_setup_settlement_context_unverified");
}));
it("settlement_region_requires_actual_evidence_and_accepts_two_uppercase_letters", async () => transaction(async db => {
  await db.query("DELETE FROM public.commerce_settings WHERE key='settlement_region'");
  await db.query("SAVEPOINT missing_region");
  await refusal(rpc(db, "catalog_price_setup_region_code"), "catalog_price_setup_settlement_context_unverified");
  await db.query("ROLLBACK TO SAVEPOINT missing_region");
  await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ')");
  expect(await rpc(db, "catalog_price_setup_region_code")).toBe("ZZ");
}));

async function setContext(db: PoolClient) {
  await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
}
async function insertPromotion(db: PoolClient, delta: Record<string, unknown> = {}) {
  const from = (await db.query("SELECT to_char((statement_timestamp()-interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS value")).rows[0].value;
  const value = { ...promotion, valid_from: from, ...delta };
  await db.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,definition_fingerprint,active) VALUES($1,$2,repeat('0',64),true)", [value.id, value]);
  return value;
}

it("acquisition_standalone_uses_actual_native_definition", async () => transaction(async db => {
  await setContext(db); await insertPromotion(db);
  expect(await rpc(db, "catalog_price_setup_acquisition_terms", [(await db.query("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value]))
    .toMatchObject({ sourcePromotionId: promotion.id, kind: "v2_standalone", initialDiscountBps: 5000, delivery2DiscountBps: 3500 });
}));
it("acquisition_legacy_pair_preserves_financial_meaning", async () => transaction(async db => {
  await setContext(db);
  const terms = { schemaVersion: "subscription-acquisition.v1", revision: "legacy-50-35", delivery2DiscountBps: 3500 };
  const payload = { cart_mode: "subscription", acquisitionTerms: terms };
  const legacy = await insertPromotion(db, { id: "example:legacy", promotion_engine_version: "promotion-engine.v1", discount_value: 44.404,
    benefit_kind: "percentage", benefit_value_bps: null, applies_to_payload: payload });
  await insertPromotion(db, { id: "example:mirror", v2_mirror_of: legacy.id, applies_to_payload: payload, valid_from: legacy.valid_from });
  expect(await rpc(db, "catalog_price_setup_acquisition_terms", [(await db.query("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value]))
    .toMatchObject({ kind: "legacy_pair", legacyPairCount: 1, standaloneCount: 0, initialDiscountBps: 5000, delivery2DiscountBps: 3500 });
}));
it.each([
  ["mirror mismatch", { id: "example:mirror", v2_mirror_of: promotion.id, discount_value: 49, benefit_value_bps: 4900 }, "acquisition_terms_invalid"],
  ["duplicate revision", { id: "example:duplicate" }, "acquisition_terms_ambiguous"],
  ["overlap", { id: "example:overlap", applies_to_payload: { cart_mode: "subscription", acquisitionTerms: { ...promotion.applies_to_payload.acquisitionTerms, revision: "example:terms-2" } } }, "acquisition_terms_ambiguous"],
] as const)("acquisition_refuses_%s", async (_label, delta, reason) => transaction(async db => {
  await setContext(db); const original = await insertPromotion(db); await insertPromotion(db, { ...delta, valid_from: original.valid_from });
  await expect(rpc(db, "catalog_price_setup_acquisition_terms", [(await db.query("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value])).rejects.toMatchObject({ message: reason });
}));
it.each(["gap", "future", "ended"])("acquisition_refuses_%s_schedule", async mode => transaction(async db => {
  await setContext(db);
  const clock = (await db.query("SELECT statement_timestamp() AS now,statement_timestamp()+interval '1 hour' AS later,statement_timestamp()+interval '2 hours' AS latest")).rows[0];
  const iso = (value: Date) => value.toISOString();
  if (mode === "future") await insertPromotion(db, { valid_from: iso(clock.later) });
  else if (mode === "ended") await insertPromotion(db, { valid_to: iso(clock.now) });
  else {
    await insertPromotion(db, { valid_to: iso(clock.later) });
    await insertPromotion(db, { id: "example:future", valid_from: iso(clock.latest), applies_to_payload: { cart_mode: "subscription", acquisitionTerms: { ...promotion.applies_to_payload.acquisitionTerms, revision: "example:terms-2" } } });
  }
  await expect(rpc(db, "catalog_price_setup_acquisition_terms", [clock.now])).rejects.toMatchObject({ message: "acquisition_terms_not_effective", code: "55000" });
}));
it.each([
  ["orphan mirror", { v2_mirror_of: "example:absent" }],
  ["duplicate mirror", { id: "example:mirror-2", v2_mirror_of: "example:parent" }],
  ["duplicate code", { id: "example:coupon-2", trigger_type: "coupon_code", code: "EXAMPLE", promotion_engine_version: "promotion-engine.v1", benefit_kind: "percentage", benefit_value_bps: 5000 }],
] as const)("promotion_links_refuse_%s", async (label, delta) => transaction(async db => {
  if (label === "duplicate mirror") {
    await insertPromotion(db, { id: "example:parent" });
    await insertPromotion(db, { id: "example:mirror-1", v2_mirror_of: "example:parent" });
  } else if (label === "duplicate code") await insertPromotion(db, { ...delta, id: "example:coupon-1" });
  await insertPromotion(db, delta);
  await refusal(rpc(db, "catalog_price_setup_assert_promotion_links"), "catalog_price_setup_native_promotion_domain_unverified");
}));

const bundle = { ...promotion, id: "example:bundle", promotion_engine_version: "promotion-engine.v1", discount_value: 5,
  applies_to_payload: { cart_mode: "one_time" }, stacking_rule: "stackable_with_any", eligibility: { min_cart_minor: 12000 },
  benefit_kind: "percentage", benefit_value_bps: 500, redemption_limit_per_customer: null };
it.each([
  ["engine", { promotion_engine_version: "promotion-engine.v2" }], ["mirror", { v2_mirror_of: "example:parent" }],
  ["trigger", { trigger_type: "referral" }], ["code", { trigger_type: "coupon_code", code: "EXAMPLE" }],
  ["discount type", { discount_type: "fixed_amount" }], ["discount value", { discount_value: 4 }],
  ["scope", { applies_to_kind: "line_with_variant" }], ["payload", { applies_to_payload: { cart_mode: "subscription" } }],
  ["stacking", { stacking_rule: "exclusive" }], ["eligibility", { eligibility: { min_cart_minor: 11999 } }],
  ["status", { status: "paused" }], ["lane", { benefit_lane: "shipping" }], ["kind", { benefit_kind: "target_percentage" }],
  ["benefit value", { benefit_value_bps: 400 }], ["global limit", { redemption_limit_global: 1 }],
  ["customer limit", { redemption_limit_per_customer: 1 }], ["region", { region_availability: ["YY"] }],
] as const)("bundle_predicate_%s_is_required", async (_label, delta) => transaction(async db => {
  await setContext(db); await insertPromotion(db, { id: "example:parent" });
  await insertPromotion(db, { ...bundle, ...delta });
  expect(await rpc(db, "catalog_price_setup_bundle_policy_count", [(await db.query("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value])).toBe("0");
}));
it("bundle_end_boundary_remains_inclusive_and_native_active_is_required", async () => transaction(async db => {
  await setContext(db); const at = (await db.query("SELECT date_trunc('milliseconds',statement_timestamp()) AS value")).rows[0].value;
  await insertPromotion(db, { ...bundle, valid_to: at.toISOString() });
  expect(await rpc(db, "catalog_price_setup_bundle_policy_count", [at])).toBe("1");
  await db.query("UPDATE public.commerce_promotion_definitions SET active=false");
  expect(await rpc(db, "catalog_price_setup_bundle_policy_count", [at])).toBe("0");
}));
it.each([
  ["absent", {}, "classic"], ["JSON null", { quote: { context: { offerVersion: null } } }, "classic"],
  ["classic", { quote: { context: { offerVersion: "classic" } } }, "classic"],
  ["sized", { quote: { context: { offerVersion: "sized.v1" } } }, "sized.v1"],
] as const)("order_acquisition_parser_%s", async (_label, snapshot, expected) => {
  expect(await rpc(owner, "catalog_price_setup_order_offer_version", [snapshot])).toBe(expected);
});
it.each(["unknown", "", 1, true, [], {}])("order_acquisition_parser_refuses_%j", async offerVersion => {
  await refusal(rpc(owner, "catalog_price_setup_order_offer_version", [{ quote: { context: { offerVersion } } }]), "catalog_price_setup_native_order_admission_unverified");
});

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
    shippingAmountMinor: 0, acquisitionRef: "example:acquisition" });
  const activation = await rpc(db, "subscription_activate_from_captured_payment", [`activate:${order}`, order, createHash("sha256").update(reference).digest("hex")]);
  await writer.complete(order);
  const next = (await db.query("SELECT to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value FROM public.subscriptions WHERE id=$1", [activation.subscriptionId])).rows[0].value;
  return { subscriptionId: activation.subscriptionId, next };
}

it("installation_and_audited_capture_preserve_complete_subscription_continuity", async () => {
  const after = await journeyCensus(populated);
  delete after.commerce_offer_policy_cohort_marking; delete after.commerce_offer_policy_rollout_baselines;
  after.subscriptions = after.subscriptions.map(row => {
    const value = JSON.parse(row);
    for (const key of ["offer_policy_version", "promotion_engine_version", "offer_policy_assignment_state", "is_test_fixture"]) delete value[key];
    return JSON.stringify(value);
  }).sort();
  const normalized = Object.fromEntries(Object.entries(continuityBefore).map(([table, rows]) => [table, rows.map(row => JSON.stringify(JSON.parse(row))).sort()]));
  expect(Object.fromEntries(Object.entries(after).map(([table, rows]) => [table, rows.map(row => JSON.stringify(JSON.parse(row))).sort()]))).toEqual(normalized);
  const db = await populated.connect();
  try {
    await db.query("BEGIN"); await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline");
    // Missing agreement context in the other legacy rows remains a hard refusal.
    // This does not allow those rows to borrow the genuine subscriber's proof.
    const saved = await journeyCensus(populated);
    const edit = await createPostgresPackageEditReadPort(db).readLines(genuine.subscriptionId);
    expect(edit).toEqual([expect.objectContaining({ quantity: 2, frozenLineSubtotalGross: { amountMinor: 274, currency: "XXX" } })]);
    const renewal = createPostgresRenewalStore(db, createNativeRenewalCodec());
    const frozen = await renewal.buildCycleSnapshots({ subscriptionId: genuine.subscriptionId, scheduledAt: genuine.next, scheduledInstant: Date.parse(genuine.next) });
    expect(frozen).toMatchObject({ pricingSnapshot: { currency: "XXX", totalAmountMinor: 274 } });
    expect(await journeyCensus(populated)).toEqual(saved);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

async function orderInput(db: PoolClient, metadata: Record<string, unknown> = {}, renewal = false) {
  let cycle: string | null = null;
  if (renewal) {
    const client = (await db.query("INSERT INTO public.clients(email) VALUES('renewal-input@example.invalid') RETURNING id")).rows[0].id;
    const subscription = (await db.query("INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at) VALUES($1,28,statement_timestamp()+interval '28 days') RETURNING id", [client])).rows[0].id;
    cycle = (await db.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at) SELECT id,next_cycle_at FROM public.subscriptions WHERE id=$1 RETURNING id", [subscription])).rows[0].id;
  }
  const id = (await db.query("INSERT INTO public.commerce_orders(status,currency_code,total_amount_minor,metadata,subscription_cycle_id) VALUES('paid','XXX',100,$1,$2) RETURNING id", [metadata, cycle])).rows[0].id;
  await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)", [id]);
  return id;
}
it("order_financial_inputs_validate_actual_integer_money", async () => transaction(async db => {
  const id = await orderInput(db);
  expect(await rpc(db, "catalog_price_setup_order_inputs", [id])).toMatchObject({ currency: "XXX", subtotal: 100, discount: 0, shipping: 0, shippingDiscount: 0, total: 100 });
}));
it("order_financial_allocations_count_product_discount_once", async () => transaction(async db => {
  const id = await orderInput(db);
  const product = await insertPromotion(db);
  const shipping = await insertPromotion(db, { id: "example:shipping" });
  await db.query("UPDATE public.commerce_order_items SET source_line_ordinal=1,catalog_unit_amount_minor=120,catalog_line_amount_minor=120,promotion_discount_allocated_minor=20,promotion_allocation_fingerprint=repeat('a',64) WHERE order_id=$1", [id]);
  await db.query("INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint) VALUES($1,'promotion_discount','order_total',20,$2,repeat('a',64)),($1,'shipping_charge','shipping',30,NULL,NULL),($1,'promotion_discount','shipping',10,$3,repeat('a',64))", [id, product.id, shipping.id]);
  await db.query("UPDATE public.commerce_orders SET total_amount_minor=120 WHERE id=$1", [id]);
  expect(await rpc(db, "catalog_price_setup_order_inputs", [id])).toMatchObject({ subtotal: 120, discount: 20, shipping: 30, shippingDiscount: 10, total: 120 });
}));
it.each([
  ["missing currency", "UPDATE public.commerce_orders SET currency_code=NULL,total_amount_minor=NULL WHERE id=$1"],
  ["overflow total", "UPDATE public.commerce_orders SET total_amount_minor=2147483648 WHERE id=$1"],
  ["wrong equation", "UPDATE public.commerce_orders SET total_amount_minor=101 WHERE id=$1"],
  ["partial allocation", "UPDATE public.commerce_order_items SET catalog_line_amount_minor=100 WHERE order_id=$1"],
] as const)("order_domain_refuses_%s", async (_label, sql) => transaction(async db => {
  const id = await orderInput(db); await db.query(sql, [id]);
  await refusal(rpc(db, "catalog_price_setup_order_inputs", [id]), "catalog_price_setup_native_order_domain_unverified");
}));
it.each([false, true])("unknown_historical_admission_refuses_classic_or_renewal_%s_without_reparsing", async renewal => transaction(async db => {
  await orderInput(db, { quoteSnapshot: { quote: { context: { offerVersion: renewal ? "unsupported-renewal-token" : "classic", offerEvidence: { catalogPublication: { protocol: "v3", headDigest: "a".repeat(64) } } } } } }, renewal);
  await refusal(rpc(db, "catalog_price_setup_assert_order_guards", [(await db.query("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value]), "catalog_price_setup_native_order_admission_unverified");
}));
it("malformed_order_pair_refuses_before_engine_filter_and_missing_financial_inputs", async () => transaction(async db => {
  await db.query("INSERT INTO public.commerce_orders(status,metadata) VALUES('paid',$1)", [{ quoteSnapshot: { quote: { context: { pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v2" } } } } }]);
  await refusal(rpc(db, "catalog_price_setup_assert_order_guards", [(await db.query("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value]), "catalog_price_setup_native_order_policy_pair_unverified");
}));
it("qualifying_frozen_order_guard_is_not_inferred_from_item_consistency", async () => transaction(async db => {
  await orderInput(db, { quoteSnapshot: { quote: { context: { pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" } } } } });
  await refusal(rpc(db, "catalog_price_setup_assert_order_guards", [(await db.query("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value]), "catalog_price_setup_native_order_guard_unverified");
}));
it("hard_input_failure_is_independent_of_unchanged_ordinary_readiness_reasons", async () => transaction(async db => {
  await setContext(db); await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline");
  expect(await rpc(db, "catalog_price_setup_readiness_inputs")).toMatchObject({ acquisitionReason: "acquisition_terms_not_effective", bundlePolicyCount: 0 });
  await orderInput(db);
  await refusal(rpc(db, "catalog_price_setup_readiness_inputs"), "catalog_price_setup_native_order_admission_unverified");
}));
it("missing_retained_agreement_evidence_never_borrows_another_subscriber_proof", async () => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    await acceptGenuineEdit(db);
    await refusal(rpc(db, "catalog_price_setup_agreement_evidence"), "catalog_price_setup_native_agreement_domain_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});

const nativeColumns = [
  [
    "commerce_settings",
    "key",
    "text",
    true
  ],
  [
    "commerce_settings",
    "value_text",
    "text",
    false
  ],
  [
    "price_lists",
    "created_at",
    "timestamptz",
    true
  ],
  [
    "price_lists",
    "currency",
    "text",
    true
  ],
  [
    "price_lists",
    "id",
    "uuid",
    true
  ],
  [
    "price_lists",
    "region_code",
    "text",
    true
  ],
  [
    "price_lists",
    "status",
    "text",
    true
  ],
  [
    "price_lists",
    "valid_from",
    "timestamptz",
    true
  ],
  [
    "price_lists",
    "valid_to",
    "timestamptz",
    false
  ],
  [
    "price_entries",
    "active",
    "boolean",
    true
  ],
  [
    "price_entries",
    "amount_kind",
    "text",
    true
  ],
  [
    "price_entries",
    "id",
    "uuid",
    true
  ],
  [
    "price_entries",
    "min_qty",
    "integer",
    true
  ],
  [
    "price_entries",
    "mode",
    "text",
    true
  ],
  [
    "price_entries",
    "price_list_id",
    "uuid",
    true
  ],
  [
    "price_entries",
    "unit_price_minor",
    "integer",
    true
  ],
  [
    "price_entries",
    "valid_from",
    "timestamptz",
    true
  ],
  [
    "price_entries",
    "valid_to",
    "timestamptz",
    false
  ],
  [
    "price_entries",
    "variant_id",
    "uuid",
    true
  ],
  [
    "catalog_skus",
    "id",
    "uuid",
    true
  ],
  [
    "catalog_skus",
    "is_addon",
    "boolean",
    true
  ],
  [
    "catalog_skus",
    "sellable_in_subscription",
    "boolean",
    true
  ],
  [
    "catalog_skus",
    "sellable_standalone",
    "boolean",
    true
  ],
  [
    "catalog_skus",
    "status",
    "text",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "channel",
    "text",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "currency",
    "text",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "digest",
    "text",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "discount_bps",
    "integer",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "effective_from",
    "timestamptz",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "effective_to",
    "timestamptz",
    false
  ],
  [
    "subscription_price_policy_revisions",
    "id",
    "uuid",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "price_list_id",
    "uuid",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "region_code",
    "text",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "revision_no",
    "integer",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "rounding_quantum_minor",
    "integer",
    true
  ],
  [
    "subscription_price_policy_revisions",
    "rounding_rule",
    "text",
    true
  ],
  [
    "subscriptions",
    "currency_code",
    "text",
    false
  ],
  [
    "subscriptions",
    "id",
    "uuid",
    true
  ],
  [
    "subscriptions",
    "is_test_fixture",
    "boolean",
    true
  ],
  [
    "subscriptions",
    "offer_policy_assignment_state",
    "text",
    true
  ],
  [
    "subscriptions",
    "offer_policy_version",
    "text",
    true
  ],
  [
    "subscriptions",
    "promotion_engine_version",
    "text",
    true
  ],
  [
    "subscription_lines",
    "id",
    "uuid",
    true
  ],
  [
    "subscription_lines",
    "quantity",
    "integer",
    true
  ],
  [
    "subscription_lines",
    "subscription_id",
    "uuid",
    true
  ],
  [
    "commerce_offer_policy_rollout_baselines",
    "baseline_key",
    "text",
    true
  ],
  [
    "commerce_offer_policy_rollout_baselines",
    "captured_at",
    "timestamptz",
    true
  ],
  [
    "commerce_offer_policy_rollout_baselines",
    "expected_count",
    "integer",
    true
  ],
  [
    "commerce_offer_policy_rollout_baselines",
    "expected_fingerprint",
    "text",
    true
  ],
  [
    "platform_job_controls",
    "enabled",
    "boolean",
    true
  ],
  [
    "platform_job_controls",
    "job_name",
    "text",
    true
  ],
  [
    "platform_job_controls",
    "last_status",
    "text",
    false
  ],
  [
    "platform_job_controls",
    "last_success_at",
    "timestamptz",
    false
  ],
  [
    "platform_job_controls",
    "metadata",
    "jsonb",
    true
  ],
  [
    "commerce_orders",
    "created_at",
    "timestamptz",
    true
  ],
  [
    "commerce_orders",
    "currency_code",
    "text",
    false
  ],
  [
    "commerce_orders",
    "id",
    "uuid",
    true
  ],
  [
    "commerce_orders",
    "metadata",
    "jsonb",
    true
  ],
  [
    "commerce_orders",
    "status",
    "text",
    true
  ],
  [
    "commerce_orders",
    "total_amount_minor",
    "bigint",
    false
  ]
] as const;
it.each(nativeColumns)("native_input_column_%s.%s_preserves_type_and_presence", async (table, column, type, required) => {
  const result = (await owner.query("SELECT a.atttypid=$3::regtype AS typed,a.attnotnull AS required FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attname=$2 AND a.attnum>0 AND NOT a.attisdropped", [`public.${table}`, column, type])).rows;
  expect(result).toEqual([{ typed: true, required }]);
});

// Produce independent accepted-edit evidence through the existing service SQL route.
async function acceptGenuineEdit(db: PoolClient, action: "update_package_template" | "swap_base_line" = "update_package_template") {
  const row = (await db.query(`SELECT s.client_id,s.template_version,s.cadence_days,l.id AS line_id,l.variant_id,k.sku,k.product_id,p.price_list_id,p.unit_price_minor,
    to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
    to_char((statement_timestamp()+interval '15 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires
    FROM public.subscriptions s JOIN public.subscription_lines l ON l.subscription_id=s.id
    JOIN public.catalog_skus k ON k.id=l.variant_id JOIN public.price_entries p ON p.variant_id=k.id
    WHERE s.id=$1`, [genuine.subscriptionId])).rows[0];
  const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
  const fromVariantId = row.variant_id;
  if (action === "swap_base_line") {
    row.variant_id = randomUUID(); row.sku = `READINESS-SWAP-${row.variant_id}`;
    await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$2,$3,'Synthetic independent quote',true)", [row.variant_id, row.product_id, row.sku]);
    await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'any',$3,statement_timestamp()-interval '1 hour')", [row.price_list_id, row.variant_id, row.unit_price_minor]);
  }
  const base = [{ variantId: row.variant_id, qty: 2 }], addons: never[] = [];
  const baseLines = [{ ...base[0], quoteLine: { sku: row.sku, quantity: 2,
    unitPriceGross: money(Number(row.unit_price_minor)), lineSubtotalGross: money(2 * Number(row.unit_price_minor)) } }];
  const compositionConstraint = { kind: "plan_days", value: 56 };
  const request = action === "swap_base_line" ? { action, fromVariantId, toVariantId: row.variant_id }
    : { planDays: 56, nominalPlanDays: 56, base, addons, compositionConstraint };
  const snapshot = action === "swap_base_line"
    ? { lines: [{ ...baseLines[0], lineId: row.line_id, isAddon: false, sortOrder: 0 }], cadenceDays: row.cadence_days, compositionConstraint: null }
    : { baseLines, addonLines: [], compositionConstraint };
  const totals = { currentRecurringPrice: money(274), newRecurringPrice: money(274), delta: money(0) };
  const hash = createHash("sha256").update(JSON.stringify({ request, snapshot, totals })).digest("hex"), actor = randomUUID();
  await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','2') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
  await rpc(db, "subscription_quote_preview_record", [actor, row.client_id, genuine.subscriptionId, action,
    hash, row.template_version, row.expires, request, snapshot, totals, row.at]);
  const payload = { ...request, ...snapshot, ...totals, expectedTemplateVersion: row.template_version, acceptedQuoteHash: hash,
    request: { ...request, expectedTemplateVersion: row.template_version, acceptedQuoteHash: hash } };
  const values = [actor, row.client_id, randomUUID(), genuine.subscriptionId];
  expect(await rpc(db, action === "swap_base_line" ? "subscription_line_edit_apply" : "subscription_package_edit_apply",
    [...values, ...(action === "swap_base_line" ? [action] : []), payload, row.at])).toMatchObject({ status: "applied" });
}

it.each(["catalog_price_setup_agreement_evidence", "catalog_price_setup_readiness_inputs"] as const)("historical_activation_order_mixed_pair_refuses_before_quote_projection_%s", async entry => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    await db.query(`UPDATE public.commerce_orders SET created_at=statement_timestamp()-interval '48 hours',
      metadata=jsonb_set(metadata,'{quoteSnapshot,quote,context,pricingPolicy}',
      '{"offerPolicyVersion":"commerce.offer-policy.v1","promotionEngineVersion":"promotion-engine.v2"}')
      WHERE id=(SELECT order_id FROM public.subscription_activations WHERE subscription_id=$1)`, [genuine.subscriptionId]);
    await setContext(db);
    await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline");
    await refusal(rpc(db, entry), "catalog_price_setup_native_order_policy_pair_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("genuine_native_agreement_proof_is_read_without_synthetic_history", async () => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN"); await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    await acceptGenuineEdit(db);
    const proof = await rpc(db, "catalog_price_setup_agreement_evidence");
    expect(proof.fingerprint).toMatch(/^[a-f0-9]{32}$/u);
    expect(proof.fingerprint).not.toBe("d41d8cd98f00b204e9800998ecf8427e");
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it.each([
  ["missing currency", "UPDATE public.subscriptions SET currency_code=NULL,price_list_id=NULL WHERE id=$1"],
  ["int32 money overflow", "UPDATE public.subscription_lines SET unit_price_minor=2147483648 WHERE subscription_id=$1"],
  ["quantity mismatch", "UPDATE public.subscription_lines SET quantity=3 WHERE subscription_id=$1"],
  ["missing renewal binding", "DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1"],
  ["missing quote scalar", "UPDATE public.subscription_events SET payload=jsonb_set(payload,'{linePricing,0,quoteLine,unitPriceGross,amountMinor}','null') WHERE subscription_id=$1 AND event_type='subscription.customer_self_service.update_package_template'"],
] as const)("retained_agreement_refuses_%s", async (_label, sql) => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN"); await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    await acceptGenuineEdit(db);
    await db.query(sql, [genuine.subscriptionId]);
    await refusal(rpc(db, "catalog_price_setup_agreement_evidence"), "catalog_price_setup_native_agreement_domain_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it("price_entry_composite_duplicates_are_an_explicit_hard_refusal", async () => transaction(async db => {
  const id = randomUUID();
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1::uuid,($1::uuid)::text,'Synthetic')", [id]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1::uuid,$1::uuid,($1::uuid)::text,'Synthetic')", [id]);
  await db.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Synthetic','ZZ','XXX')", [id]);
  await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,valid_from) VALUES($1,$1,'one_time',1,100,statement_timestamp()),($1,$1,'one_time',1,200,statement_timestamp())", [id]);
  await refusal(rpc(db, "catalog_price_setup_assert_catalog_inputs"), "catalog_price_setup_native_price_domain_unverified");
}));
it.each([
  ["key", { baseline_key: "unknown" }], ["negative count", { expected_count: -1 }],
  ["fingerprint length", { expected_fingerprint: "a" }], ["fingerprint alphabet", { expected_fingerprint: "G".repeat(32) }],
  ["zero fingerprint", { expected_count: 0, expected_fingerprint: "a".repeat(32) }],
] as const)("baseline_storage_refuses_%s", async (_label, delta) => transaction(async db => {
  const value = { baseline_key: "legacy_frozen.v1", expected_count: 1, expected_fingerprint: "a".repeat(32), ...delta }; // gitleaks:allow -- public schema sentinel, not a credential
  await expect(db.query("INSERT INTO public.commerce_offer_policy_rollout_baselines(baseline_key,expected_count,expected_fingerprint) VALUES($1,$2,$3)", [value.baseline_key, value.expected_count, value.expected_fingerprint]))
    .rejects.toMatchObject({ code: "expected_count" in delta && delta.expected_count === 0 ? "22023" : "23514" });
}));
it("fixtures_are_explicit_legacy_only_and_excluded_without_reclassification", async () => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN"); const before = await rpc(db, "commerce_capture_offer_policy_v2_legacy_baseline");
    await db.query("INSERT INTO public.subscriptions(client_id,cadence_days,offer_policy_assignment_state,is_test_fixture) SELECT client_id,28,'legacy_frozen',true FROM public.subscriptions LIMIT 1");
    expect(await rpc(db, "catalog_price_setup_cohort_evidence")).toMatchObject({ count: before.expectedCount, fingerprint: before.expectedFingerprint });
    await expect(db.query("INSERT INTO public.subscriptions(client_id,cadence_days,is_test_fixture) SELECT client_id,28,true FROM public.subscriptions LIMIT 1")).rejects.toMatchObject({ code: "23514" });
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it("readiness_inputs_work_in_read_only_transaction_without_commerce_locks", async () => {
  await owner.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
  await rpc(owner, "commerce_capture_offer_policy_v2_legacy_baseline");
  const db = await owner.connect();
  try {
    await db.query("BEGIN READ ONLY");
    expect(await rpc(db, "catalog_price_setup_readiness_inputs")).toMatchObject({ cohort: { count: 0 }, acquisitionReason: "acquisition_terms_not_effective" });
    expect((await db.query("SELECT locktype FROM pg_locks WHERE pid=pg_backend_pid() AND locktype IN ('advisory','tuple')")).rows).toEqual([]);
  } finally {
    await db.query("ROLLBACK"); db.release();
    await owner.query("DELETE FROM public.commerce_offer_policy_rollout_baselines; DELETE FROM public.commerce_settings WHERE key IN ('settlement_region','settlement_currency')");
  }
});

it.each(Object.keys(promotion).filter(key => !["eligibility", "applies_to_payload"].includes(key)))("promotion_input_%s_refuses_wrong_scalar_or_array_type", async key => {
  await refusal(rpc(owner, "catalog_price_setup_assert_promotion", [{ ...promotion, [key]: {} }, promotion.id]), "catalog_price_setup_native_promotion_domain_unverified");
});
it.each(["now", "tomorrow", "2020-01-01T00:00:00"])("promotion_time_%s_has_no_unrecorded_clock_or_timezone_default", async valid_from => {
  await refusal(rpc(owner, "catalog_price_setup_assert_promotion", [{ ...promotion, valid_from }, promotion.id]), "catalog_price_setup_native_promotion_domain_unverified");
});
it.each([null, "xx", "XX", "XXXX", "123"])("settlement_currency_refuses_%s", async currency => transaction(async db => {
  await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_currency',$1) ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text", [currency]);
  await refusal(rpc(db, "catalog_price_setup_settlement_currency"), "catalog_price_setup_settlement_context_unverified");
}));
it("policy_digest_checks_actual_original_tuple_after_a_real_close", async () => transaction(async db => {
  const id = randomUUID(), list = randomUUID();
  const at = (await db.query("SELECT to_char(date_trunc('milliseconds',statement_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS value")).rows[0].value;
  await db.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Policy fixture','ZZ','XXX')", [list]);
  const tuple = { id, revisionNo: 1, priceListId: list, regionCode: "ZZ", currency: "XXX", channel: "D2C", effectiveFrom: at,
    effectiveTo: null, discountBps: 1000, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM" as const };
  const digest = await digestSubscriptionPricePolicy(tuple);
  await db.query("INSERT INTO public.subscription_price_policy_revisions(id,price_list_id,region_code,currency,channel,revision_no,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest) VALUES($1,$2,'ZZ','XXX','D2C',1,$3,1000,10,'FLOOR_TO_QUANTUM',$4)", [id, list, at, digest]);
  await rpc(db, "catalog_price_setup_assert_catalog_inputs");
  await db.query("UPDATE public.subscription_price_policy_revisions SET effective_to=effective_from+interval '1 hour' WHERE id=$1", [id]);
  expect((await db.query("SELECT closed_from_open,digest FROM public.subscription_price_policy_revisions WHERE id=$1", [id])).rows[0]).toEqual({ closed_from_open: true, digest });
  await rpc(db, "catalog_price_setup_assert_catalog_inputs");
}));
it("unverified_policy_tuple_is_a_hard_input_refusal", async () => transaction(async db => {
  const list = randomUUID();
  await db.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Policy fixture','ZZ','XXX')", [list]);
  await db.query("INSERT INTO public.subscription_price_policy_revisions(price_list_id,region_code,currency,channel,revision_no,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest) VALUES($1,'ZZ','XXX','D2C',1,statement_timestamp(),1000,10,'FLOOR_TO_QUANTUM',repeat('a',64))", [list]);
  await refusal(rpc(db, "catalog_price_setup_assert_catalog_inputs"), "catalog_price_setup_native_policy_domain_unverified");
}));

it.each([
  ["zero", { schemaVersion: "subscription-acquisition.v1", revision: "example:terms", delivery2DiscountBps: 0 }, true],
  ["upper bound", { schemaVersion: "subscription-acquisition.v1", revision: "example:terms", delivery2DiscountBps: 10000 }, true],
  ["missing", { revision: "example:terms" }, false], ["JSON null", null, false],
  ["wrong type", { schemaVersion: "subscription-acquisition.v1", revision: "example:terms", delivery2DiscountBps: "3500" }, false],
  ["fraction", { schemaVersion: "subscription-acquisition.v1", revision: "example:terms", delivery2DiscountBps: 0.5 }, false],
  ["negative", { schemaVersion: "subscription-acquisition.v1", revision: "example:terms", delivery2DiscountBps: -1 }, false],
  ["overflow", { schemaVersion: "subscription-acquisition.v1", revision: "example:terms", delivery2DiscountBps: 10001 }, false],
  ["unknown field", { schemaVersion: "subscription-acquisition.v1", revision: "example:terms", delivery2DiscountBps: 3500, extra: true }, false],
  ["empty revision", { schemaVersion: "subscription-acquisition.v1", revision: "", delivery2DiscountBps: 3500 }, false],
] as const)("native_SQL_metadata_golden_%s", async (_label, value, valid) => {
  const result = rpc(owner, "catalog_price_setup_acquisition_metadata", [{ acquisitionTerms: value }]);
  if (valid) expect(await result).toEqual(value);
  else await expect(result).rejects.toMatchObject({ message: "acquisition_terms_invalid", code: "22023" });
});
it("absent_acquisition_metadata_remains_distinct_from_JSON_null", async () => {
  expect(await rpc(owner, "catalog_price_setup_acquisition_metadata", [{ cart_mode: "subscription" }])).toBeNull();
});

it.each([
  ["explicit v1", "commerce.offer-policy.v1", "promotion-engine.v1"],
  ["explicit v2", "commerce.offer-policy.v2", "promotion-engine.v2"],
  ["individual missing fallbacks", undefined, undefined], ["individual null fallbacks", null, null],
] as const)("historical_valid_pair_%s_passes_before_unproven_admission_refusal", async (_label, offerPolicyVersion, promotionEngineVersion) => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    const metadata = { quoteSnapshot: { quote: { context: { pricingPolicy: { offerPolicyVersion, promotionEngineVersion } } } } };
    await db.query(`UPDATE public.commerce_orders SET created_at=statement_timestamp()-interval '48 hours',
      metadata=jsonb_set(metadata,'{quoteSnapshot,quote,context,pricingPolicy}',$2::jsonb)
      WHERE id=(SELECT order_id FROM public.subscription_activations WHERE subscription_id=$1)`, [genuine.subscriptionId, metadata.quoteSnapshot.quote.context.pricingPolicy]);
    expect(await rpc(db, "catalog_price_setup_order_policy_pair", [metadata])).toBe("");
    await refusal(rpc(db, "catalog_price_setup_agreement_evidence"), "catalog_price_setup_native_order_admission_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it.each([["older", 1], ["exact", 0], ["younger", -1]] as const)("governing_order_mixed_pair_refuses_at_24_hour_boundary_%s", async (_label, offset) => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    const at = (await db.query(`UPDATE public.commerce_orders SET created_at=statement_timestamp()-interval '48 hours',
      metadata=jsonb_set(metadata,'{quoteSnapshot,quote,context,pricingPolicy}',
      '{"offerPolicyVersion":"commerce.offer-policy.v1","promotionEngineVersion":"promotion-engine.v2"}')
      WHERE id=(SELECT order_id FROM public.subscription_activations WHERE subscription_id=$1)
      RETURNING to_char((created_at+interval '24 hours'+$2*interval '1 microsecond') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`, [genuine.subscriptionId, offset])).rows[0].at;
    await db.query("SAVEPOINT recent_guard");
    if (offset > 0) expect(await rpc(db, "catalog_price_setup_assert_order_guards", [at])).toBe("");
    else await refusal(rpc(db, "catalog_price_setup_assert_order_guards", [at]), "catalog_price_setup_native_order_policy_pair_unverified");
    await db.query("ROLLBACK TO SAVEPOINT recent_guard");
    await refusal(rpc(db, "catalog_price_setup_agreement_evidence"), "catalog_price_setup_native_order_policy_pair_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it.each([true, false])("retained_renewal_quote_checks_its_own_historical_order_before_projection_mixed_%s", async mixed => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    const order = await orderInput(db, { quoteSnapshot: { quote: { context: { pricingPolicy: {
      offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: mixed ? "promotion-engine.v2" : "promotion-engine.v1",
    } } } } });
    await db.query("UPDATE public.commerce_orders SET created_at=statement_timestamp()-interval '48 hours' WHERE id=$1", [order]);
    // Deliberately untrusted retained data cannot enable agreement success.
    await db.query(`UPDATE public.subscription_renewal_attachments SET order_id=$2,
      purchase_facts=jsonb_set(purchase_facts,'{renewalTerms}','{"linePricing":[]}') WHERE subscription_id=$1`, [genuine.subscriptionId, order]);
    await refusal(rpc(db, "catalog_price_setup_agreement_evidence"), mixed
      ? "catalog_price_setup_native_order_policy_pair_unverified" : "catalog_price_setup_native_order_admission_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});

const orderBackedEvents = [
  "subscription.starter_graduated",
  "subscription.customer_self_service.add_addon", "subscription.customer_self_service.remove_addon",
  "subscription.customer_self_service.update_addon_quantity", "subscription.customer_self_service.update_plan_length",
  "subscription.customer_self_service.update_base_mix", "subscription.customer_self_service.update_portion",
  "subscription.customer_self_service.resize_bundle", "subscription.customer_self_service.update_bundle",
] as const;
it.each(orderBackedEvents)("order_backed_event_%s_mixed_pair_refuses_before_projection", async eventType => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    await acceptGenuineEdit(db);
    // Adversarial input keeps matching quote lines; relabelling cannot establish independent provenance.
    await db.query("UPDATE public.subscription_events SET event_type=$2 WHERE subscription_id=$1 AND event_type='subscription.customer_self_service.update_package_template'", [genuine.subscriptionId, eventType]);
    await db.query(`UPDATE public.commerce_orders SET created_at=statement_timestamp()-interval '48 hours',
      metadata=jsonb_set(metadata,'{quoteSnapshot,quote,context,pricingPolicy}',
      '{"offerPolicyVersion":"commerce.offer-policy.v1","promotionEngineVersion":"promotion-engine.v2"}')
      WHERE id=(SELECT order_id FROM public.subscription_activations WHERE subscription_id=$1)`, [genuine.subscriptionId]);
    await refusal(rpc(db, "catalog_price_setup_agreement_evidence"), "catalog_price_setup_native_order_policy_pair_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it.each(["update_package_template", "swap_base_line"] as const)("independent_full_quote_%s_does_not_borrow_historical_order_evidence", async action => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    await acceptGenuineEdit(db, action);
    await db.query(`UPDATE public.commerce_orders SET created_at=statement_timestamp()-interval '48 hours',
      metadata=jsonb_set(metadata,'{quoteSnapshot,quote,context,pricingPolicy}',
      '{"offerPolicyVersion":"commerce.offer-policy.v1","promotionEngineVersion":"promotion-engine.v2"}')
      WHERE id=(SELECT order_id FROM public.subscription_activations WHERE subscription_id=$1)`, [genuine.subscriptionId]);
    expect((await rpc(db, "catalog_price_setup_agreement_evidence")).fingerprint).not.toBe("d41d8cd98f00b204e9800998ecf8427e");
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it.each(orderBackedEvents)("order_backed_event_%s_valid_pair_passes_but_missing_admission_refuses", async eventType => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    await acceptGenuineEdit(db);
    await db.query("UPDATE public.subscription_events SET event_type=$2 WHERE subscription_id=$1 AND event_type='subscription.customer_self_service.update_package_template'", [genuine.subscriptionId, eventType]);
    const metadata = (await db.query("SELECT metadata FROM public.commerce_orders WHERE id=(SELECT order_id FROM public.subscription_activations WHERE subscription_id=$1)", [genuine.subscriptionId])).rows[0].metadata;
    expect(await rpc(db, "catalog_price_setup_order_policy_pair", [metadata])).toBe("");
    await refusal(rpc(db, "catalog_price_setup_agreement_evidence"), "catalog_price_setup_native_order_admission_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it("starter_graduation_uses_the_retained_purchase_order_without_a_linePricing_field", async () => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    await acceptGenuineEdit(db);
    await db.query("UPDATE public.subscription_events SET event_type='subscription.starter_graduated' WHERE subscription_id=$1 AND event_type='subscription.customer_self_service.update_package_template'", [genuine.subscriptionId]);
    const order = await orderInput(db, { quoteSnapshot: { quote: { context: { pricingPolicy: {
      offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v2",
    } } } } });
    // This untrusted retained marker must be checked before its quote data can be projected.
    await db.query(`UPDATE public.subscription_renewal_attachments SET order_id=$2,
      purchase_facts=jsonb_set(purchase_facts,'{renewalTerms}','{"starterPack":{"graduation":{"lines":[]}}}') WHERE subscription_id=$1`, [genuine.subscriptionId, order]);
    await refusal(rpc(db, "catalog_price_setup_agreement_evidence"), "catalog_price_setup_native_order_policy_pair_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it("order_backed_event_without_a_governing_order_never_uses_its_linePricing", async () => {
  const db = await populated.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM public.subscriptions WHERE id=ANY($1::uuid[])", [legacyIds.filter(id => id !== genuine.subscriptionId)]);
    await acceptGenuineEdit(db);
    await db.query("UPDATE public.subscription_events SET event_type='subscription.starter_graduated' WHERE subscription_id=$1 AND event_type='subscription.customer_self_service.update_package_template'", [genuine.subscriptionId]);
    await db.query("DELETE FROM public.subscription_renewal_attachments WHERE subscription_id=$1", [genuine.subscriptionId]);
    await db.query("DELETE FROM public.subscription_activations WHERE subscription_id=$1", [genuine.subscriptionId]);
    await refusal(rpc(db, "catalog_price_setup_agreement_evidence"), "catalog_price_setup_native_order_admission_unverified");
  } finally { await db.query("ROLLBACK"); db.release(); }
});
it("recent_unattested_order_refuses_before_financial_projection", async () => transaction(async db => {
  await db.query("INSERT INTO public.commerce_orders(status,metadata) VALUES('paid','{}')");
  const at = (await db.query("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value;
  await refusal(rpc(db, "catalog_price_setup_assert_order_guards", [at]), "catalog_price_setup_native_order_admission_unverified");
}));
it("recent_order_claim_is_a_hard_refusal_not_agreement_or_admission_proof", async () => transaction(async db => {
  const order = await orderInput(db), promotion = await insertPromotion(db);
  const adjustment = (await db.query(`INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint)
    SELECT $1,'promotion_discount','order_total',10,promotion_id,definition_fingerprint FROM public.commerce_promotion_definitions WHERE promotion_id=$2 RETURNING id`, [order, promotion.id])).rows[0].id;
  await db.query(`INSERT INTO public.commerce_promotion_claims(promotion_id,definition_fingerprint,adjustment_id,order_id,amount_off_minor,reserved_at,expires_at)
    SELECT promotion_id,definition_fingerprint,$1,$2,10,statement_timestamp(),statement_timestamp()+interval '1 hour'
    FROM public.commerce_promotion_definitions WHERE promotion_id=$3`, [adjustment, order, promotion.id]);
  const at = (await db.query("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value")).rows[0].value;
  await refusal(rpc(db, "catalog_price_setup_assert_order_guards", [at]), "catalog_price_setup_native_order_claim_guard_unverified");
}));
