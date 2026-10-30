import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";

const replayPath = "supabase/migrations/20261025090000_subscription_dunning_attempt_replay.sql";
const advancePath = "supabase/migrations/20261025090100_subscription_dunning_attributed_advance.sql";
const CYCLE = "a9300000-0000-4000-8000-000000000001";
const SUB = "a9200000-0000-4000-8000-000000000001";
const ORDER = "a9400000-0000-4000-8000-000000000001";
let container: PostgresContainer | undefined;
let admin: Pool;
let template: string;
let sequence = 0;
const chain = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
const source = (path: string) => readFileSync(path, "utf8");
const url = (database: string) => container!.connectionStringFor(database).replace("postgres://postgres:", "postgres://supabase_admin:");

beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `attempt-replay-${process.pid}`, password: "synthetic-conformance" });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  admin = new Pool({ connectionString: url("postgres") });
  template = `attempt_template_${process.pid}`;
  await admin.query(`CREATE DATABASE ${template} TEMPLATE template0`);
  await admin.query(`GRANT ALL ON DATABASE ${template} TO postgres`);
  const db = new Pool({ connectionString: url(template), max: 1 });
  try {
    // Preserve the image's auth/extension prerequisites in a quiescent template.
    // pg_cron is database-bound and the managed-compat adapter's dblink needs the
    // managed host's privileged-extension allowance; neither is a prerequisite here.
    const initialSchema = execFileSync("docker", ["exec", `attempt-replay-${process.pid}`, "pg_dump", "-U", "supabase_admin", "--schema-only", "--no-owner", "--no-privileges", "postgres"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .replace(/^\\(?:un)?restrict .*$/gmu, "")
      .replace(/^CREATE EXTENSION IF NOT EXISTS pg_cron[^;]*;/gmu, "")
      .replace(/^COMMENT ON EXTENSION pg_cron[^;]*;/gmu, "")
      .replace(/^CREATE EXTENSION IF NOT EXISTS dblink[^;]*;/gmu, "")
      .replace(/^COMMENT ON EXTENSION dblink[^;]*;/gmu, "");
    await db.query(`SET ROLE postgres; ${initialSchema}; RESET ROLE; ALTER SCHEMA public OWNER TO postgres`);
    await db.query(source("scripts/public-reference/subscription-prereqs.sql"));
    for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
      await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role`);
    }
    await db.query("SET ROLE postgres");
    for (const name of chain) await db.query(source(`supabase/migrations/${name}`).replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
  } finally { await db.end(); }
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, admin); }, postgresTeardownTimeoutMs);

type Fixture = { pool: Pool; a: PoolClient; b: PoolClient; attemptA: string; intent: string };
async function fixture(run: (f: Fixture) => Promise<void>) {
  const name = `attempt_case_${process.pid}_${++sequence}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  const pool = new Pool({ connectionString: url(name), max: 4 });
  let a: PoolClient | undefined, b: PoolClient | undefined;
  try {
    a = await pool.connect(); b = await pool.connect();
    const proof = source("supabase/tests/subscription_dunning_duplicate_observation_test.sql");
    await a.query(proof.slice(proof.indexOf("INSERT INTO public.clients"), proof.indexOf("CREATE TEMP TABLE first_observation")));
    const row = (await a.query("SELECT (SELECT id FROM replay_attempts WHERE name='A') attempt, (SELECT id FROM replay_intent) intent")).rows[0];
    await run({ pool, a, b, attemptA: row.attempt, intent: row.intent });
  } finally {
    for (const client of [a, b]) if (client) { await client.query("ROLLBACK"); client.release(); }
    await pool.end(); await admin.query(`DROP DATABASE ${name}`);
  }
}
async function observe(f: Fixture, key: string, attempt: string | null, db = f.a, failureClass = "soft_retryable") {
  return (await db.query(`SELECT public.subscription_handle_payment_failure_dunning($1,$2,$3,$4,$5,
    (SELECT retry_attempt FROM public.subscription_cycles WHERE id=$2),
    (SELECT next_retry_at FROM public.subscription_cycles WHERE id=$2),
    'declined','2026-10-25T09:00:00Z',$6::text,$7::uuid) result`, [`observation:${key}`, CYCLE, SUB, ORDER, f.intent, failureClass, attempt])).rows[0].result.subscriptionDunning;
}
async function snapshot(pool: Pool, tables?: string[]) {
  const state: Record<string, unknown> = {};
  const names = tables ?? (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename as string);
  for (const table of names) state[table] = (await pool.query(`SELECT to_jsonb(t) row,t.xmin::text version FROM public."${table.replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text`)).rows;
  return state;
}
const authorityTables = ["subscription_dunning_cases", "subscription_payment_recovery_tokens", "subscription_dunning_notifications", "subscription_cycles", "subscriptions"];
async function waitForLock(pool: Pool, pid: number) {
  for (let i = 0; i < 100; i++) {
    if ((await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("second observation never reached the aggregate lock");
}
async function historicalBodies(db: PoolClient) {
  for (const name of ["subscription_handle_payment_failure_dunning_before_cancel_fence", "subscription_handle_payment_failure_dunning"]) {
    let body: string | undefined;
    for (const file of chain.filter(file => file < "20261025090000")) {
      for (const statement of sqlStatements(source(`supabase/migrations/${file}`), true)) {
        if (new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION public\\.${name}\\(`, "u").test(statement)) body = statement;
      }
    }
    if (!body) throw new Error(`missing historical ${name}`);
    await db.query(body.replace(/^CREATE FUNCTION/u, "CREATE OR REPLACE FUNCTION"));
  }
}
async function legacyOpen(f: Fixture, key: string) {
  return (await f.a.query(`SELECT public.subscription_handle_payment_failure_dunning($1,$2,$3,$4,$5,
    (SELECT retry_attempt FROM public.subscription_cycles WHERE id=$2),NULL,'declined','2026-10-25T09:00:00Z','soft_retryable'::text) result`, [key, CYCLE, SUB, ORDER, f.intent])).rows[0].result.subscriptionDunning;
}
async function upgrade(db: PoolClient) {
  await db.query("ALTER TABLE public.subscription_dunning_cases DROP COLUMN failed_payment_attempt_id, DROP COLUMN failure_observation_result");
  await db.query(source(replayPath)); await db.query(source(advancePath));
}
async function nextAttempt(f: Fixture, key: string) {
  return (await f.a.query("SELECT pg_temp.failed_attempt($1) id", [key])).rows[0].id as string;
}

describe("managed attempt replay against real PostgreSQL", () => {
  it("same and stale observations preserve canonical result and every authority tuple", async () => {
    await fixture(async f => {
      const first = await observe(f, "first-A", f.attemptA);
      const before = await snapshot(f.pool, authorityTables);
      const duplicate = await observe(f, "duplicate-A", f.attemptA, f.a, "hard_do_not_retry");
      expect(duplicate).toEqual({ ...first, replayed: true });
      expect(await snapshot(f.pool, authorityTables)).toEqual(before);
      const attemptB = await nextAttempt(f, "next-B");
      const newer = await observe(f, "first-B", attemptB);
      const advanced = await snapshot(f.pool, authorityTables);
      expect(await observe(f, "stale-A", f.attemptA, f.a, "hard_do_not_retry")).toEqual({ ...newer, replayed: true });
      expect(await snapshot(f.pool, authorityTables)).toEqual(advanced);
    });
  });

  it("serializes different keys for one attempt into one effect and one replay", async () => {
    await fixture(async f => {
      await f.a.query("BEGIN");
      const first = await observe(f, "race-A-one", f.attemptA);
      const pid = (await f.b.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      const pending = observe(f, "race-A-two", f.attemptA, f.b);
      await waitForLock(f.pool, pid); await f.a.query("COMMIT");
      const second = await pending;
      expect([first.replayed, second.replayed]).toEqual([false, true]);
      expect(second.recoveryUrlPath).toBe(first.recoveryUrlPath);
      expect((await f.pool.query("SELECT count(*)::int n FROM public.subscription_payment_recovery_tokens")).rows[0].n).toBe(1);
    });
  });

  it.each(["A-first", "B-first"])("keeps the newer attempt in %s lock order", async order => {
    await fixture(async f => {
      await observe(f, "initial-A", f.attemptA);
      const attemptB = await nextAttempt(f, "concurrent-B");
      await f.a.query("BEGIN");
      const first = await observe(f, "ordered-first", order === "A-first" ? f.attemptA : attemptB);
      const pid = (await f.b.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      const pending = observe(f, "ordered-second", order === "A-first" ? attemptB : f.attemptA, f.b);
      await waitForLock(f.pool, pid); await f.a.query("COMMIT");
      const second = await pending;
      expect([order === "A-first" ? first.replayed : second.replayed, order === "B-first" ? first.replayed : second.replayed]).toEqual([true, false]);
      expect((await f.pool.query("SELECT count(*)::int total,count(*) FILTER(WHERE revoked_at IS NULL)::int live FROM public.subscription_payment_recovery_tokens")).rows[0]).toEqual({ total: 2, live: 1 });
      expect((await f.pool.query("SELECT failed_payment_attempt_id FROM public.subscription_dunning_cases")).rows[0].failed_payment_attempt_id).toBe(attemptB);
    });
  });

  it("refuses missing attribution and equal-rung identity conflict without writes", async () => {
    await fixture(async f => {
      await observe(f, "initial-A", f.attemptA);
      await f.a.query(`WITH attempt AS (INSERT INTO public.commerce_payment_attempts(payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency)
        SELECT id,payment_id,'example','conflicting-attempt','failed',amount_cents,currency FROM public.commerce_payment_intents WHERE id=$1 RETURNING id)
        INSERT INTO public.subscription_events(subscription_id,cycle_id,event_type,payload)
        SELECT $2,$3,'subscription.payment_failed',jsonb_build_object('paymentIntentId',$1::text,'paymentAttemptId',id,'retryAttempt',1,'source','payment.control.v0') FROM attempt`, [f.intent, SUB, CYCLE]);
      const conflicting = (await f.a.query("SELECT id FROM public.commerce_payment_attempts WHERE idempotency_key='conflicting-attempt'")).rows[0].id;
      const before = await snapshot(f.pool);
      await expect(observe(f, "missing", null)).rejects.toMatchObject({ code: "55000", message: "subscription_dunning_failed_attempt_unattributed" });
      await expect(observe(f, "conflicting", conflicting)).rejects.toMatchObject({ code: "55000", message: "subscription_dunning_failed_attempt_ambiguous" });
      expect(await snapshot(f.pool)).toEqual(before);
    });
  });

  it.each(["known", "missing", "conflicting"] as const)("upgrades %s historical attribution without restoring revoked tokens", async kind => {
    await fixture(async f => {
      await historicalBodies(f.a);
      const first = await legacyOpen(f, "legacy-A");
      await f.a.query("UPDATE public.subscription_payment_recovery_tokens SET revoked_at=now()");
      let live = first.recoveryUrlPath;
      if (kind === "known") live = (await legacyOpen(f, "legacy-duplicate-A")).recoveryUrlPath;
      if (kind === "missing") await f.a.query("DELETE FROM public.subscription_events");
      if (kind === "conflicting") await f.a.query(`WITH attempt AS (INSERT INTO public.commerce_payment_attempts(payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency)
        SELECT id,payment_id,'example','historical-conflict','failed',amount_cents,currency FROM public.commerce_payment_intents WHERE id=$1 RETURNING id)
        INSERT INTO public.subscription_events(subscription_id,cycle_id,event_type,payload)
        SELECT $2,$3,'subscription.retry_scheduled',jsonb_build_object('paymentIntentId',$1::text,'paymentAttemptId',id,'retryAttempt',1,'source','payment.control.v0') FROM attempt`, [f.intent, SUB, CYCLE]);
      const before = await snapshot(f.pool, ["subscription_payment_recovery_tokens"]);
      await upgrade(f.a);
      expect((await f.pool.query("SELECT failed_payment_attempt_id FROM public.subscription_dunning_cases")).rows[0].failed_payment_attempt_id).toBe(kind === "known" ? f.attemptA : null);
      expect(await snapshot(f.pool, ["subscription_payment_recovery_tokens"])).toEqual(before);
      const receipt = (await f.pool.query("SELECT metadata FROM public.commerce_idempotency_keys WHERE scope='subscription.dunning.failure' AND idempotency_key='legacy-A'")).rows[0];
      expect(receipt.metadata.failedPaymentAttemptId ?? null).toBe(kind === "known" ? f.attemptA : null);
      if (kind === "known") expect((await observe(f, "upgraded-A", f.attemptA)).recoveryUrlPath).toBe(live);
      else await expect(observe(f, "unattributed-history", f.attemptA)).rejects.toMatchObject({ code: "55000" });
      expect(await snapshot(f.pool, ["subscription_payment_recovery_tokens"])).toEqual(before);
    });
  });

  it.each([
    { source: "customer_payment_recovery_start", used: false },
    { source: "customer_support_recovery", used: true },
  ])("refuses cache-missing same/stale then advances $source used=$used", async ({ source: origin, used }) => {
    await fixture(async f => {
      await historicalBodies(f.a);
      const attemptA = await nextAttempt(f, "historical-A");
      const first = await legacyOpen(f, "rotated-legacy-A");
      const rotated = (await f.a.query(`SELECT public.subscription_rotate_payment_recovery_token($1,encode(sha256(convert_to('rotated-historical-authority','UTF8')),'hex'),now()+interval '14 days',$2) id`, [first.caseId, origin])).rows[0].id;
      if (used) await f.a.query("UPDATE public.subscription_payment_recovery_tokens SET used_at=now() WHERE id=$1", [rotated]);
      const tokensBefore = await snapshot(f.pool, ["subscription_payment_recovery_tokens"]);
      await upgrade(f.a);
      expect((await f.pool.query("SELECT failed_payment_attempt_id,failure_observation_result FROM public.subscription_dunning_cases")).rows[0]).toEqual({ failed_payment_attempt_id: attemptA, failure_observation_result: null });
      expect(await snapshot(f.pool, ["subscription_payment_recovery_tokens"])).toEqual(tokensBefore);
      const before = await snapshot(f.pool);
      for (const attempt of [attemptA, f.attemptA]) {
        await expect(observe(f, `no-cache-${attempt}`, attempt)).rejects.toMatchObject({ code: "55000", message: "subscription_dunning_replay_unavailable" });
        expect(await snapshot(f.pool)).toEqual(before);
      }
      const attemptB = await nextAttempt(f, "historical-B");
      // The first port's misplaced cache guard must fail this same advancement.
      const firstPortBody = sqlStatements(source(replayPath)).find(statement =>
        statement.startsWith("CREATE OR REPLACE FUNCTION public.subscription_handle_payment_failure_dunning_before_cancel_fence(") && statement.includes("p_failed_payment_attempt_id uuid"));
      expect(firstPortBody).toBeDefined();
      await f.a.query("BEGIN");
      try {
        await f.a.query(firstPortBody!);
        await expect(observe(f, "advance-without-cache", attemptB)).rejects.toMatchObject({ code: "55000" });
      } finally { await f.a.query("ROLLBACK"); }
      const advanced = await observe(f, "advance-without-cache", attemptB);
      expect(advanced).toMatchObject({ replayed: false, retryAttempt: 3, customerNotificationQueued: true });
      expect(advanced.recoveryUrlPath).not.toBe(first.recoveryUrlPath);
      const tokens = (await f.pool.query("SELECT id,revoked_at,used_at FROM public.subscription_payment_recovery_tokens")).rows;
      expect(tokens).toHaveLength(3); expect(tokens.filter(token => token.revoked_at === null)).toHaveLength(1);
      expect(tokens.filter(token => token.revoked_at !== null)).toHaveLength(2);
      expect(tokens.find(token => token.id === rotated)?.revoked_at).not.toBeNull();
      expect(Boolean(tokens.find(token => token.id === rotated)?.used_at)).toBe(used);
      expect((await f.pool.query("SELECT recovery_url_path FROM public.subscription_dunning_notifications WHERE recipient_kind='customer' AND retry_attempt=3")).rows).toEqual([{ recovery_url_path: advanced.recoveryUrlPath }]);
      expect((await observe(f, "replay-new-B", attemptB)).recoveryUrlPath).toBe(advanced.recoveryUrlPath);
    });
  });
});

async function reconciliationFixture(f: Fixture) {
  await f.a.query("SELECT public.commerce_payment_control_record_attempt('reconcile-record',$1,'example','reconcile-provider-attempt',NULL,'processing',NULL,'{}','{}')", [f.intent]);
  return (await f.a.query("SELECT active_attempt_id,payment_id FROM public.commerce_payment_intents WHERE id=$1", [f.intent])).rows[0] as { active_attempt_id: string; payment_id: string };
}
async function reconcile(f: Fixture, expected: { active_attempt_id: string; payment_id: string }, overrideAttempt = expected.active_attempt_id) {
  return (await f.a.query(`SELECT public.commerce_payment_control_apply_reconciliation_result('reconcile-apply',$1,$2,$3,$4,
    'example','reconcile-provider-attempt','processing','failed','failed','2026-10-25T09:00:00Z','declined','2026-10-25T09:00:00Z','{}','soft_retryable','test') result`,
  [ORDER, f.intent, overrideAttempt, expected.payment_id])).rows[0].result.paymentReconciliationApply;
}
const namedRefusals = ["failed_attempt_unattributed", "case_unattributed", "replay_unavailable", "failed_attempt_ambiguous", "failed_attempt_rung_mismatch"];
async function plantHandoffFault(db: PoolClient, message: string, code = "55000") {
  // Synthetic fault at the exact handoff isolates reconciliation's catch boundary.
  await db.query(`CREATE OR REPLACE FUNCTION public.subscription_open_dunning_from_failed_payment_result(
    p_idempotency_key text,p_payment_intent_id uuid,p_provider_event_id text,p_failure_reason text,p_occurred_at timestamptz,p_failure_class text,p_failed_payment_attempt_id uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
    BEGIN RAISE EXCEPTION '${message}' USING ERRCODE='${code}'; END; $$`);
}

describe("reconciliation attribution boundary", () => {
  it("records its validated applied attempt in the dunning receipt", async () => {
    await fixture(async f => {
      const expected = await reconciliationFixture(f);
      const applied = await reconcile(f, expected);
      expect(applied.applied).toBe(true);
      expect(applied.paymentResult.paymentAttemptId).toBe(expected.active_attempt_id);
      expect((await f.pool.query("SELECT metadata->>'failedPaymentAttemptId' attempt FROM public.commerce_idempotency_keys WHERE scope='subscription.dunning.failure' AND idempotency_key='reconcile-apply:dunning'")).rows[0].attempt).toBe(expected.active_attempt_id);
    });
  });

  it.each(namedRefusals)("isolates only named refusal %s and retains sticky evidence", async refusal => {
    await fixture(async f => {
      await observe(f, "initial-case", f.attemptA);
      const before = await snapshot(f.pool, ["subscription_payment_recovery_tokens", "subscription_dunning_notifications"]);
      const expected = await reconciliationFixture(f);
      const message = `subscription_dunning_${refusal}`;
      await plantHandoffFault(f.a, message);
      const applied = await reconcile(f, expected);
      expect(applied.applied).toBe(true);
      expect(applied.paymentResult.paymentAttemptId).toBe(expected.active_attempt_id);
      expect(applied.subscriptionWebhookDunning).toMatchObject({ opened: false, reason: message });
      expect((await f.pool.query("SELECT status FROM public.commerce_payment_attempts WHERE id=$1", [expected.active_attempt_id])).rows[0].status).toBe("failed");
      const evidence = (await f.pool.query("SELECT payment_attempt_id,payload FROM public.commerce_payment_reconciliation_runs WHERE idempotency_key='reconcile-apply:evidence'")).rows[0];
      expect(evidence.payment_attempt_id).toBe(expected.active_attempt_id);
      expect(evidence.payload).toMatchObject({ applied: true, dunningObservationRefusal: message });
      expect((await reconcile(f, expected)).replayed).toBe(true);
      await f.a.query("UPDATE public.subscription_cycles SET status='paid',next_retry_at=NULL");
      const later = await reconcile(f, expected);
      expect(later).toMatchObject({ replayed: true, subscriptionWebhookDunning: { reason: message } });
      expect(await snapshot(f.pool, ["subscription_payment_recovery_tokens", "subscription_dunning_notifications"])).toEqual(before);
    });
  });

  it.each([{ message: "unrelated_handoff_failure", code: "55000" }, { message: "subscription_dunning_case_unattributed", code: "22023" }])(
    "rolls back payment application on unlisted error $message/$code", async ({ message, code }) => {
      await fixture(async f => {
        const expected = await reconciliationFixture(f);
        await plantHandoffFault(f.a, message, code);
        const before = await snapshot(f.pool);
        await expect(reconcile(f, expected)).rejects.toMatchObject({ message, code });
        expect(await snapshot(f.pool)).toEqual(before);
      });
    },
  );

  it("refuses claim drift and rolls back the result application", async () => {
    await fixture(async f => {
      const expected = await reconciliationFixture(f);
      const before = await snapshot(f.pool);
      await expect(reconcile(f, expected, f.attemptA)).rejects.toMatchObject({ code: "22023", message: "payment_reconciliation_apply_claim_mismatch" });
      expect(await snapshot(f.pool)).toEqual(before);
    });
  });

  it("preserves real historical case-attribution refusal after payment application", async () => {
    await fixture(async f => {
      await observe(f, "historical-case", f.attemptA);
      await f.a.query("UPDATE public.subscription_dunning_cases SET failed_payment_attempt_id=NULL,failure_observation_result=NULL");
      const expected = await reconciliationFixture(f);
      const applied = await reconcile(f, expected);
      expect(applied.subscriptionWebhookDunning.reason).toBe("subscription_dunning_case_unattributed");
      expect((await reconcile(f, expected)).replayed).toBe(true);
    });
  });
});
