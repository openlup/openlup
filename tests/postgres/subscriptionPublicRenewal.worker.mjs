import pg from "pg";
import { createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import { createNativeRenewalCodec, createNativeSubscriptionBinding, createPostgresRenewalSettlementPort,
  createPostgresSandboxRenewalRail, createSandboxRenewalPolicy } from "@openlup/platform/subscriptions";

process.once("message", async ({ when, workerId, holdAfterDispatch, runtimeUrl, methodRef, population }) => {
  const pool = new pg.Pool({ connectionString: runtimeUrl });
  const now = () => when;
  const withSession = async work => {
    const db = await pool.connect();
    try { return await work(db); } finally { db.release(); }
  };
  const withTransaction = work => withSession(async db => {
    await db.query("BEGIN");
    try { const result = await work(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; }
  });
  const codec = createNativeRenewalCodec();
  const rail = createPostgresSandboxRenewalRail(pool, { now, scenario: "ambiguous" });
  let executions = 0, reads = 0;
  const unexpectedRetry = () => { throw new Error("unexpected retry on the normal renewal lane"); };
  const binding = createNativeSubscriptionBinding({
    enabled: true, batchLimit: 7, population, executor: pool, withTransaction,
    withRunLease: (population, work) => withSession(async db => {
      const lock = "hashtextextended($1,0)";
      if (!(await db.query(`SELECT pg_try_advisory_lock(${lock}) AS acquired`, [population])).rows[0].acquired) return null;
      try { return await work(); } finally { await db.query(`SELECT pg_advisory_unlock(${lock})`, [population]); }
    }),
    codec, settlement: db => createPostgresRenewalSettlementPort(db, codec, withTransaction),
    inventory: createPostgresRenewalReservationPort(pool), policy: createSandboxRenewalPolicy(methodRef),
    paymentRails: { resolve: channel => channel !== "sandbox" ? null : { ...rail,
      async execute(input) {
        executions++;
        const result = await rail.execute(input);
        if (holdAfterDispatch) {
          process.send({ stage: "acknowledged", executions, reads, externalAttemptRef: result.externalAttemptRef });
          // Keep the installed run and its session lease open until the parent kills this process.
          await new Promise(() => {});
        }
        return result;
      },
      async readOutcome(input) { reads++; return rail.readOutcome(input); },
    } },
    retry: { readFrozenMandate: unexpectedRetry, retryInput: unexpectedRetry,
      payments: { execute: unexpectedRetry, readOutcome: unexpectedRetry }, recoveredTemplate: "recovered" },
    failureTemplate: "failed", recoveryPath: "/recover", workerId, now,
    catalogue: { version: "fixture", migration: "fixture" },
    readiness: async () => ({ state: "ready" }),
  });
  try {
    const result = await binding.services.run();
    await pool.end();
    process.send({ stage: "complete", result, executions, reads });
  } catch (error) {
    process.exitCode = 1;
    process.send({ error: error instanceof Error ? error.message : "normal renewal run failed" });
    await pool.end();
  } finally { process.disconnect(); }
});
