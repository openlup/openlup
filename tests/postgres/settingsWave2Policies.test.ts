import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createPostgresProviderPaymentControlPort,
  installPaymentDeclineNoticeTimingPolicy,
  readPaymentDeclineNoticeTimingOverride,
  readPaymentDeclineNoticeTimingPolicy,
  validatePaymentDeclineNoticeTiming,
  type PaymentDeclineNoticeTimingPolicy,
} from "@openlup/platform/payments";
import {
  installSubscriptionRetrySchedulePolicy,
  readSubscriptionRetryScheduleOverride,
  readSubscriptionRetrySchedulePolicy,
  validateSubscriptionRetrySchedule,
  type SubscriptionRetrySchedulePolicy,
} from "@openlup/platform/subscriptions";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import {
  assertNativeStoreForward,
  readReviewedForwardRegistry,
} from "../../scripts/reviewed-platform-forward.js";
import {
  closePostgres,
  postgresSetupTimeoutMs,
  postgresTeardownTimeoutMs,
  runPostgresContainer,
  waitForPostgresTcpReady,
  type PostgresContainer,
} from "../helpers/postgresContainer.js";
import {
  AT,
  call,
  failure,
  later,
  prepareOriginal,
  renewal,
  request,
  sandboxRenewal,
} from "./subscriptionNativeFixture.js";

type RetryCorpusCase = {
  name: string;
  input: string;
  accepted: boolean;
  normalized?: SubscriptionRetrySchedulePolicy;
  decodedNormalized?: SubscriptionRetrySchedulePolicy;
  code?: string;
};

type DeclineCorpusCase = {
  name: string;
  input: string;
  accepted: boolean;
  normalized?: PaymentDeclineNoticeTimingPolicy;
  decodedNormalized?: PaymentDeclineNoticeTimingPolicy;
  code?: string;
};

const retryCorpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/subscriptions/subscription_retry_schedule.json", import.meta.url),
  "utf8",
)) as RetryCorpusCase[];

const declineCorpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/payments/payment_decline_notice_timing.json", import.meta.url),
  "utf8",
)) as DeclineCorpusCase[];

const WAVE2_MIGRATION = "db/platform/migrations/20261126020000_settings_wave2_retry_schedule_and_decline_timing.sql";
const RETRY_KEY = "subscription_retry_schedule";
const DECLINE_KEY = "payment_decline_notice_timing";
const RETRY_ERROR = "subscription_retry_schedule_policy_invalid";
const DECLINE_ERROR = "payment_decline_notice_timing_policy_invalid";

const paymentOptions = {
  dunningTemplateSlug: "dunning",
  recoveryUrlPath: "/recover",
  recoveryTemplateSlug: "recovered",
} as const;

const installation = {
  generation: "qualified-v2",
  roleMode: "installer-managed",
  migrationLogin: "postgres",
  bootstrapLogin: "postgres",
  runtimeLogin: "starter_runtime",
  restoreLogin: "starter_restore",
} as const;

let container: PostgresContainer | undefined;
let owner: Pool;
let runtime: Pool;

const newHelpers = [
  "public.subscription_retry_schedule_validate(jsonb)",
  "public.subscription_retry_schedule_read()",
  "public.payment_decline_notice_timing_validate(jsonb)",
  "public.payment_decline_notice_timing_read()",
] as const;

const replacedFunctions = [
  "public.subscription_retry_apply_failure(uuid,text,jsonb)",
  "public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text,jsonb)",
] as const;

async function upsertSetting(key: string, value: string | null) {
  await owner.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, value],
  );
}

async function createOneTimePreparedOrder() {
  const client = randomUUID();
  const order = randomUUID();
  const sku = randomUUID();
  await owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Example')", [sku, sku]);
  await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Example')", [sku, sku]);
  await owner.query(
    `WITH created AS (
      INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor)
      VALUES($1,$2,'pending_payment','XXX',100) RETURNING id
    )
    INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
    SELECT id,$3,1,1,100,100 FROM created`,
    [order, client, sku],
  );
  const control = createPostgresProviderPaymentControlPort(runtime, paymentOptions);
  const intent = (await control.createIntent({
    idempotencyKey: `intent:${order}`,
    targetKind: "one_time_order",
    orderId: order,
    amountMinor: 100,
    currency: "XXX",
    metadata: {},
    channelKey: "card_rail",
    at: AT,
  })).id;
  const attempt = await control.prepareProviderAttempt({
    idempotencyKey: `prepare:${order}`,
    paymentIntentId: intent,
    provider: "card_rail",
    providerIdempotencyKey: `provider:${order}`,
    providerRequestFingerprint: createHash("sha256").update(order).digest("hex"),
    providerFlow: "one_time_payment",
    paymentMethodRef: "method-primary",
    requestPayload: { source: "wave2-fixture" },
  });
  await control.finalizeProviderAttempt({
    idempotencyKey: `finalize:${attempt.paymentAttemptId}`,
    paymentIntentId: intent,
    paymentAttemptId: attempt.paymentAttemptId,
    providerIdempotencyKey: `provider:${order}`,
    providerRequestFingerprint: createHash("sha256").update(order).digest("hex"),
    providerAttemptId: `pi_${attempt.paymentAttemptId}`,
    providerSessionId: `session_${attempt.paymentAttemptId}`,
    attemptStatus: "processing",
    nextActionKind: null,
    requestPayload: {},
    responsePayload: { providerCall: true },
  });
  return { client, order, intent, attemptId: attempt.paymentAttemptId };
}

async function createProviderRenewalFixture() {
  const f = await renewal(owner, 10, 1, randomUUID(), true);
  await call(owner, "fulfillment_reserve_subscription_renewal", [f.operation, f.token, 900, AT]);
  const original = await call(owner, "commerce_prepare_subscription_renewal", [f.operation, f.token, AT]);
  const order = original.orderId as string;
  const intent = original.settlementIntentId as string;
  const cycle = (await owner.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [order]))
    .rows[0]!.subscription_cycle_id as string;
  const control = createPostgresProviderPaymentControlPort(runtime, paymentOptions);
  await control.createIntent({
    idempotencyKey: `provider:${intent}`,
    targetKind: "subscription_cycle",
    orderId: order,
    subscriptionId: f.subscription,
    subscriptionCycleId: cycle,
    amountMinor: f.snapshot.totalAmountMinor,
    currency: "XXX",
    metadata: {},
    channelKey: "fixture",
    at: AT,
  });
  const prepareReq = {
    idempotencyKey: `prepare:${intent}`,
    paymentIntentId: intent,
    provider: "card_rail",
    providerIdempotencyKey: `provider:${intent}`,
    providerRequestFingerprint: "f".repeat(64),
    providerFlow: "off_session_payment",
    paymentMethodRef: "method-primary",
    requestPayload: { source: "wave2-fixture" },
  };
  const attempt = await control.prepareProviderAttempt(prepareReq);
  await control.finalizeProviderAttempt({
    idempotencyKey: `finalize:${attempt.paymentAttemptId}`,
    paymentIntentId: intent,
    paymentAttemptId: attempt.paymentAttemptId,
    providerIdempotencyKey: prepareReq.providerIdempotencyKey,
    providerRequestFingerprint: prepareReq.providerRequestFingerprint,
    providerAttemptId: `pi_${attempt.paymentAttemptId}`,
    providerSessionId: `session_${attempt.paymentAttemptId}`,
    attemptStatus: "processing",
    nextActionKind: null,
    requestPayload: {},
    responsePayload: { providerCall: true },
  });
  await call(owner, "commerce_acknowledge_subscription_renewal_attempt", [
    f.operation,
    f.fingerprint,
    `pi_${attempt.paymentAttemptId}`,
    AT,
  ]);
  return { f, order, intent, cycle, attemptId: attempt.paymentAttemptId };
}

beforeAll(async () => {
  container = await runPostgresContainer({
    name: `settings-wave2-${process.pid}`,
    password: "synthetic-wave2-policy",
  });
  if (!await waitForPostgresTcpReady(container.connectionString)) {
    throw new Error("settings wave2 PostgreSQL unavailable");
  }
  owner = new Pool({
    connectionString: container.connectionString,
    options: qualifiedPostgresStartupOptions(installation),
  });
  await owner.query(`CREATE ROLE starter_runtime LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD 'synthetic-runtime';
    CREATE ROLE starter_restore LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;`);
  const runner = createPostgresMigrationRunner(
    { connectionString: container.connectionString },
    { installation, poolFactory: () => owner },
  );
  await runner.apply();
  expect(await runner.status()).toMatchObject({ pending: [] });
  expect(await runner.apply()).toEqual({ applied: [] });

  const runtimeUrl = new URL(container.connectionString);
  runtimeUrl.username = "starter_runtime";
  runtimeUrl.password = "synthetic-runtime";
  runtime = new Pool({ connectionString: runtimeUrl.toString() });
}, postgresSetupTimeoutMs);

beforeEach(async () => {
  await owner.query("DELETE FROM public.commerce_settings WHERE key = ANY($1::text[])", [[RETRY_KEY, DECLINE_KEY]]);
});

afterAll(async () => {
  await closePostgres(container, [owner, runtime]);
}, postgresTeardownTimeoutMs);

it("admits the Wave 2 forward migration against the manifest prefix and locks function ACLs", async () => {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as {
    baseline: { file: string };
    forward: Array<{ file: string }>;
  };
  const prefix = [manifest.baseline, ...manifest.forward.filter(unit => unit.file < WAVE2_MIGRATION)]
    .map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
  const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  expect(() => assertNativeStoreForward(registry, WAVE2_MIGRATION, readFileSync(WAVE2_MIGRATION), prefix)).not.toThrow();

  const { rows: procRows } = await owner.query<{
    sig: string;
    prosecdef: boolean;
    provolatile: string;
    proconfig: string[] | null;
    anon_exec: boolean;
    auth_exec: boolean;
    rt_exec: boolean;
  }>(`
    SELECT sig,
      p.prosecdef,
      p.provolatile,
      p.proconfig,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
      has_function_privilege('starter_runtime', p.oid, 'EXECUTE') AS rt_exec
    FROM unnest($1::text[]) WITH ORDINALITY AS t(sig, ord)
    JOIN pg_catalog.pg_proc p ON p.oid = t.sig::regprocedure
    ORDER BY t.ord`,
    [[...newHelpers, ...replacedFunctions]],
  );

  expect(procRows).toEqual([
    ...newHelpers.map(sig => ({
      sig,
      prosecdef: false,
      provolatile: "s",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      anon_exec: false,
      auth_exec: false,
      rt_exec: true,
    })),
    {
      sig: "public.subscription_retry_apply_failure(uuid,text,jsonb)",
      prosecdef: false,
      provolatile: "v",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      anon_exec: false,
      auth_exec: false,
      rt_exec: true,
    },
    {
      sig: "public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text,jsonb)",
      prosecdef: true,
      provolatile: "v",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      anon_exec: false,
      auth_exec: false,
      rt_exec: true,
    },
  ]);

  const { rows: aclChecks } = await owner.query(`
    SELECT
      (SELECT proacl FROM pg_catalog.pg_proc WHERE oid='public.subscription_retry_apply_failure(uuid,text,jsonb)'::regprocedure)::text
        IS DISTINCT FROM
        (SELECT proacl FROM pg_catalog.pg_proc WHERE oid='public.subscription_retry_apply_failure(uuid,text,jsonb,jsonb)'::regprocedure)::text AS retry_differs,
      (SELECT proacl FROM pg_catalog.pg_proc WHERE oid='public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text,jsonb)'::regprocedure)::text
        IS DISTINCT FROM
        (SELECT proacl FROM pg_catalog.pg_proc WHERE oid='public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text)'::regprocedure)::text AS apply_differs,
      (SELECT count(*)::integer FROM unnest($1::text[]) AS sig
        WHERE has_function_privilege('public', sig::regprocedure, 'EXECUTE')) AS public_exec_count`,
    [[...newHelpers, ...replacedFunctions]],
  );
  expect(aclChecks).toEqual([{ retry_differs: false, apply_differs: false, public_exec_count: 0 }]);

  // Even with browser default EXECUTE privileges present, replaying the migration revokes anon/authenticated.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      DROP FUNCTION ${newHelpers.join(", ")};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
    `);
    await client.query(readFileSync(WAVE2_MIGRATION, "utf8"));
    for (const role of ["anon", "authenticated"]) {
      for (const callSql of [
        "SELECT public.subscription_retry_schedule_validate('{\"revision\":\"x\",\"backoffHours\":[24,72,168]}'::jsonb)",
        "SELECT public.subscription_retry_schedule_read()",
        "SELECT public.payment_decline_notice_timing_validate('{\"revision\":\"x\",\"delayMinutes\":3,\"linkLifetimeHours\":24}'::jsonb)",
        "SELECT public.payment_decline_notice_timing_read()",
      ]) {
        await client.query(`SET LOCAL ROLE ${role}; SAVEPOINT denied_call`);
        await expect(client.query(callSql)).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT denied_call; RESET ROLE");
      }
    }
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
});

it("E14 preserves [24, 72, 168] absence default, applies live overrides in 3-arg retry and provider apply, keeps p_cadence precedence, and fails closed", async () => {
  expect(await readSubscriptionRetryScheduleOverride(owner)).toBeUndefined();
  expect(await readSubscriptionRetrySchedulePolicy(owner)).toEqual({
    revision: "default",
    backoffHours: [24, 72, 168],
  });
  expect((await runtime.query("SELECT public.subscription_retry_schedule_read() AS result")).rows)
    .toEqual([{ result: { backoffHours: [24, 72, 168] } }]);

  // 1. 3-arg subscription_retry_apply_failure uses [24, 72, 168] when absent, with exhaustion at retry_attempt = 4.
  const absentRetry = await sandboxRenewal(owner);
  const absentOriginal = await prepareOriginal(owner, absentRetry);
  const absentFixture = { ...absentRetry, original: absentOriginal };
  let row = await call(runtime, "subscription_retry_apply_failure", [absentRetry.operation, `abs-fail-0:${absentRetry.operation}`, failure(0, AT)]);
  let elapsed = 0;
  for (const [seq, hrs] of [[1, 24], [2, 72], [3, 168]] as const) {
    elapsed += hrs;
    expect(new Date(row.next_retry_at).toISOString()).toBe(later(elapsed));
    await call(runtime, "subscription_retry_prepare", [absentRetry.operation, `abs-prep-${seq}:${absentRetry.operation}`, request(absentFixture, seq), later(elapsed)]);
    elapsed += 1;
    row = await call(runtime, "subscription_retry_apply_failure", [absentRetry.operation, `abs-fail-${seq}:${absentRetry.operation}`, failure(seq, later(elapsed))]);
  }
  expect(row).toMatchObject({ retry_attempt: 4, next_retry_at: null, state: "waiting" });

  // 2. Installed override [6, 12, 18] takes effect immediately in 3-arg subscription_retry_apply_failure.
  await installSubscriptionRetrySchedulePolicy(owner, { revision: "wave2-6-12-18", backoffHours: [6, 12, 18] });
  expect(await readSubscriptionRetrySchedulePolicy(runtime)).toEqual({ revision: "wave2-6-12-18", backoffHours: [6, 12, 18] });
  const overrideRetry = await sandboxRenewal(owner);
  const overrideOriginal = await prepareOriginal(owner, overrideRetry);
  const overrideFixture = { ...overrideRetry, original: overrideOriginal };
  const key0 = `ovr-fail-0:${overrideRetry.operation}`;
  const input0 = failure(0, AT);
  let ovrRow = await call(runtime, "subscription_retry_apply_failure", [overrideRetry.operation, key0, input0]);
  let ovrElapsed = 0;
  for (const [seq, hrs] of [[1, 6], [2, 12], [3, 18]] as const) {
    ovrElapsed += hrs;
    expect(new Date(ovrRow.next_retry_at).toISOString()).toBe(later(ovrElapsed));
    await call(runtime, "subscription_retry_prepare", [overrideRetry.operation, `ovr-prep-${seq}:${overrideRetry.operation}`, request(overrideFixture, seq), later(ovrElapsed)]);
    ovrElapsed += 1;
    ovrRow = await call(runtime, "subscription_retry_apply_failure", [overrideRetry.operation, `ovr-fail-${seq}:${overrideRetry.operation}`, failure(seq, later(ovrElapsed))]);
  }
  expect(ovrRow).toMatchObject({ retry_attempt: 4, next_retry_at: null, state: "waiting" });

  // Changing the override later does not alter replay of the previously recorded receipt.
  await installSubscriptionRetrySchedulePolicy(owner, { revision: "wave2-48-96-144", backoffHours: [48, 96, 144] });
  expect(await call(runtime, "subscription_retry_apply_failure", [overrideRetry.operation, key0, input0]))
    .toMatchObject({ retry_attempt: 1, next_retry_at: expect.any(String) });
  const replayed3Arg = await call(runtime, "subscription_retry_apply_failure", [overrideRetry.operation, key0, input0]);
  expect(new Date(replayed3Arg.next_retry_at).toISOString()).toBe(later(6));

  // 3. payment_provider_result_apply uses absent default [24, 72, 168], then installed override [12, 36, 72],
  //    while explicit p_cadence wins over installed override, and receipt replay stays immutable.
  await owner.query("DELETE FROM public.commerce_settings WHERE key = $1", [RETRY_KEY]);
  const provAbsent = await createProviderRenewalFixture();
  await createPostgresProviderPaymentControlPort(runtime, paymentOptions).applyPaymentResult({
    idempotencyKey: `prov-absent:${provAbsent.attemptId}`,
    paymentIntentId: provAbsent.intent,
    paymentEventId: null,
    resultStatus: "failed",
    occurredAt: AT,
    failureReason: "declined",
    failureClass: "soft_retryable",
  });
  expect(new Date((await owner.query("SELECT next_retry_at FROM public.subscription_retry_obligations WHERE cycle_id=$1", [provAbsent.cycle])).rows[0]!.next_retry_at).toISOString())
    .toBe(later(24));

  await installSubscriptionRetrySchedulePolicy(owner, { revision: "wave2-12-36-72", backoffHours: [12, 36, 72] });
  const provOverride = await createProviderRenewalFixture();
  const provOverrideKey = `prov-ovr:${provOverride.attemptId}`;
  await createPostgresProviderPaymentControlPort(runtime, paymentOptions).applyPaymentResult({
    idempotencyKey: provOverrideKey,
    paymentIntentId: provOverride.intent,
    paymentEventId: null,
    resultStatus: "failed",
    occurredAt: AT,
    failureReason: "declined",
    failureClass: "soft_retryable",
  });
  expect(new Date((await owner.query("SELECT next_retry_at FROM public.subscription_retry_obligations WHERE cycle_id=$1", [provOverride.cycle])).rows[0]!.next_retry_at).toISOString())
    .toBe(later(12));

  // Explicit p_cadence ([2, 4, 8]) wins over the installed [12, 36, 72] setting!
  const provExplicit = await createProviderRenewalFixture();
  await createPostgresProviderPaymentControlPort(runtime, { ...paymentOptions, retryCadence: { backoffHours: [2, 4, 8] } })
    .applyPaymentResult({
      idempotencyKey: `prov-explicit:${provExplicit.attemptId}`,
      paymentIntentId: provExplicit.intent,
      paymentEventId: null,
      resultStatus: "failed",
      occurredAt: AT,
      failureReason: "declined",
      failureClass: "soft_retryable",
    });
  expect(new Date((await owner.query("SELECT next_retry_at FROM public.subscription_retry_obligations WHERE cycle_id=$1", [provExplicit.cycle])).rows[0]!.next_retry_at).toISOString())
    .toBe(later(2));

  // Changing the override again preserves the already-recorded provider receipt and obligation schedule on replay.
  await installSubscriptionRetrySchedulePolicy(owner, { revision: "wave2-99-99-99", backoffHours: [99, 99, 99] });
  expect(await createPostgresProviderPaymentControlPort(runtime, paymentOptions).applyPaymentResult({
    idempotencyKey: provOverrideKey,
    paymentIntentId: provOverride.intent,
    paymentEventId: null,
    resultStatus: "failed",
    occurredAt: AT,
    failureReason: "declined",
    failureClass: "soft_retryable",
  })).toMatchObject({ replayed: true });
  expect(new Date((await owner.query("SELECT next_retry_at FROM public.subscription_retry_obligations WHERE cycle_id=$1", [provOverride.cycle])).rows[0]!.next_retry_at).toISOString())
    .toBe(later(12));

  // 4. Runtime cannot write commerce_settings (42501).
  await expect(installSubscriptionRetrySchedulePolicy(runtime, { revision: "unauth", backoffHours: [1, 2, 3] }))
    .rejects.toMatchObject({ code: "42501" });

  // 5. Malformed rows fail closed with 22023 and roll back all writes in both 3-arg retry and provider apply (without p_cadence),
  //    while explicit p_cadence still succeeds via COALESCE short-circuit.
  const badRetry = await sandboxRenewal(owner);
  await prepareOriginal(owner, badRetry);
  const badProv = await createProviderRenewalFixture();
  const countSql = `SELECT
    (SELECT count(*)::integer FROM public.subscription_retry_obligations WHERE cycle_id = ANY($1::uuid[])) AS obligations,
    (SELECT count(*)::integer FROM public.subscription_retry_receipts r
      JOIN public.subscription_retry_obligations o ON o.id = r.obligation_id WHERE o.cycle_id = ANY($1::uuid[])) AS retry_receipts,
    (SELECT count(*)::integer FROM public.payment_provider_receipts WHERE idempotency_key LIKE 'prov-bad-%') AS provider_receipts`;
  const beforeCounts = (await owner.query(countSql, [[badProv.cycle]])).rows[0];

  for (const invalidValue of [
    null,
    "{bad",
    "[]",
    '{"revision":" ","backoffHours":[24,72,168]}',
    '{"revision":"x","backoffHours":[24,72]}',
    '{"revision":"x","backoffHours":[0,72,168]}',
  ]) {
    await upsertSetting(RETRY_KEY, invalidValue);
    await expect(runtime.query("SELECT public.subscription_retry_schedule_read()"))
      .rejects.toMatchObject({ code: "22023", message: RETRY_ERROR });
    await expect(call(runtime, "subscription_retry_apply_failure", [badRetry.operation, `bad-3arg:${randomUUID()}`, failure(0, AT)]))
      .rejects.toMatchObject({ code: "22023", message: RETRY_ERROR });
    await expect(createPostgresProviderPaymentControlPort(runtime, paymentOptions).applyPaymentResult({
      idempotencyKey: `prov-bad-${randomUUID()}`,
      paymentIntentId: badProv.intent,
      paymentEventId: null,
      resultStatus: "failed",
      occurredAt: AT,
      failureReason: "declined",
      failureClass: "soft_retryable",
    })).rejects.toMatchObject({ code: "22023", message: RETRY_ERROR });
    await expect(readSubscriptionRetrySchedulePolicy(runtime)).rejects.toThrow(RETRY_ERROR);
    expect((await owner.query(countSql, [[badProv.cycle]])).rows[0]).toEqual(beforeCounts);
    expect(await call(runtime, "subscription_retry_read", [badRetry.operation])).toBeNull();
  }

  // Explicit p_cadence bypasses malformed commerce_settings via COALESCE short-circuit.
  await createPostgresProviderPaymentControlPort(runtime, { ...paymentOptions, retryCadence: { backoffHours: [3, 6, 9] } })
    .applyPaymentResult({
      idempotencyKey: `prov-explicit-over-bad:${badProv.attemptId}`,
      paymentIntentId: badProv.intent,
      paymentEventId: null,
      resultStatus: "failed",
      occurredAt: AT,
      failureReason: "declined",
      failureClass: "soft_retryable",
    });
  expect(new Date((await owner.query("SELECT next_retry_at FROM public.subscription_retry_obligations WHERE cycle_id=$1", [badProv.cycle])).rows[0]!.next_retry_at).toISOString())
    .toBe(later(3));
});

it.each(retryCorpus)("E14 shared TS+SQL corpus: $name", async ({ input, accepted, normalized, decodedNormalized, code }) => {
  await upsertSetting(RETRY_KEY, input);
  const sqlValidate = () => runtime.query("SELECT public.subscription_retry_schedule_validate($1::jsonb) AS result", [input]);
  const sqlRead = () => runtime.query("SELECT public.subscription_retry_schedule_read() AS result");

  if (accepted) {
    const parsed = JSON.parse(input);
    expect(validateSubscriptionRetrySchedule(parsed)).toEqual(normalized);
    expect(await readSubscriptionRetryScheduleOverride(runtime)).toEqual(normalized);
    expect((await sqlValidate()).rows).toEqual([{ result: normalized }]);
    expect((await sqlRead()).rows).toEqual([{ result: { backoffHours: normalized!.backoffHours } }]);
  } else {
    const refusal = { code: "22023", message: code };
    await expect(sqlValidate()).rejects.toMatchObject(refusal);
    await expect(sqlRead()).rejects.toMatchObject(refusal);
    if (decodedNormalized) {
      await expect(readSubscriptionRetryScheduleOverride(runtime)).resolves.toEqual(decodedNormalized);
    } else {
      await expect(readSubscriptionRetryScheduleOverride(runtime)).rejects.toThrow(code!);
    }
  }
});

it("E1 preserves 3m/24h absence defaults, applies live overrides, keeps recorded timestamps on replay, and fails closed", async () => {
  expect(await readPaymentDeclineNoticeTimingOverride(owner)).toBeUndefined();
  expect(await readPaymentDeclineNoticeTimingPolicy(owner)).toEqual({
    revision: "default",
    delayMinutes: 3,
    linkLifetimeHours: 24,
  });
  expect((await runtime.query("SELECT public.payment_decline_notice_timing_read() AS result")).rows)
    .toEqual([{ result: { delayMinutes: 3, linkLifetimeHours: 24 } }]);

  const measureDeclineTiming = async (order: string, intent: string, key: string) => {
    const res = await createPostgresProviderPaymentControlPort(runtime, paymentOptions).applyPaymentResult({
      idempotencyKey: key,
      paymentIntentId: intent,
      paymentEventId: null,
      resultStatus: "failed",
      occurredAt: AT,
      failureReason: "declined",
    });
    expect(res).toMatchObject({ kind: "recoverable_decline", replayed: false });
    const { rows } = await owner.query<{
      delay_seconds: number;
      token_lifetime_seconds: number;
      available_at: string;
      token_expires_at: string;
      payload_expires_at: string;
    }>(
      `SELECT
        EXTRACT(EPOCH FROM (e.available_at - e.created_at))::double precision AS delay_seconds,
        EXTRACT(EPOCH FROM (t.expires_at - t.created_at))::double precision AS token_lifetime_seconds,
        e.available_at::text AS available_at,
        t.expires_at::text AS token_expires_at,
        (e.payload->>'expiresAt')::timestamptz::text AS payload_expires_at
       FROM public.outbox_events e
       JOIN public.commerce_checkout_recovery_tokens t ON t.order_id = e.aggregate_id
       WHERE e.aggregate_id = $1 AND e.event_type = 'commerce.payment.failed'`,
      [order],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload_expires_at).toBe(rows[0]!.token_expires_at);
    return rows[0]!;
  };

  // Absence fallback -> 3 minutes delay, 24 hours token lifetime.
  const absentOrder = await createOneTimePreparedOrder();
  const absentTiming = await measureDeclineTiming(absentOrder.order, absentOrder.intent, `decline-absent:${absentOrder.order}`);
  expect(absentTiming.delay_seconds).toBe(3 * 60);
  expect(absentTiming.token_lifetime_seconds).toBe(24 * 3600);

  // Live override: 0 minutes delay, 48 hours token lifetime.
  await installPaymentDeclineNoticeTimingPolicy(owner, { revision: "wave2-0m-48h", delayMinutes: 0, linkLifetimeHours: 48 });
  expect(await readPaymentDeclineNoticeTimingPolicy(runtime)).toEqual({ revision: "wave2-0m-48h", delayMinutes: 0, linkLifetimeHours: 48 });
  const fastOrder = await createOneTimePreparedOrder();
  const fastKey = `decline-fast:${fastOrder.order}`;
  const fastTiming = await measureDeclineTiming(fastOrder.order, fastOrder.intent, fastKey);
  expect(fastTiming.delay_seconds).toBe(0);
  expect(fastTiming.token_lifetime_seconds).toBe(48 * 3600);

  // Changing the override to 15m / 12h affects new orders while replaying fastKey keeps original timestamps.
  await installPaymentDeclineNoticeTimingPolicy(owner, { revision: "wave2-15m-12h", delayMinutes: 15, linkLifetimeHours: 12 });
  const slowOrder = await createOneTimePreparedOrder();
  const slowTiming = await measureDeclineTiming(slowOrder.order, slowOrder.intent, `decline-slow:${slowOrder.order}`);
  expect(slowTiming.delay_seconds).toBe(15 * 60);
  expect(slowTiming.token_lifetime_seconds).toBe(12 * 3600);

  expect(await createPostgresProviderPaymentControlPort(runtime, paymentOptions).applyPaymentResult({
    idempotencyKey: fastKey,
    paymentIntentId: fastOrder.intent,
    paymentEventId: null,
    resultStatus: "failed",
    occurredAt: AT,
    failureReason: "declined",
  })).toMatchObject({ kind: "recoverable_decline", replayed: true });
  const { rows: fastAfterReplay } = await owner.query<{ available_at: string; expires_at: string }>(
    `SELECT e.available_at::text AS available_at, t.expires_at::text AS expires_at
     FROM public.outbox_events e
     JOIN public.commerce_checkout_recovery_tokens t ON t.order_id = e.aggregate_id
     WHERE e.aggregate_id = $1 AND e.event_type = 'commerce.payment.failed'`,
    [fastOrder.order],
  );
  expect(fastAfterReplay).toEqual([{ available_at: fastTiming.available_at, expires_at: fastTiming.token_expires_at }]);

  // Runtime cannot write commerce_settings (42501).
  await expect(installPaymentDeclineNoticeTimingPolicy(runtime, { revision: "unauth", delayMinutes: 5, linkLifetimeHours: 24 }))
    .rejects.toMatchObject({ code: "42501" });

  // Invalid setting fails closed with 22023 before leaving any partial token, outbox, order metadata, or receipt rows.
  const badOrder = await createOneTimePreparedOrder();
  const countSql = `SELECT
    (SELECT count(*)::integer FROM public.commerce_checkout_recovery_tokens WHERE order_id = $1) AS tokens,
    (SELECT count(*)::integer FROM public.outbox_events WHERE aggregate_id = $1 AND event_type = 'commerce.payment.failed') AS outbox,
    (SELECT count(*)::integer FROM public.payment_provider_receipts WHERE idempotency_key LIKE 'decline-bad-%') AS receipts,
    (SELECT metadata FROM public.commerce_orders WHERE id = $1) AS order_metadata,
    (SELECT status FROM public.payment_provider_attempts WHERE id = $2) AS attempt_status`;
  const beforeBad = (await owner.query(countSql, [badOrder.order, badOrder.attemptId])).rows[0];

  for (const invalidValue of [
    null,
    "{bad",
    '{"revision":" ","delayMinutes":3,"linkLifetimeHours":24}',
    '{"revision":"x","delayMinutes":-1,"linkLifetimeHours":24}',
    '{"revision":"x","delayMinutes":1441,"linkLifetimeHours":24}',
    '{"revision":"x","delayMinutes":3,"linkLifetimeHours":0}',
    '{"revision":"x","delayMinutes":3,"linkLifetimeHours":169}',
  ]) {
    await upsertSetting(DECLINE_KEY, invalidValue);
    await expect(runtime.query("SELECT public.payment_decline_notice_timing_read()"))
      .rejects.toMatchObject({ code: "22023", message: DECLINE_ERROR });
    await expect(createPostgresProviderPaymentControlPort(runtime, paymentOptions).applyPaymentResult({
      idempotencyKey: `decline-bad-${randomUUID()}`,
      paymentIntentId: badOrder.intent,
      paymentEventId: null,
      resultStatus: "failed",
      occurredAt: AT,
      failureReason: "declined",
    })).rejects.toMatchObject({ code: "22023", message: DECLINE_ERROR });
    await expect(readPaymentDeclineNoticeTimingPolicy(runtime)).rejects.toThrow(DECLINE_ERROR);
    expect((await owner.query(countSql, [badOrder.order, badOrder.attemptId])).rows[0]).toEqual(beforeBad);
  }
});

it.each(declineCorpus)("E1 shared TS+SQL corpus: $name", async ({ input, accepted, normalized, decodedNormalized, code }) => {
  await upsertSetting(DECLINE_KEY, input);
  const sqlValidate = () => runtime.query("SELECT public.payment_decline_notice_timing_validate($1::jsonb) AS result", [input]);
  const sqlRead = () => runtime.query("SELECT public.payment_decline_notice_timing_read() AS result");

  if (accepted) {
    const parsed = JSON.parse(input);
    expect(validatePaymentDeclineNoticeTiming(parsed)).toEqual(normalized);
    expect(await readPaymentDeclineNoticeTimingOverride(runtime)).toEqual(normalized);
    expect((await sqlValidate()).rows).toEqual([{ result: normalized }]);
    expect((await sqlRead()).rows).toEqual([{
      result: { delayMinutes: normalized!.delayMinutes, linkLifetimeHours: normalized!.linkLifetimeHours },
    }]);
  } else {
    const refusal = { code: "22023", message: code };
    await expect(sqlValidate()).rejects.toMatchObject(refusal);
    await expect(sqlRead()).rejects.toMatchObject(refusal);
    if (decodedNormalized) {
      await expect(readPaymentDeclineNoticeTimingOverride(runtime)).resolves.toEqual(decodedNormalized);
    } else {
      await expect(readPaymentDeclineNoticeTimingOverride(runtime)).rejects.toThrow(code!);
    }
  }
});
