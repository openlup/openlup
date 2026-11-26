import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createPostgresSubscriptionSaveOfferAcceptor,
  DEFAULT_SUBSCRIPTION_RESCHEDULE_TIMEZONE,
  installSubscriptionRescheduleTimeZonePolicy,
  readSubscriptionRescheduleTimeZoneOverride,
  readSubscriptionRescheduleTimeZonePolicy,
  validateSubscriptionRescheduleTimeZone,
  type SubscriptionRescheduleTimeZonePolicy,
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
import { AT, call, recordRenewalMethod, renewal } from "./subscriptionNativeFixture.js";

type TimeZoneCorpusCase = {
  name: string;
  input: string;
  accepted: boolean;
  normalized?: SubscriptionRescheduleTimeZonePolicy;
  code?: string;
};

const timeZoneCorpus = JSON.parse(readFileSync(
  new URL("../../packages/platform/test/subscriptions/subscription_reschedule_timezone.json", import.meta.url),
  "utf8",
)) as TimeZoneCorpusCase[];

const WAVE4A_MIGRATION = "db/platform/migrations/20261129130002_settings_wave4a_reschedule_timezone.sql";
const TIMEZONE_KEY = "subscription_reschedule_timezone";
const TIMEZONE_ERROR = "subscription_reschedule_timezone_policy_invalid";
const HISTORICAL_FROM = "2020-01-01T00:00:00.000Z";

const TERMS = {
  pauseDays: 14,
  pauseMonths: 1,
  slideMinDays: 3,
  slideMaxDays: 60,
  orderNowDelayMinutes: 5,
  reactivateDelayDays: 2,
};

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
  "public.subscription_reschedule_timezone_validate(jsonb)",
  "public.subscription_reschedule_timezone_read()",
] as const;

const replacedFunctions = [
  "public.subscription_apply_lifecycle_action(uuid,text,uuid,text,jsonb,timestamptz,jsonb)",
  "public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz)",
  "public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz,jsonb)",
  "public.customer_support_apply_subscription_action_v1(uuid,uuid,text,jsonb,integer,text,timestamptz)",
] as const;

async function upsertSetting(key: string, value: string | null) {
  await owner.query(
    `INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`,
    [key, value],
  );
}

async function createSlideFixture(nextCycleAt: string, keepOperation = false) {
  const f = await renewal(owner);
  const operator = randomUUID();
  const principal = randomUUID();
  if (!keepOperation) {
    await owner.query("DELETE FROM public.subscription_renewal_operations WHERE id=$1", [f.operation]);
  } else {
    await recordRenewalMethod(owner, f);
  }
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
  await owner.query(
    "UPDATE public.subscriptions SET next_cycle_at=$2,started_at=$3,edit_window_hours=24 WHERE id=$1",
    [f.subscription, nextCycleAt, HISTORICAL_FROM],
  );
  await owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
  return { ...f, operator, principal };
}

beforeAll(async () => {
  container = await runPostgresContainer({
    name: `settings-wave4a-${process.pid}`,
    password: "synthetic-wave4a-policy",
  });
  if (!await waitForPostgresTcpReady(container.connectionString)) {
    throw new Error("settings wave4a PostgreSQL unavailable");
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
  await owner.query("DELETE FROM public.commerce_settings WHERE key=$1", [TIMEZONE_KEY]);
});

afterAll(async () => {
  await closePostgres(container, [owner, runtime]);
}, postgresTeardownTimeoutMs);

it("registers the Wave 4A forward cleanly with pinned search_path and service_role grants", async () => {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as {
    baseline: { file: string };
    forward: Array<{ file: string }>;
  };
  const prefix = [manifest.baseline, ...manifest.forward.filter(unit => unit.file < WAVE4A_MIGRATION)]
    .map(unit => ({ path: unit.file, bytes: readFileSync(unit.file) }));
  const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  expect(() => assertNativeStoreForward(registry, WAVE4A_MIGRATION, readFileSync(WAVE4A_MIGRATION), prefix)).not.toThrow();

  for (const sig of [...newHelpers, ...replacedFunctions]) {
    const { rows } = await owner.query<{ proconfig: string[] | null }>(
      "SELECT proconfig FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure",
      [sig],
    );
    expect(rows[0]?.proconfig, sig).toContain("search_path=pg_catalog, pg_temp");
  }
  for (const sig of newHelpers) {
    const { rows } = await owner.query<{ pub: boolean; sr: boolean }>(
      `SELECT has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS pub,
              has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS sr`,
      [sig],
    );
    expect(rows[0], sig).toEqual({ pub: false, sr: true });
  }
  await expect(installSubscriptionRescheduleTimeZonePolicy(runtime, { revision: "unauth", timeZone: "Europe/Berlin" }))
    .rejects.toMatchObject({ code: "42501" });
});

it("preserves default UTC day boundaries and shifts calendar-day noop boundaries in Europe/Berlin across all 4 SQL functions", async () => {
  expect(DEFAULT_SUBSCRIPTION_RESCHEDULE_TIMEZONE).toBe("UTC");
  expect(await readSubscriptionRescheduleTimeZoneOverride(runtime)).toBeUndefined();
  expect(await readSubscriptionRescheduleTimeZonePolicy(runtime)).toEqual({ revision: "default", timeZone: "UTC" });
  expect((await runtime.query<{ tz: string }>("SELECT public.subscription_reschedule_timezone_read() AS tz")).rows[0]?.tz).toBe("UTC");

  const now = "2031-01-05T12:00:00.000Z";
  // Pair A: 2031-01-15T23:30Z (2031-01-16 00:30 CET) -> 2031-01-16T00:30Z (2031-01-16 01:30 CET)
  // UTC: different days (15 vs 16); Europe/Berlin: same day (16 vs 16).
  const pairANext = "2031-01-15T23:30:00.000Z";
  const pairATarget = "2031-01-16T00:30:00.000Z";

  // Pair B: 2031-01-15T22:30Z (2031-01-15 23:30 CET) -> 2031-01-15T23:30Z (2031-01-16 00:30 CET)
  // UTC: same day (15 vs 15); Europe/Berlin: different days (15 vs 16).
  const pairBNext = "2031-01-15T22:30:00.000Z";
  const pairBTarget = "2031-01-15T23:30:00.000Z";

  // 1. Default UTC: Pair B is noop in all 4 SQL functions.
  const utcB = await createSlideFixture(pairBNext);
  expect(await call(runtime, "subscription_command_preview",
    [utcB.principal, utcB.client, `utc-prev-b-${randomUUID()}`, utcB.subscription, "slide_next_cycle", { newNextCycleAt: pairBTarget }, now]))
    .toMatchObject({ status: "noop" });
  expect(await call(runtime, "subscription_apply_lifecycle_action",
    [utcB.client, `utc-life-b-${randomUUID()}`, utcB.subscription, "slide_next_cycle", { newNextCycleAt: pairBTarget }, now, TERMS]))
    .toMatchObject({ subscriptionAction: { status: "noop" } });
  expect(await call(runtime, "subscription_command_apply",
    [utcB.principal, utcB.client, `utc-apply-b-${randomUUID()}`, utcB.subscription, "slide_next_cycle", { newNextCycleAt: pairBTarget }, now, TERMS]))
    .toMatchObject({ status: "noop" });
  expect(await call(runtime, "customer_support_apply_subscription_action_v1",
    [utcB.operator, utcB.subscription, "slide_next_cycle", { newNextCycleAt: pairBTarget }, 1, `utc-op-b-${randomUUID()}`, now]))
    .toMatchObject({ outcome: "noop" });

  // Default UTC: Pair A is NOT noop (preview refuses unsupported, apply moves next_cycle_at).
  const utcA = await createSlideFixture(pairANext);
  expect(await call(runtime, "subscription_command_preview",
    [utcA.principal, utcA.client, `utc-prev-a-${randomUUID()}`, utcA.subscription, "slide_next_cycle", { newNextCycleAt: pairATarget }, now]))
    .toMatchObject({ status: "refused", reason: "subscription_command_preview_unsupported" });
  expect(await call(runtime, "subscription_command_apply",
    [utcA.principal, utcA.client, `utc-apply-a-${randomUUID()}`, utcA.subscription, "slide_next_cycle", { newNextCycleAt: pairATarget }, now, TERMS]))
    .toMatchObject({ status: "applied" });

  // 2. Installed Europe/Berlin: Pair A becomes noop in all 4 SQL functions!
  await installSubscriptionRescheduleTimeZonePolicy(owner, { revision: "wave4a-cet", timeZone: "Europe/Berlin" });
  expect(await readSubscriptionRescheduleTimeZonePolicy(runtime)).toEqual({ revision: "wave4a-cet", timeZone: "Europe/Berlin" });

  const cetA = await createSlideFixture(pairANext);
  expect(await call(runtime, "subscription_command_preview",
    [cetA.principal, cetA.client, `cet-prev-a-${randomUUID()}`, cetA.subscription, "slide_next_cycle", { newNextCycleAt: pairATarget }, now]))
    .toMatchObject({ status: "noop" });
  expect(await call(runtime, "subscription_apply_lifecycle_action",
    [cetA.client, `cet-life-a-${randomUUID()}`, cetA.subscription, "slide_next_cycle", { newNextCycleAt: pairATarget }, now, TERMS]))
    .toMatchObject({ subscriptionAction: { status: "noop" } });
  expect(await call(runtime, "subscription_command_apply",
    [cetA.principal, cetA.client, `cet-apply-a-${randomUUID()}`, cetA.subscription, "slide_next_cycle", { newNextCycleAt: pairATarget }, now, TERMS]))
    .toMatchObject({ status: "noop" });
  expect(await call(runtime, "customer_support_apply_subscription_action_v1",
    [cetA.operator, cetA.subscription, "slide_next_cycle", { newNextCycleAt: pairATarget }, 1, `cet-op-a-${randomUUID()}`, now]))
    .toMatchObject({ outcome: "noop" });

  // Installed Europe/Berlin: Pair B is now DIFFERENT days -> preview refuses, and lifecycle/command/operator apply!
  const cetB1 = await createSlideFixture(pairBNext);
  expect(await call(runtime, "subscription_command_preview",
    [cetB1.principal, cetB1.client, `cet-prev-b-${randomUUID()}`, cetB1.subscription, "slide_next_cycle", { newNextCycleAt: pairBTarget }, now]))
    .toMatchObject({ status: "refused", reason: "subscription_command_preview_unsupported" });
  expect(await call(runtime, "subscription_apply_lifecycle_action",
    [cetB1.client, `cet-life-b-${randomUUID()}`, cetB1.subscription, "slide_next_cycle", { newNextCycleAt: pairBTarget }, now, TERMS]))
    .toMatchObject({ subscriptionAction: { status: "applied" } });

  const cetB2 = await createSlideFixture(pairBNext);
  expect(await call(runtime, "subscription_command_apply",
    [cetB2.principal, cetB2.client, `cet-apply-b-${randomUUID()}`, cetB2.subscription, "slide_next_cycle", { newNextCycleAt: pairBTarget }, now, TERMS]))
    .toMatchObject({ status: "applied" });

  const cetB3 = await createSlideFixture(pairBNext);
  expect(await call(runtime, "customer_support_apply_subscription_action_v1",
    [cetB3.operator, cetB3.subscription, "slide_next_cycle", { newNextCycleAt: pairBTarget }, 1, `cet-op-b-${randomUUID()}`, now]))
    .toMatchObject({ outcome: "applied" });
});

it("preserves FOR UPDATE NOWAIT lock-bypass semantics in subscription_command_apply using the configured time zone", async () => {
  const now = "2031-01-05T12:00:00.000Z";
  await installSubscriptionRescheduleTimeZonePolicy(owner, { revision: "wave4a-lock", timeZone: "Europe/Berlin" });

  // 1. Same-local-day slide bypasses the locked renewal operation and returns noop without blocking.
  const sameDay = await createSlideFixture("2031-01-15T23:30:00.000Z", true);
  const holder1 = await owner.connect();
  try {
    await holder1.query("BEGIN");
    await holder1.query("SELECT 1 FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE", [sameDay.operation]);
    const res = await call(runtime, "subscription_command_apply",
      [sameDay.principal, sameDay.client, `lock-same-${randomUUID()}`, sameDay.subscription, "slide_next_cycle",
        { newNextCycleAt: "2031-01-16T00:30:00.000Z" }, now, TERMS]);
    expect(res).toEqual(expect.objectContaining({ status: "noop" }));
  } finally {
    await holder1.query("ROLLBACK").catch(() => {});
    holder1.release();
  }

  // 2. Different-local-day slide (even when same UTC day) hits FOR UPDATE NOWAIT and refuses operation_busy.
  const diffDay = await createSlideFixture("2031-01-15T22:30:00.000Z", true);
  const holder2 = await owner.connect();
  try {
    await holder2.query("BEGIN");
    await holder2.query("SELECT 1 FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE", [diffDay.operation]);
    const res = await call(runtime, "subscription_command_apply",
      [diffDay.principal, diffDay.client, `lock-diff-${randomUUID()}`, diffDay.subscription, "slide_next_cycle",
        { newNextCycleAt: "2031-01-15T23:30:00.000Z" }, now, TERMS]);
    expect(res).toMatchObject({ status: "refused", reason: "subscription_command_operation_busy" });
  } finally {
    await holder2.query("ROLLBACK").catch(() => {});
    holder2.release();
  }
});

it("computes save-offer reschedule target in the configured IANA time zone across DST in postgresCommandStore", async () => {
  // 2031-03-29T07:00:00Z is 08:00 CET in Europe/Berlin; +7 calendar days crosses spring DST (2031-03-30)
  // so 2031-04-05 08:00 CEST is 2031-04-05T06:00:00.000000Z (whereas UTC +7 days is 07:00:00.000000Z).
  const preDstNextCycle = "2031-03-29T07:00:00.000Z";
  const now = "2031-03-22T12:00:00.000Z";
  const f = await createSlideFixture(preDstNextCycle);
  const withTransaction = async <T>(fn: (db: Pool) => Promise<T>): Promise<T> => fn(runtime);
  const acceptor = createPostgresSubscriptionSaveOfferAcceptor({
    withTransaction,
    offerPolicy: {
      offerPresentation: "ask_permission_first",
      defaultOffer: "reschedule",
      allowedPausePresets: ["2_weeks", "1_month"],
      preselectedPausePreset: "2_weeks",
      rescheduleOfferDays: 7,
    },
    lifecycleTerms: TERMS,
  });

  // Default UTC -> 07:00Z
  const utcOffers = await acceptor.readPresentations({
    actor: { kind: "customer", actorId: f.principal, clientId: f.client },
    subscriptionIds: [f.subscription],
    now,
  });
  expect(utcOffers.get(f.subscription)).toMatchObject({ kind: "reschedule", newNextCycleAt: "2031-04-05T07:00:00.000000Z" });

  // Europe/Berlin -> 06:00Z (preserves 08:00 local wall-clock time across DST)
  await installSubscriptionRescheduleTimeZonePolicy(owner, { revision: "wave4a-dst", timeZone: "Europe/Berlin" });
  const berlinOffers = await acceptor.readPresentations({
    actor: { kind: "customer", actorId: f.principal, clientId: f.client },
    subscriptionIds: [f.subscription],
    now,
  });
  expect(berlinOffers.get(f.subscription)).toMatchObject({ kind: "reschedule", newNextCycleAt: "2031-04-05T06:00:00.000000Z" });
});

it("fails closed with 22023 subscription_reschedule_timezone_policy_invalid on malformed settings across all 4 SQL functions and save-offer store", async () => {
  const now = "2031-01-05T12:00:00.000Z";
  const f = await createSlideFixture("2031-01-15T23:30:00.000Z");
  const target = "2031-01-16T00:30:00.000Z";
  const countSql = "SELECT count(*)::integer AS n FROM public.subscription_command_receipts WHERE subscription_id=$1";
  const beforeReceipts = (await owner.query<{ n: number }>(countSql, [f.subscription])).rows[0]!.n;

  const withTransaction = async <T>(fn: (db: Pool) => Promise<T>): Promise<T> => fn(runtime);
  const acceptor = createPostgresSubscriptionSaveOfferAcceptor({
    withTransaction,
    offerPolicy: {
      offerPresentation: "ask_permission_first",
      defaultOffer: "reschedule",
      allowedPausePresets: ["2_weeks"],
      preselectedPausePreset: "2_weeks",
      rescheduleOfferDays: 7,
    },
    lifecycleTerms: TERMS,
  });

  for (const invalidValue of [
    null,
    "{bad",
    "[]",
    '{"revision":" ","timeZone":"UTC"}',
    '{"revision":"x","timeZone":"Mars/Olympus"}',
    '{"revision":"x","timeZone":"+02:00"}',
  ]) {
    await upsertSetting(TIMEZONE_KEY, invalidValue);
    const refusal = { code: "22023", message: TIMEZONE_ERROR };
    await expect(runtime.query("SELECT public.subscription_reschedule_timezone_read()")).rejects.toMatchObject(refusal);
    await expect(call(runtime, "subscription_apply_lifecycle_action",
      [f.client, `bad-life-${randomUUID()}`, f.subscription, "slide_next_cycle", { newNextCycleAt: target }, now, TERMS]))
      .rejects.toMatchObject(refusal);
    await expect(call(runtime, "subscription_command_preview",
      [f.principal, f.client, `bad-prev-${randomUUID()}`, f.subscription, "slide_next_cycle", { newNextCycleAt: target }, now]))
      .rejects.toMatchObject(refusal);
    await expect(call(runtime, "subscription_command_apply",
      [f.principal, f.client, `bad-apply-${randomUUID()}`, f.subscription, "slide_next_cycle", { newNextCycleAt: target }, now, TERMS]))
      .rejects.toMatchObject(refusal);
    await expect(call(runtime, "customer_support_apply_subscription_action_v1",
      [f.operator, f.subscription, "slide_next_cycle", { newNextCycleAt: target }, 1, `bad-op-${randomUUID()}`, now]))
      .rejects.toMatchObject(refusal);
    await expect(acceptor.readPresentations({
      actor: { kind: "customer", actorId: f.principal, clientId: f.client },
      subscriptionIds: [f.subscription],
      now,
    })).rejects.toMatchObject(refusal);
    await expect(readSubscriptionRescheduleTimeZonePolicy(runtime)).rejects.toThrow(TIMEZONE_ERROR);
    expect((await owner.query<{ n: number }>(countSql, [f.subscription])).rows[0]!.n).toBe(beforeReceipts);
  }
});

it.each(timeZoneCorpus)("E9 shared TS+SQL corpus: $name", async ({ input, accepted, normalized, code }) => {
  await upsertSetting(TIMEZONE_KEY, input);
  const sqlValidate = () => runtime.query("SELECT public.subscription_reschedule_timezone_validate($1::jsonb) AS result", [input]);
  const sqlRead = () => runtime.query("SELECT public.subscription_reschedule_timezone_read() AS result");

  if (accepted) {
    const parsed = JSON.parse(input);
    expect(validateSubscriptionRescheduleTimeZone(parsed)).toEqual(normalized);
    expect(await readSubscriptionRescheduleTimeZoneOverride(runtime)).toEqual(normalized);
    expect((await sqlValidate()).rows).toEqual([{ result: normalized }]);
    expect((await sqlRead()).rows).toEqual([{ result: normalized!.timeZone }]);
  } else {
    const refusal = { code: "22023", message: code };
    await expect(sqlValidate()).rejects.toMatchObject(refusal);
    await expect(sqlRead()).rejects.toMatchObject(refusal);
    await expect(readSubscriptionRescheduleTimeZoneOverride(runtime)).rejects.toThrow(code!);
  }
});
