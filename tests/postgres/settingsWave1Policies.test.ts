import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  installPaymentMethodExpiryWarningDaysPolicy,
  readPaymentMethodExpiryWarningDaysOverride,
  readPaymentMethodExpiryWarningDaysPolicy,
  validatePaymentMethodExpiryWarningDays,
  type PaymentMethodExpiryWarningDaysPolicy,
} from "@openlup/platform/payments";
import {
  installPromotionClaimHoldHoursPolicy,
  readPromotionClaimHoldHoursOverride,
  readPromotionClaimHoldHoursPolicy,
  validatePromotionClaimHoldHours,
  type PromotionClaimHoldHoursPolicy,
} from "@openlup/platform/promotions";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import {
  assertNativeStoreForward,
  readReviewedForwardRegistry,
  sqlStatements,
} from "../../scripts/reviewed-platform-forward.js";
import {
  closePostgres,
  postgresSetupTimeoutMs,
  postgresTeardownTimeoutMs,
  runPostgresContainer,
  waitForPostgresTcpReady,
  type PostgresContainer,
} from "../helpers/postgresContainer.js";

type ExpiryCorpusCase = {
  name: string;
  input: string;
  accepted: boolean;
  normalized?: PaymentMethodExpiryWarningDaysPolicy;
  decodedNormalized?: PaymentMethodExpiryWarningDaysPolicy;
  code?: string;
};

type HoldCorpusCase = {
  name: string;
  input: string;
  accepted: boolean;
  normalized?: PromotionClaimHoldHoursPolicy;
  decodedNormalized?: PromotionClaimHoldHoursPolicy;
  code?: string;
};

const expiryCorpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/payments/payment_method_expiry_warning_days.json", import.meta.url),
  "utf8",
)) as ExpiryCorpusCase[];

const holdCorpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/promotions/promotion_claim_hold_hours.json", import.meta.url),
  "utf8",
)) as HoldCorpusCase[];

const WAVE1_MIGRATION = "db/platform/migrations/20261126010000_settings_wave1_method_expiry_and_claim_hold.sql";
const EXPIRY_KEY = "payment_method_expiry_warning_days";
const HOLD_KEY = "promotion_claim_hold_hours";
const EXPIRY_ERROR = "payment_method_expiry_warning_days_policy_invalid";
const HOLD_ERROR = "promotion_claim_hold_hours_policy_invalid";
const ARTICLE_SKU = "ARTICLE-POLICY-PROMO";
const PROMO_ID = "policy-promo";

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
let clientId: string;
let sub5d: string;
let sub10d: string;
let sub29d: string;
let sub31d: string;
let sub45d: string;
let subNull: string;

const newHelpers = [
  "public.payment_method_expiry_warning_days_validate(jsonb)",
  "public.payment_method_expiry_warning_days_read()",
  "public.promotion_claim_hold_hours_validate(jsonb)",
  "public.promotion_claim_hold_hours_read()",
] as const;

function buildPromotedDraftInputs() {
  const unit = { amountMinor: 1000, currency: "XXX" };
  const discount = { amountMinor: 200, currency: "XXX" };
  const zero = { amountMinor: 0, currency: "XXX" };
  const total = { amountMinor: 800, currency: "XXX" };
  const quoteSnapshot = {
    contractVersion: "commerce.v0",
    quote: {
      currency: "XXX",
      taxIncluded: true,
      context: { mode: "one_time", promoCodes: [] },
      lines: [
        {
          sku: ARTICLE_SKU,
          productSlug: "policy-article",
          quantity: 1,
          unitPriceGross: unit,
          lineSubtotalGross: unit,
          tax: {
            included: true,
            country: "ZZ",
            category: "standard",
            vatRateBps: 0,
            netAmount: unit,
            vatAmount: zero,
            grossAmount: unit,
            legalBasis: "Example",
          },
        },
      ],
      discounts: [{ promotionId: PROMO_ID, title: "Policy promo", appliesTo: "order_total", amountOffMinor: 200 }],
      subtotalGross: unit,
      discountTotalGross: discount,
      shippingGross: zero,
      shippingDiscountGross: zero,
      totalGross: total,
      netTotal: total,
      taxTotal: zero,
    },
  };
  const orderDraftSnapshot = {
    contractVersion: "commerce.v0",
    source: "commerce.order_draft.bff.v0",
    status: "draft",
    paymentStatus: "not_started",
    currency: "XXX",
    context: quoteSnapshot.quote.context,
    lines: quoteSnapshot.quote.lines,
    discounts: quoteSnapshot.quote.discounts,
    totals: {
      subtotalGross: unit,
      discountTotalGross: discount,
      shippingGross: zero,
      shippingDiscountGross: zero,
      totalGross: total,
    },
  };
  return { quoteSnapshot, orderDraftSnapshot };
}

async function createPromotedDraft(db: Pool, idempotencyKey: string) {
  const { quoteSnapshot, orderDraftSnapshot } = buildPromotedDraftInputs();
  const { rows } = await db.query<{ result: { orderDraft: { orderId: string; replayed: boolean } } }>(
    "SELECT public.commerce_create_promoted_order_draft_with_outbox($1,$2,$3,$4) AS result",
    [idempotencyKey, quoteSnapshot, orderDraftSnapshot, clientId],
  );
  return rows[0]!.result;
}

async function insertMethodSub(daysAhead: number | null): Promise<string> {
  const subscriptionId = randomUUID();
  await owner.query(
    "INSERT INTO public.subscriptions(id,client_id,status,cadence_days,next_cycle_at) VALUES($1,$2,'active',28,now() + interval '40 days')",
    [subscriptionId, clientId],
  );
  await owner.query(
    `INSERT INTO public.payment_method_refs(
      client_id,subscription_id,provider_kind,method_kind,provider_customer_ref,
      provider_method_ref,status,active,expires_at,consent_snapshot
    ) VALUES($1,$2,'card_rail','card',$3,$4,'active',true,
      CASE WHEN $5::integer IS NULL THEN NULL ELSE now() + make_interval(days => $5::integer, hours => 12) END,
      '{}'::jsonb)`,
    [clientId, subscriptionId, `cus_${subscriptionId}`, `pm_${subscriptionId}`, daysAhead],
  );
  return subscriptionId;
}

beforeAll(async () => {
  container = await runPostgresContainer({
    name: `settings-wave1-${process.pid}`,
    password: "synthetic-wave1-policy",
  });
  if (!await waitForPostgresTcpReady(container.connectionString)) {
    throw new Error("settings wave1 PostgreSQL unavailable");
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

  // Retain the previous definition of subscription_method_health_read under a
  // temporary name to verify exact JSONB parity when the policy row is absent.
  const oldHealthRead = sqlStatements(readFileSync("db/platform/migrations/20261114110000_payment_method_refs.sql", "utf8"))
    .find(sql => sql.startsWith("CREATE FUNCTION public.subscription_method_health_read("))!;
  await owner.query(oldHealthRead.replace("public.subscription_method_health_read(", "public.subscription_method_health_read_before_e4("));

  clientId = (await owner.query(
    "INSERT INTO public.clients(email) VALUES('wave1-policy@example.invalid') RETURNING id",
  )).rows[0]!.id as string;

  sub5d = await insertMethodSub(5);
  sub10d = await insertMethodSub(10);
  sub29d = await insertMethodSub(29);
  sub31d = await insertMethodSub(31);
  sub45d = await insertMethodSub(45);
  subNull = await insertMethodSub(null);

  const productId = randomUUID();
  await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'policy-article','Policy article')", [productId]);
  await owner.query(
    "INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_standalone) VALUES($1,$1,$2,'Policy article',true)",
    [productId, ARTICLE_SKU],
  );
  const priceListId = (await owner.query(
    "INSERT INTO public.price_lists(name,region_code,currency) VALUES('Wave1 Example','ZZ','XXX') RETURNING id",
  )).rows[0]!.id as string;
  await owner.query(
    "INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,mode) VALUES($1,$2,1000,'one_time')",
    [priceListId, productId],
  );
  const definition = {
    id: PROMO_ID,
    status: "active",
    code: null,
    name: "Policy example",
    trigger_type: "automatic",
    discount_type: "fixed_amount",
    discount_value: 200,
    applies_to_kind: "order_total",
    applies_to_payload: {},
    stacking_rule: "exclusive",
    eligibility: {},
    valid_from: "2020-01-01T00:00:00Z",
    valid_to: null,
    region_availability: ["ZZ"],
    redemption_limit_global: null,
    redemption_limit_per_customer: null,
  };
  await owner.query(
    "INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)",
    [PROMO_ID, definition],
  );
}, postgresSetupTimeoutMs);

beforeEach(async () => {
  await owner.query("DELETE FROM public.commerce_settings WHERE key = ANY($1::text[])", [[EXPIRY_KEY, HOLD_KEY]]);
});

afterAll(async () => {
  await closePostgres(container, [owner, runtime]);
}, postgresTeardownTimeoutMs);

it("admits the Wave 1 forward migration against the manifest prefix and locks function ACLs", async () => {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as {
    baseline: { file: string };
    forward: Array<{ file: string }>;
  };
  const prefix = [manifest.baseline, ...manifest.forward.filter(unit => unit.file < WAVE1_MIGRATION)]
    .map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
  const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  expect(() => assertNativeStoreForward(registry, WAVE1_MIGRATION, readFileSync(WAVE1_MIGRATION), prefix)).not.toThrow();

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
    [[
      ...newHelpers,
      "public.subscription_method_health_read(uuid)",
      "public.commerce_create_promoted_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
    ]],
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
      sig: "public.subscription_method_health_read(uuid)",
      prosecdef: true,
      provolatile: "s",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      anon_exec: false,
      auth_exec: false,
      rt_exec: true,
    },
    {
      sig: "public.commerce_create_promoted_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
      prosecdef: false,
      provolatile: "v",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      anon_exec: false,
      auth_exec: false,
      rt_exec: true,
    },
  ]);

  // Verify ACL parity with sibling routine subscription_method_chargeable_unattended
  // (installed with the exact same REVOKE PUBLIC / GRANT service_role ACL in 20261114110000)
  // and verify PUBLIC cannot execute any of the Wave 1 functions.
  const { rows: aclChecks } = await owner.query(`
    SELECT (SELECT proacl FROM pg_catalog.pg_proc WHERE oid='public.subscription_method_health_read(uuid)'::regprocedure)::text
      IS DISTINCT FROM
      (SELECT proacl FROM pg_catalog.pg_proc WHERE oid='public.subscription_method_chargeable_unattended(uuid,timestamptz)'::regprocedure)::text AS differs,
      (SELECT count(*)::integer FROM unnest($1::text[]) AS sig
       WHERE has_function_privilege('public', sig::regprocedure, 'EXECUTE')) AS public_exec_count`,
    [[
      ...newHelpers,
      "public.subscription_method_health_read(uuid)",
      "public.commerce_create_promoted_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
    ]],
  );
  expect(aclChecks).toEqual([{ differs: false, public_exec_count: 0 }]);

  // Even with browser default EXECUTE privileges present, replaying the migration revokes anon/authenticated.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      DROP FUNCTION ${newHelpers.join(", ")};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
    `);
    await client.query(readFileSync(WAVE1_MIGRATION, "utf8"));
    for (const role of ["anon", "authenticated"]) {
      for (const callSql of [
        "SELECT public.payment_method_expiry_warning_days_validate('{\"revision\":\"x\",\"warningDays\":30}'::jsonb)",
        "SELECT public.payment_method_expiry_warning_days_read()",
        "SELECT public.promotion_claim_hold_hours_validate('{\"revision\":\"x\",\"holdHours\":24}'::jsonb)",
        "SELECT public.promotion_claim_hold_hours_read()",
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

it("E4 preserves 30-day absence default and exact JSONB shape, applies live overrides, and fails closed on invalid settings", async () => {
  expect(await readPaymentMethodExpiryWarningDaysOverride(owner)).toBeUndefined();
  expect(await readPaymentMethodExpiryWarningDaysPolicy(owner)).toEqual({ revision: "default", warningDays: 30 });
  expect((await runtime.query("SELECT public.payment_method_expiry_warning_days_read() AS days")).rows).toEqual([{ days: 30 }]);

  // Compare exact JSONB output of subscription_method_health_read against the view/historical reader when absent.
  for (const subId of [sub5d, sub29d, sub31d, subNull]) {
    const [{ result: actual }] = (await runtime.query("SELECT public.subscription_method_health_read($1) AS result", [subId])).rows;
    const [{ result: baseline }] = (await owner.query("SELECT public.subscription_method_health_read_before_e4($1) AS result", [subId])).rows;
    expect(actual).toEqual(baseline);
  }
  expect((await runtime.query("SELECT public.subscription_method_health_read($1) AS result", [sub29d])).rows[0]!.result)
    .toMatchObject({ health_state: "method_expiring" });
  expect((await runtime.query("SELECT public.subscription_method_health_read($1) AS result", [sub31d])).rows[0]!.result)
    .toMatchObject({ health_state: "healthy" });

  // Installing an override through the owner takes effect immediately in the already-open runtime pool.
  await installPaymentMethodExpiryWarningDaysPolicy(owner, { revision: "wave1-7d", warningDays: 7 });
  expect(await readPaymentMethodExpiryWarningDaysPolicy(runtime)).toEqual({ revision: "wave1-7d", warningDays: 7 });
  expect((await runtime.query("SELECT public.subscription_method_health_read($1) AS result", [sub5d])).rows[0]!.result)
    .toMatchObject({ health_state: "method_expiring" });
  expect((await runtime.query("SELECT public.subscription_method_health_read($1) AS result", [sub10d])).rows[0]!.result)
    .toMatchObject({ health_state: "healthy" });
  expect((await runtime.query("SELECT public.subscription_method_health_read($1) AS result", [sub29d])).rows[0]!.result)
    .toMatchObject({ health_state: "healthy" });

  await installPaymentMethodExpiryWarningDaysPolicy(owner, { revision: "wave1-60d", warningDays: 60 });
  expect((await runtime.query("SELECT public.subscription_method_health_read($1) AS result", [sub45d])).rows[0]!.result)
    .toMatchObject({ health_state: "method_expiring" });
  expect((await runtime.query("SELECT public.subscription_method_health_read($1) AS result", [subNull])).rows[0]!.result)
    .toMatchObject({ health_state: "healthy", method_expires_at: null });

  // Runtime cannot write commerce_settings (INSERT denied with 42501).
  await expect(installPaymentMethodExpiryWarningDaysPolicy(runtime, { revision: "unauth", warningDays: 10 }))
    .rejects.toMatchObject({ code: "42501" });

  // Malformed or invalid installed settings must fail closed with 22023 even for NULL expiry or missing subscriptions.
  for (const invalidValue of [null, "{bad", "[]", '{"revision":" ","warningDays":30}', '{"revision":"x","warningDays":0}', '{"revision":"x","warningDays":366}']) {
    await owner.query(
      `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
        ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
      [EXPIRY_KEY, invalidValue],
    );
    await expect(runtime.query("SELECT public.payment_method_expiry_warning_days_read()"))
      .rejects.toMatchObject({ code: "22023", message: EXPIRY_ERROR });
    await expect(runtime.query("SELECT public.subscription_method_health_read($1)", [subNull]))
      .rejects.toMatchObject({ code: "22023", message: EXPIRY_ERROR });
    await expect(runtime.query("SELECT public.subscription_method_health_read($1)", [randomUUID()]))
      .rejects.toMatchObject({ code: "22023", message: EXPIRY_ERROR });
    await expect(readPaymentMethodExpiryWarningDaysPolicy(runtime)).rejects.toThrow(EXPIRY_ERROR);
  }
});

it.each(expiryCorpus)("E4 shared TS+SQL corpus: $name", async ({ input, accepted, normalized, decodedNormalized, code }) => {
  await owner.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [EXPIRY_KEY, input],
  );
  const sqlValidate = () => runtime.query("SELECT public.payment_method_expiry_warning_days_validate($1::jsonb) AS result", [input]);
  const sqlRead = () => runtime.query("SELECT public.payment_method_expiry_warning_days_read() AS days");

  if (accepted) {
    const parsed = JSON.parse(input);
    expect(validatePaymentMethodExpiryWarningDays(parsed)).toEqual(normalized);
    expect(await readPaymentMethodExpiryWarningDaysOverride(runtime)).toEqual(normalized);
    expect((await sqlValidate()).rows).toEqual([{ result: normalized }]);
    expect((await sqlRead()).rows).toEqual([{ days: normalized!.warningDays }]);
  } else {
    const refusal = { code: "22023", message: code };
    await expect(sqlValidate()).rejects.toMatchObject(refusal);
    await expect(sqlRead()).rejects.toMatchObject(refusal);
    if (decodedNormalized) {
      await expect(readPaymentMethodExpiryWarningDaysOverride(runtime)).resolves.toEqual(decodedNormalized);
    } else {
      await expect(readPaymentMethodExpiryWarningDaysOverride(runtime)).rejects.toThrow(code!);
    }
  }
});

it("E7 preserves 24-hour absence default, applies live overrides, keeps expires_at on idempotent replay, and fails closed", async () => {
  expect(await readPromotionClaimHoldHoursOverride(owner)).toBeUndefined();
  expect(await readPromotionClaimHoldHoursPolicy(owner)).toEqual({ revision: "default", holdHours: 24 });
  expect((await runtime.query("SELECT public.promotion_claim_hold_hours_read() AS hours")).rows).toEqual([{ hours: 24 }]);

  const measureHoldSeconds = async (key: string) => {
    const draft = await createPromotedDraft(runtime, key);
    expect(draft.orderDraft.replayed).toBe(false);
    const orderUuid = draft.orderDraft.orderId.slice(6);
    const { rows } = await owner.query<{ hold_seconds: number; expires_at: string; reserved_at: string }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - reserved_at))::double precision AS hold_seconds,
              expires_at::text, reserved_at::text
       FROM public.commerce_promotion_claims WHERE order_id = $1`,
      [orderUuid],
    );
    expect(rows).toHaveLength(1);
    return { orderUuid, ...rows[0]! };
  };

  // Absence fallback -> exact 24 hours.
  const absentClaim = await measureHoldSeconds(`wave1-absent-${randomUUID()}`);
  expect(absentClaim.hold_seconds).toBe(24 * 3600);

  // Override to 6 hours -> newly reserved claims get +6 hours immediately without restart.
  await installPromotionClaimHoldHoursPolicy(owner, { revision: "wave1-6h", holdHours: 6 });
  expect(await readPromotionClaimHoldHoursPolicy(runtime)).toEqual({ revision: "wave1-6h", holdHours: 6 });
  const key6h = `wave1-6h-${randomUUID()}`;
  const claim6h = await measureHoldSeconds(key6h);
  expect(claim6h.hold_seconds).toBe(6 * 3600);

  // Override to 72 hours -> new key gets +72h, while replaying key6h keeps original +6h expires_at.
  await installPromotionClaimHoldHoursPolicy(owner, { revision: "wave1-72h", holdHours: 72 });
  const claim72h = await measureHoldSeconds(`wave1-72h-${randomUUID()}`);
  expect(claim72h.hold_seconds).toBe(72 * 3600);

  const replayed = await createPromotedDraft(runtime, key6h);
  expect(replayed.orderDraft).toMatchObject({ orderId: `order_${claim6h.orderUuid}`, replayed: true });
  const { rows: afterReplay } = await owner.query<{ hold_seconds: number; expires_at: string; reserved_at: string }>(
    `SELECT EXTRACT(EPOCH FROM (expires_at - reserved_at))::double precision AS hold_seconds,
            expires_at::text, reserved_at::text
     FROM public.commerce_promotion_claims WHERE order_id = $1`,
    [claim6h.orderUuid],
  );
  expect(afterReplay).toEqual([{
    hold_seconds: claim6h.hold_seconds,
    expires_at: claim6h.expires_at,
    reserved_at: claim6h.reserved_at,
  }]);

  // Runtime cannot write commerce_settings (INSERT denied with 42501).
  await expect(installPromotionClaimHoldHoursPolicy(runtime, { revision: "unauth", holdHours: 12 }))
    .rejects.toMatchObject({ code: "42501" });

  // Invalid setting fails closed with 22023 before leaving any partial order or claim rows.
  const countSql = `SELECT
    (SELECT count(*)::integer FROM public.commerce_orders) AS orders,
    (SELECT count(*)::integer FROM public.commerce_promotion_claims) AS claims,
    (SELECT count(*)::integer FROM public.commerce_order_adjustments) AS adjustments,
    (SELECT count(*)::integer FROM public.outbox_events) AS outbox`;
  const countsBefore = (await owner.query(countSql)).rows[0];
  for (const invalidValue of [null, "{bad", '{"revision":" ","holdHours":24}', '{"revision":"x","holdHours":0}', '{"revision":"x","holdHours":721}']) {
    await owner.query(
      `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
        ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
      [HOLD_KEY, invalidValue],
    );
    await expect(runtime.query("SELECT public.promotion_claim_hold_hours_read()"))
      .rejects.toMatchObject({ code: "22023", message: HOLD_ERROR });
    await expect(createPromotedDraft(runtime, `wave1-invalid-${randomUUID()}`))
      .rejects.toMatchObject({ code: "22023", message: HOLD_ERROR });
    await expect(readPromotionClaimHoldHoursPolicy(runtime)).rejects.toThrow(HOLD_ERROR);
    expect((await owner.query(countSql)).rows[0]).toEqual(countsBefore);
  }
});

it.each(holdCorpus)("E7 shared TS+SQL corpus: $name", async ({ input, accepted, normalized, decodedNormalized, code }) => {
  await owner.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [HOLD_KEY, input],
  );
  const sqlValidate = () => runtime.query("SELECT public.promotion_claim_hold_hours_validate($1::jsonb) AS result", [input]);
  const sqlRead = () => runtime.query("SELECT public.promotion_claim_hold_hours_read() AS hours");

  if (accepted) {
    const parsed = JSON.parse(input);
    expect(validatePromotionClaimHoldHours(parsed)).toEqual(normalized);
    expect(await readPromotionClaimHoldHoursOverride(runtime)).toEqual(normalized);
    expect((await sqlValidate()).rows).toEqual([{ result: normalized }]);
    expect((await sqlRead()).rows).toEqual([{ hours: normalized!.holdHours }]);
  } else {
    const refusal = { code: "22023", message: code };
    await expect(sqlValidate()).rejects.toMatchObject(refusal);
    await expect(sqlRead()).rejects.toMatchObject(refusal);
    if (decodedNormalized) {
      await expect(readPromotionClaimHoldHoursOverride(runtime)).resolves.toEqual(decodedNormalized);
    } else {
      await expect(readPromotionClaimHoldHoursOverride(runtime)).rejects.toThrow(code!);
    }
  }
});
