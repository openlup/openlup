import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_SUPPORT_OPERATOR_SLIDE_MAX_DAYS,
  installAccountSupportOperatorSlideMaxDaysPolicy,
  readAccountSupportOperatorSlideMaxDaysOverride,
  readAccountSupportOperatorSlideMaxDaysPolicy,
  validateAccountSupportOperatorSlideMaxDays,
  type AccountSupportOperatorSlideMaxDaysPolicy,
} from "@openlup/platform/account-support";
import {
  DEFAULT_SUBSCRIPTION_EDIT_QUOTE_TTL_MINUTES,
  installSubscriptionEditQuoteTtlMinutesPolicy,
  readSubscriptionEditQuoteTtlMinutesOverride,
  readSubscriptionEditQuoteTtlMinutesPolicy,
  validateSubscriptionEditQuoteTtlMinutes,
  type SubscriptionEditQuoteTtlMinutesPolicy,
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
import { AT, call, later, renewal } from "./subscriptionNativeFixture.js";

type SlideCorpusCase = {
  name: string;
  input: string;
  accepted: boolean;
  normalized?: AccountSupportOperatorSlideMaxDaysPolicy;
  decodedNormalized?: AccountSupportOperatorSlideMaxDaysPolicy;
  code?: string;
};

type QuoteValidityCorpusCase = {
  name: string;
  input: string;
  accepted: boolean;
  normalized?: SubscriptionEditQuoteTtlMinutesPolicy;
  decodedNormalized?: SubscriptionEditQuoteTtlMinutesPolicy;
  code?: string;
};

const slideCorpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/account-support/account_support_operator_slide_max_days.json", import.meta.url),
  "utf8",
)) as SlideCorpusCase[];

const quoteWindowCorpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/subscriptions/subscription_edit_quote_ttl_minutes.json", import.meta.url),
  "utf8",
)) as QuoteValidityCorpusCase[];

const WAVE3A_MIGRATION = "db/platform/migrations/20261126030000_settings_wave3a_operator_slide_and_quote_ttl.sql";
const SLIDE_KEY = "account_support_operator_slide_max_days";
const QUOTE_WINDOW_KEY = "subscription_edit_quote_ttl_minutes";
const SLIDE_ERROR = "account_support_operator_slide_max_days_policy_invalid";
const QUOTE_WINDOW_ERROR = "subscription_edit_quote_ttl_minutes_policy_invalid";
const HISTORICAL_FROM = "2020-01-01T00:00:00.000Z";

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
  "public.account_support_operator_slide_max_days_validate(jsonb)",
  "public.account_support_operator_slide_max_days_read()",
  "public.subscription_edit_quote_ttl_minutes_validate(jsonb)",
  "public.subscription_edit_quote_ttl_minutes_read()",
] as const;

const replacedFunctions = [
  "public.customer_support_apply_subscription_action_v1(uuid,uuid,text,jsonb,integer,text,timestamptz)",
  "public.customer_subscription_preview_bundle_as_actor(uuid,text,jsonb,jsonb,jsonb,integer,integer)",
  "public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz)",
] as const;

async function upsertSetting(key: string, value: string | null) {
  await owner.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, value],
  );
}

async function createOperatorSlideFixture() {
  const f = await renewal(owner);
  const operator = randomUUID();
  const principal = randomUUID();
  await owner.query("DELETE FROM public.subscription_renewal_operations WHERE id=$1", [f.operation]);
  await owner.query(
    "INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2),($3,$4)",
    [operator, `${operator}@example.invalid`, principal, `${principal}@example.invalid`],
  );
  await owner.query(
    "INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)",
    [operator, AT],
  );
  await owner.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operator]);
  await owner.query("UPDATE public.clients SET principal_id=$2,lifecycle_stage='customer' WHERE id=$1", [f.client, principal]);
  await owner.query("UPDATE public.subscriptions SET next_cycle_at=$2,started_at=$3 WHERE id=$1", [f.subscription, later(10 * 24), HISTORICAL_FROM]);
  await owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
  return { ...f, operator, principal };
}

async function createPreviewFixture() {
  const principal = randomUUID();
  const client = randomUUID();
  const subscription = randomUUID();
  const sku = randomUUID();
  const list = randomUUID();
  await owner.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [client, `${client}@example.invalid`, principal]);
  await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic','ZZ','XXX',$2)", [list, HISTORICAL_FROM]);
  await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Synthetic')", [sku, `synthetic-${sku}`]);
  await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Synthetic',true)", [sku, `SYNTHETIC-${sku}`]);
  await owner.query("INSERT INTO public.price_entries(variant_id,price_list_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'subscription',100,$3)", [sku, list, HISTORICAL_FROM]);
  await owner.query(
    `INSERT INTO public.subscriptions(id,client_id,status,cadence_days,edit_window_hours,next_cycle_at,started_at,price_list_id,currency_code)
      VALUES($1,$2,'active',17,72,greatest(now(), $3::timestamptz) + interval '60 days',$4,$5,'XXX')`,
    [subscription, client, AT, HISTORICAL_FROM, list],
  );
  await owner.query(
    "INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code) VALUES($1,$2,1,0,false,100,'XXX')",
    [subscription, sku],
  );
  await owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [subscription]);
  await owner.query(`INSERT INTO public.subscription_renewal_terms
    (subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
    SELECT id,currency_code,'fixture-stock','sandbox',now(),'fixture-authorization' FROM public.subscriptions WHERE id=$1`, [subscription]);
  return { principal, client, subscription, sku, list };
}

async function runActor<T>(principal: string, work: (db: PoolClient) => Promise<T>) {
  const db = await runtime.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal, role: "authenticated" })]);
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

beforeAll(async () => {
  container = await runPostgresContainer({
    name: `settings-wave3a-${process.pid}`,
    password: "synthetic-wave3a-policy",
  });
  if (!await waitForPostgresTcpReady(container.connectionString)) {
    throw new Error("settings wave3a PostgreSQL unavailable");
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
  await owner.query("DELETE FROM public.commerce_settings WHERE key = ANY($1::text[])", [[SLIDE_KEY, QUOTE_WINDOW_KEY]]);
});

afterAll(async () => {
  await closePostgres(container, [owner, runtime]);
}, postgresTeardownTimeoutMs);

it("admits the Wave 3A forward migration against the manifest prefix and locks function ACLs", async () => {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as {
    baseline: { file: string };
    forward: Array<{ file: string }>;
  };
  const prefix = [manifest.baseline, ...manifest.forward.filter(unit => unit.file < WAVE3A_MIGRATION)]
    .map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
  const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  expect(() => assertNativeStoreForward(registry, WAVE3A_MIGRATION, readFileSync(WAVE3A_MIGRATION), prefix)).not.toThrow();

  const { rows: procRows } = await owner.query<{
    sig: string;
    prosecdef: boolean;
    provolatile: string;
    proconfig: string[] | null;
    anon_exec: boolean;
    auth_exec: boolean;
    rt_exec: boolean;
    public_exec: boolean;
  }>(`
    SELECT sig,
      p.prosecdef,
      p.provolatile,
      p.proconfig,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
      has_function_privilege('starter_runtime', p.oid, 'EXECUTE') AS rt_exec,
      has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
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
      public_exec: false,
    })),
    {
      sig: "public.customer_support_apply_subscription_action_v1(uuid,uuid,text,jsonb,integer,text,timestamptz)",
      prosecdef: false,
      provolatile: "v",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      anon_exec: false,
      auth_exec: false,
      rt_exec: true,
      public_exec: false,
    },
    {
      sig: "public.customer_subscription_preview_bundle_as_actor(uuid,text,jsonb,jsonb,jsonb,integer,integer)",
      prosecdef: true,
      provolatile: "v",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      anon_exec: false,
      auth_exec: true,
      rt_exec: false,
      public_exec: false,
    },
    {
      sig: "public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz)",
      prosecdef: false,
      provolatile: "v",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      anon_exec: false,
      auth_exec: false,
      rt_exec: true,
      public_exec: false,
    },
  ]);

  // Even with browser default EXECUTE privileges present, replaying the migration revokes anon/authenticated.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      DROP FUNCTION ${newHelpers.join(", ")};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
    `);
    await client.query(readFileSync(WAVE3A_MIGRATION, "utf8"));
    for (const role of ["anon", "authenticated"]) {
      for (const callSql of [
        "SELECT public.account_support_operator_slide_max_days_validate('{\"revision\":\"x\",\"maxDays\":60}'::jsonb)",
        "SELECT public.account_support_operator_slide_max_days_read()",
        "SELECT public.subscription_edit_quote_ttl_minutes_validate('{\"revision\":\"x\",\"ttlMinutes\":15}'::jsonb)",
        "SELECT public.subscription_edit_quote_ttl_minutes_read()",
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

it("E5 preserves 60-day absence default, applies custom overrides (including > 99), keeps replay immutable, and fails closed", async () => {
  expect(DEFAULT_ACCOUNT_SUPPORT_OPERATOR_SLIDE_MAX_DAYS).toBe(60);
  expect(await readAccountSupportOperatorSlideMaxDaysOverride(owner)).toBeUndefined();
  expect(await readAccountSupportOperatorSlideMaxDaysPolicy(owner)).toEqual({ revision: "default", maxDays: 60 });
  expect((await runtime.query("SELECT public.account_support_operator_slide_max_days_read() AS result")).rows)
    .toEqual([{ result: 60 }]);

  // 1. Absent setting -> accepts 60d, refuses 61d (slide_out_of_window), rejects slideMinDays = 61 (22023).
  const fAbsent = await createOperatorSlideFixture();
  const absApplied = await call(runtime, "customer_support_apply_subscription_action_v1", [
    fAbsent.operator, fAbsent.subscription, "slide_next_cycle", { newNextCycleAt: later(60 * 24) }, 1, `abs-60-${randomUUID()}`, AT,
  ]);
  expect(absApplied).toMatchObject({ outcome: "applied" });
  expect(new Date(absApplied.nextCycleAt).toISOString()).toBe(later(60 * 24));

  const absRefused = await call(runtime, "customer_support_apply_subscription_action_v1", [
    fAbsent.operator, fAbsent.subscription, "slide_next_cycle", { newNextCycleAt: later(61 * 24) }, absApplied.templateVersion, `abs-61-${randomUUID()}`, AT,
  ]);
  expect(absRefused).toMatchObject({ outcome: "refused", refusalCode: "slide_out_of_window" });

  await expect(call(runtime, "customer_support_apply_subscription_action_v1", [
    fAbsent.operator, fAbsent.subscription, "slide_next_cycle", { slideMinDays: 61, newNextCycleAt: later(60 * 24) }, absApplied.templateVersion, `abs-min61-${randomUUID()}`, AT,
  ])).rejects.toMatchObject({ code: "22023", message: "customer_support_subscription_command_invalid" });

  // 2. Shorter override (maxDays = 14) accepts 14d, refuses 15d, rejects slideMinDays = 15.
  await installAccountSupportOperatorSlideMaxDaysPolicy(owner, { revision: "wave3a-14", maxDays: 14 });
  expect(await readAccountSupportOperatorSlideMaxDaysPolicy(runtime)).toEqual({ revision: "wave3a-14", maxDays: 14 });
  const fShort = await createOperatorSlideFixture();
  expect(await call(runtime, "customer_support_apply_subscription_action_v1", [
    fShort.operator, fShort.subscription, "slide_next_cycle", { newNextCycleAt: later(15 * 24) }, 1, `short-15-${randomUUID()}`, AT,
  ])).toMatchObject({ outcome: "refused", refusalCode: "slide_out_of_window" });
  await expect(call(runtime, "customer_support_apply_subscription_action_v1", [
    fShort.operator, fShort.subscription, "slide_next_cycle", { slideMinDays: 15, newNextCycleAt: later(14 * 24) }, 1, `short-min15-${randomUUID()}`, AT,
  ])).rejects.toMatchObject({ code: "22023", message: "customer_support_subscription_command_invalid" });
  const shortOk = await call(runtime, "customer_support_apply_subscription_action_v1", [
    fShort.operator, fShort.subscription, "slide_next_cycle", { newNextCycleAt: later(14 * 24) }, 1, `short-14-${randomUUID()}`, AT,
  ]);
  expect(shortOk).toMatchObject({ outcome: "applied" });
  expect(new Date(shortOk.nextCycleAt).toISOString()).toBe(later(14 * 24));

  // 3. Extended override (maxDays = 120) allows 3-digit slideMinDays (100) and sliding 120 days ahead,
  //    refuses 121 days ahead, and stays immutable when replayed after tightening maxDays down to 3.
  await installAccountSupportOperatorSlideMaxDaysPolicy(owner, { revision: "wave3a-120", maxDays: 120 });
  const fLong = await createOperatorSlideFixture();
  const longKey = `long-120-${randomUUID()}`;
  const longPayload = { slideMinDays: 100, newNextCycleAt: later(120 * 24) };
  const longApplied = await call(runtime, "customer_support_apply_subscription_action_v1", [
    fLong.operator, fLong.subscription, "slide_next_cycle", longPayload, 1, longKey, AT,
  ]);
  expect(longApplied).toMatchObject({ outcome: "applied" });
  expect(new Date(longApplied.nextCycleAt).toISOString()).toBe(later(120 * 24));

  expect(await call(runtime, "customer_support_apply_subscription_action_v1", [
    fLong.operator, fLong.subscription, "slide_next_cycle", { newNextCycleAt: later(121 * 24) }, longApplied.templateVersion, `long-121-${randomUUID()}`, AT,
  ])).toMatchObject({ outcome: "refused", refusalCode: "slide_out_of_window" });

  await installAccountSupportOperatorSlideMaxDaysPolicy(owner, { revision: "wave3a-tight-3", maxDays: 3 });
  const longReplay = await call(runtime, "customer_support_apply_subscription_action_v1", [
    fLong.operator, fLong.subscription, "slide_next_cycle", longPayload, 1, longKey, AT,
  ]);
  expect(longReplay).toEqual({ ...longApplied, outcome: "replayed" });

  // 4. Runtime cannot write commerce_settings (42501).
  await expect(installAccountSupportOperatorSlideMaxDaysPolicy(runtime, { revision: "unauth", maxDays: 30 }))
    .rejects.toMatchObject({ code: "42501" });

  // 5. Malformed rows fail closed with 22023 without persisting support command, audit, owner receipt, or event rows.
  const fBad = await createOperatorSlideFixture();
  const countSql = `SELECT
    (SELECT count(*)::integer FROM public.customer_support_subscription_commands WHERE target_id = $1) AS commands,
    (SELECT count(*)::integer FROM public.customer_support_subscription_audit_events WHERE target_id = $1) AS audits,
    (SELECT count(*)::integer FROM public.subscription_command_receipts WHERE subscription_id = $1) AS receipts,
    (SELECT count(*)::integer FROM public.subscription_events WHERE subscription_id = $1) AS events`;
  const beforeBad = (await owner.query(countSql, [fBad.subscription])).rows[0];

  for (const invalidValue of [
    null,
    "{bad",
    "[]",
    '{"revision":" ","maxDays":60}',
    '{"revision":"x","maxDays":2}',
    '{"revision":"x","maxDays":366}',
  ]) {
    await upsertSetting(SLIDE_KEY, invalidValue);
    await expect(runtime.query("SELECT public.account_support_operator_slide_max_days_read()"))
      .rejects.toMatchObject({ code: "22023", message: SLIDE_ERROR });
    await expect(call(runtime, "customer_support_apply_subscription_action_v1", [
      fBad.operator, fBad.subscription, "slide_next_cycle", { newNextCycleAt: later(20 * 24) }, 1, `bad-${randomUUID()}`, AT,
    ])).rejects.toMatchObject({ code: "22023", message: SLIDE_ERROR });
    await expect(readAccountSupportOperatorSlideMaxDaysPolicy(runtime)).rejects.toThrow(SLIDE_ERROR);
    expect((await owner.query(countSql, [fBad.subscription])).rows[0]).toEqual(beforeBad);
  }
});

it.each(slideCorpus)("E5 shared TS+SQL corpus: $name", async ({ input, accepted, normalized, decodedNormalized, code }) => {
  await upsertSetting(SLIDE_KEY, input);
  const sqlValidate = () => runtime.query("SELECT public.account_support_operator_slide_max_days_validate($1::jsonb) AS result", [input]);
  const sqlRead = () => runtime.query("SELECT public.account_support_operator_slide_max_days_read() AS result");

  if (accepted) {
    const parsed = JSON.parse(input);
    expect(validateAccountSupportOperatorSlideMaxDays(parsed)).toEqual(normalized);
    expect(await readAccountSupportOperatorSlideMaxDaysOverride(runtime)).toEqual(normalized);
    expect((await sqlValidate()).rows).toEqual([{ result: normalized }]);
    expect((await sqlRead()).rows).toEqual([{ result: normalized!.maxDays }]);
  } else {
    const refusal = { code: "22023", message: code };
    await expect(sqlValidate()).rejects.toMatchObject(refusal);
    await expect(sqlRead()).rejects.toMatchObject(refusal);
    if (decodedNormalized) {
      await expect(readAccountSupportOperatorSlideMaxDaysOverride(runtime)).resolves.toEqual(decodedNormalized);
    } else {
      await expect(readAccountSupportOperatorSlideMaxDaysOverride(runtime)).rejects.toThrow(code!);
    }
  }
});

it("E6 preserves 15-minute absence default, applies custom overrides in both preview RPCs cleanly, keeps replays immutable, and fails closed", async () => {
  expect(DEFAULT_SUBSCRIPTION_EDIT_QUOTE_TTL_MINUTES).toBe(15);
  expect(await readSubscriptionEditQuoteTtlMinutesOverride(owner)).toBeUndefined();
  expect(await readSubscriptionEditQuoteTtlMinutesPolicy(owner)).toEqual({ revision: "default", ttlMinutes: 15 });
  expect((await runtime.query("SELECT public.subscription_edit_quote_ttl_minutes_read() AS result")).rows)
    .toEqual([{ result: 15 }]);

  const measureActorPreview = async (f: Awaited<ReturnType<typeof createPreviewFixture>>, key: string) => {
    const core = JSON.stringify([{ variantId: f.sku, qty: 2 }]);
    return runActor(f.principal, async db => {
      const { rows } = await db.query<{
        ts: Date;
        result: {
          preview: {
            canApply: boolean;
            quoteHash: string;
            quoteExpiresAt: string;
          };
        };
      }>(
        "SELECT statement_timestamp() AS ts, public.customer_subscription_preview_bundle_as_actor($1,$2,$3,'[]','{}',17,1) AS result",
        [f.subscription, key, core],
      );
      return rows[0]!;
    });
  };

  const verifyQuotedMinutes = async (
    subscriptionId: string,
    quoteHash: string,
    quoteExpiresAt: string,
    baseMs: number,
    expectedMinutes: number,
  ) => {
    expect(Date.parse(quoteExpiresAt) - baseMs).toBe(expectedMinutes * 60_000);
    const { rows } = await owner.query<{ expires_at: Date; quote_hash: string }>(
      "SELECT expires_at, quote_hash FROM public.subscription_edit_quotes WHERE subscription_id=$1 AND quote_hash=$2",
      [subscriptionId, quoteHash],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expires_at.getTime()).toBe(Date.parse(quoteExpiresAt));
  };

  const commandPreview = async (f: Awaited<ReturnType<typeof createPreviewFixture>>, key: string) =>
    call(runtime, "subscription_command_preview", [
      f.principal, f.client, key, f.subscription, "update_plan_length", { cadenceDays: 24, expectedTemplateVersion: 1 }, AT,
    ]);

  // 1. Absent row -> 15 minutes in both customer_subscription_preview_bundle_as_actor and subscription_command_preview.
  const fAbsent = await createPreviewFixture();
  const absActor = await measureActorPreview(fAbsent, `actor-abs-${randomUUID()}`);
  expect(absActor.result.preview.canApply).toBe(true);
  await verifyQuotedMinutes(
    fAbsent.subscription,
    absActor.result.preview.quoteHash,
    absActor.result.preview.quoteExpiresAt,
    absActor.ts.getTime(),
    15,
  );

  const absCmd = await commandPreview(fAbsent, `cmd-abs-${randomUUID()}`);
  expect(absCmd).toMatchObject({ status: "previewed", canApply: true });
  await verifyQuotedMinutes(fAbsent.subscription, absCmd.quoteHash, absCmd.quoteExpiresAt, Date.parse(AT), 15);

  // Also check quoteHash consistency against SQL formula directly for subscription_command_preview.
  const { rows: hashVerifyRows } = await owner.query<{ stored_hash: string; computed_hash: string }>(
    `SELECT q.quote_hash AS stored_hash,
      encode(sha256(convert_to(
        q.idempotency_key || ':' || r.command_fingerprint || ':' || q.proposed_lines::text || ':' || q.expires_at::text,
        'UTF8')), 'hex') AS computed_hash
     FROM public.subscription_edit_quotes q
     JOIN public.subscription_command_receipts r
       ON r.subscription_id = q.subscription_id AND r.quote_hash = q.quote_hash
     WHERE q.quote_hash = $1`,
    [absCmd.quoteHash],
  );
  expect(hashVerifyRows).toEqual([{ stored_hash: absCmd.quoteHash, computed_hash: absCmd.quoteHash }]);

  // 2. Installed overrides (45 minutes and boundary 1440 minutes) apply to uncached previews,
  //    and replay remains immutable after changing the policy again.
  for (const minutes of [45, 1440] as const) {
    await installSubscriptionEditQuoteTtlMinutesPolicy(owner, { revision: `wave3a-${minutes}m`, ttlMinutes: minutes });
    expect(await readSubscriptionEditQuoteTtlMinutesPolicy(runtime)).toEqual({ revision: `wave3a-${minutes}m`, ttlMinutes: minutes });

    const fOvr = await createPreviewFixture();
    const actorKey = `actor-${minutes}-${randomUUID()}`;
    const cmdKey = `cmd-${minutes}-${randomUUID()}`;

    const actorRes = await measureActorPreview(fOvr, actorKey);
    await verifyQuotedMinutes(
      fOvr.subscription,
      actorRes.result.preview.quoteHash,
      actorRes.result.preview.quoteExpiresAt,
      actorRes.ts.getTime(),
      minutes,
    );

    const cmdRes = await commandPreview(fOvr, cmdKey);
    expect(cmdRes).toMatchObject({ status: "previewed", canApply: true });
    await verifyQuotedMinutes(fOvr.subscription, cmdRes.quoteHash, cmdRes.quoteExpiresAt, Date.parse(AT), minutes);

    // Mutate setting after previews succeeded and confirm both replays keep original quoteHash & quoteExpiresAt.
    await installSubscriptionEditQuoteTtlMinutesPolicy(owner, { revision: `wave3a-later-${minutes}`, ttlMinutes: 1 });
    const replayedActor = await measureActorPreview(fOvr, actorKey);
    expect(replayedActor.result.preview.quoteHash).toBe(actorRes.result.preview.quoteHash);
    expect(Date.parse(replayedActor.result.preview.quoteExpiresAt))
      .toBe(Date.parse(actorRes.result.preview.quoteExpiresAt));

    const replayedCmd = await commandPreview(fOvr, cmdKey);
    expect(replayedCmd).toEqual(cmdRes);
  }

  // 3. Runtime cannot write commerce_settings (42501).
  await expect(installSubscriptionEditQuoteTtlMinutesPolicy(runtime, { revision: "unauth", ttlMinutes: 30 }))
    .rejects.toMatchObject({ code: "42501" });

  // 4. Malformed rows fail closed with 22023 in both preview functions without persisting quotes or refused receipts.
  const fBad = await createPreviewFixture();
  const countSql = `SELECT
    (SELECT count(*)::integer FROM public.subscription_edit_quotes WHERE subscription_id = $1) AS quotes,
    (SELECT count(*)::integer FROM public.subscription_command_receipts WHERE subscription_id = $1) AS receipts`;
  const beforeBad = (await owner.query(countSql, [fBad.subscription])).rows[0];

  for (const invalidValue of [
    null,
    "{bad",
    "[]",
    '{"revision":" ","ttlMinutes":15}',
    '{"revision":"x","ttlMinutes":0}',
    '{"revision":"x","ttlMinutes":1441}',
  ]) {
    await upsertSetting(QUOTE_WINDOW_KEY, invalidValue);
    await expect(runtime.query("SELECT public.subscription_edit_quote_ttl_minutes_read()"))
      .rejects.toMatchObject({ code: "22023", message: QUOTE_WINDOW_ERROR });
    await expect(measureActorPreview(fBad, `bad-actor-${randomUUID()}`))
      .rejects.toMatchObject({ code: "22023", message: QUOTE_WINDOW_ERROR });
    await expect(commandPreview(fBad, `bad-cmd-${randomUUID()}`))
      .rejects.toMatchObject({ code: "22023", message: QUOTE_WINDOW_ERROR });
    await expect(readSubscriptionEditQuoteTtlMinutesPolicy(runtime)).rejects.toThrow(QUOTE_WINDOW_ERROR);
    expect((await owner.query(countSql, [fBad.subscription])).rows[0]).toEqual(beforeBad);
  }
});

it.each(quoteWindowCorpus)("E6 shared TS+SQL corpus: $name", async ({ input, accepted, normalized, decodedNormalized, code }) => {
  await upsertSetting(QUOTE_WINDOW_KEY, input);
  const sqlValidate = () => runtime.query("SELECT public.subscription_edit_quote_ttl_minutes_validate($1::jsonb) AS result", [input]);
  const sqlRead = () => runtime.query("SELECT public.subscription_edit_quote_ttl_minutes_read() AS result");

  if (accepted) {
    const parsed = JSON.parse(input);
    expect(validateSubscriptionEditQuoteTtlMinutes(parsed)).toEqual(normalized);
    expect(await readSubscriptionEditQuoteTtlMinutesOverride(runtime)).toEqual(normalized);
    expect((await sqlValidate()).rows).toEqual([{ result: normalized }]);
    expect((await sqlRead()).rows).toEqual([{ result: normalized!.ttlMinutes }]);
  } else {
    const refusal = { code: "22023", message: code };
    await expect(sqlValidate()).rejects.toMatchObject(refusal);
    await expect(sqlRead()).rejects.toMatchObject(refusal);
    if (decodedNormalized) {
      await expect(readSubscriptionEditQuoteTtlMinutesOverride(runtime)).resolves.toEqual(decodedNormalized);
    } else {
      await expect(readSubscriptionEditQuoteTtlMinutesOverride(runtime)).rejects.toThrow(code!);
    }
  }
});
