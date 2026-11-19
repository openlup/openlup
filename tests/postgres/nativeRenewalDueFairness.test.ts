import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { env as processEnvironment } from "node:process";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { AT, call, later, prepareOriginal, renewal, type Renewal } from "./subscriptionNativeFixture.js";

const installation = { generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "postgres",
  bootstrapLogin: "postgres", runtimeLogin: "starter_runtime", restoreLogin: "starter_restore" } as const;
const normalDueSignature = "public.subscription_stock_wait_normal_due(integer,timestamptz)";
let resource: PostgresContainer | undefined, pool: Pool, db: PoolClient;

beforeAll(async () => {
  resource = await runPostgresContainer({ name: `native-due-${process.pid}`, password: "synthetic-renewal" });
  if (!await waitForPostgresTcpReady(resource.connectionString)) throw new Error("native renewal PostgreSQL unavailable");
  pool = new Pool({ connectionString: resource.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  await pool.query("CREATE ROLE starter_runtime LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS; CREATE ROLE starter_restore LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS");
  await createPostgresMigrationRunner({ connectionString: resource.connectionString }, { installation, poolFactory: () => pool }).apply();
  db = await pool.connect();
}, postgresSetupTimeoutMs);

afterAll(async () => {
  db?.release();
  await closePostgres(resource, pool);
}, postgresTeardownTimeoutMs);

const scoped = async (test: () => Promise<void>) => {
  await db.query("BEGIN");
  try { await test(); }
  finally { await db.query("ROLLBACK"); }
};

it("admits fresh renewals alongside a full page of expired claims", async () => scoped(async () => {
  await db.query("UPDATE public.subscriptions SET status='paused' WHERE status='active'");
  const expired: Renewal[] = [];
  for (let index = 0; index < 5; index++) {
    expired.push(await renewal(db,10,1,`00000000-0000-4000-8000-${String(index + 1).padStart(12,"0")}`));
  }
  const prepared = await prepareOriginal(db,expired[0]);
  const fresh: Renewal[] = [];
  const scheduled = later(.25);
  for (let index = 0; index < 3; index++) {
    const f = await renewal(db,10,1,`00000000-0000-4000-8000-${String(index + 10).padStart(12,"0")}`);
    await db.query("DELETE FROM public.subscription_renewal_operations WHERE id=$1",[f.operation]);
    await db.query("UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1",[f.subscription,scheduled]);
    fresh.push(f);
  }
  const at = later(1);
  const page = async (limit: number) => (await call(db,"subscription_stock_wait_normal_due",[limit,at]))
    .map((row: {subscription_id:string})=>row.subscription_id);
  expect(await page(1)).toEqual([expired[0].subscription]);
  expect(await page(4)).toEqual([expired[0].subscription,expired[1].subscription,fresh[0].subscription,fresh[1].subscription]);
  expect(await page(6)).toEqual([...expired.slice(0,3),...fresh].map(f=>f.subscription));
  const resumed = await call(db,"subscription_claim_due_renewal",[
    expired[0].identity,expired[0].fingerprint,expired[0].snapshot,"replacement-worker",300,at,
  ]);
  expect(resumed).toMatchObject({acquired:true,state:"attempt_prepared",operationId:expired[0].operation,
    settlementIntentId:prepared.settlementIntentId,externalAttemptRef:"original-ack"});
  const snapshot = {...fresh[0].snapshot,scheduledAt:scheduled};
  const identity = await call(db,"subscription_renewal_identity",[fresh[0].subscription,scheduled]);
  const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  expect(await call(db,"subscription_claim_due_renewal",[identity,fingerprint,snapshot,"fresh-worker",300,at]))
    .toMatchObject({acquired:true,state:"claimed"});
  expect(await page(4)).toEqual([expired[1].subscription,expired[2].subscription,fresh[1].subscription,fresh[2].subscription]);
}));
it.skipIf(processEnvironment.OPENLUP_BENCH_NATIVE_RENEWAL_DUE !== "1")(
  "benchmarks native renewal selection at 10,000 and 100,000 cycles", async () => {
    const original = sqlStatements(readFileSync("db/platform/migrations/20261024180000_subscription_stock_wait.sql","utf8"))
      .find(sql=>sql.includes("CREATE FUNCTION public.subscription_stock_wait_normal_due("));
    if (!original) throw new Error("historical renewal selector is missing");
    const previous = original.replace("CREATE FUNCTION","CREATE OR REPLACE FUNCTION");
    const installed = (await db.query("SELECT pg_get_functiondef($1::regprocedure) AS body",[normalDueSignature])).rows[0].body as string;
    const at = later(1);
    for (const size of [10_000,100_000]) await scoped(async () => {
      await db.query("UPDATE public.subscriptions SET status='paused' WHERE status='active'");
      await db.query(`CREATE TEMP TABLE due_fixture ON COMMIT DROP AS
          SELECT md5('due-bench:'||n)::uuid AS id, n <= $1::integer/2 AS has_claim FROM generate_series(1,$1::integer) n`,[size]);
      await db.query(`INSERT INTO public.clients(id,email)
          SELECT id,id::text||'@example.invalid' FROM due_fixture`);
      await db.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at)
          SELECT id,id,28,$1::timestamptz-CASE WHEN has_claim THEN interval '1 day' ELSE interval '0' END FROM due_fixture`,[AT]);
      await db.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,next_cycle_number,currency_code,
          stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
          SELECT id,2,'XXX','benchmark','fixture',$1,'frozen-mandate' FROM due_fixture`,[AT]);
      await db.query(`INSERT INTO public.subscription_renewal_operations(subscription_id,scheduled_at,cycle_number,
          identity_key,operation_fingerprint,cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at)
          SELECT id,s.next_cycle_at,2,public.subscription_renewal_identity(id,s.next_cycle_at),repeat('a',64),'{}',
          gen_random_uuid(),'benchmark',$1::timestamptz,$1::timestamptz+interval '5 minutes'
          FROM due_fixture JOIN public.subscriptions s USING(id) WHERE has_claim`,[AT]);
      await db.query("ANALYZE public.subscriptions; ANALYZE public.subscription_renewal_terms; ANALYZE public.subscription_renewal_operations");
      for (const [name,definition] of [["previous",previous],["installed",installed]]) {
        await db.query(definition);
        const body = (await db.query("SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure",[normalDueSignature])).rows[0].prosrc as string;
        const explain = body.replaceAll(/\bp_limit\b/gu,"$1::integer").replaceAll(/\bp_now\b/gu,"$2::timestamptz").trim().replace(/;$/u,"");
        const elapsed: number[] = [];
        let plan: unknown;
        for (let sample=0;sample<=5;sample++) {
          const report = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${explain}`,[50,at])).rows[0]["QUERY PLAN"][0];
          plan = report.Plan;
          if (sample) elapsed.push(Number(report["Execution Time"]));
        }
        elapsed.sort((a,b)=>a-b);
        const page = await call(db,"subscription_stock_wait_normal_due",[50,at]);
        const fresh = page.filter((row:{scheduled_at:string})=>Date.parse(row.scheduled_at)===Date.parse(AT)).length;
        process.stdout.write(`${JSON.stringify({cycles:size,selector:name,fresh,page:page.length,medianMs:elapsed[2],maxMs:elapsed[4]})}\n`);
        if (processEnvironment.OPENLUP_BENCH_EXPLAIN === "1") process.stdout.write(`${JSON.stringify(plan)}\n`);
      }
    });
  },120_000);
