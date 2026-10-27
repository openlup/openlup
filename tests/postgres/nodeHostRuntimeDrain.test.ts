import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNodeHost } from "@openlup/platform/composition";
import { getBundleDescriptor } from "@openlup/platform/kernel";
import { createPgAdvisoryLock, createNodeScheduler, type AdvisoryLockQuerier, type CronScheduler } from "@openlup/platform/scheduler";
import {
  closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer,
} from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined;
const jobs = [{ jobId: "runtime-drain", schedule: "* * * * *", path: "/api/cron/runtime-drain" }];

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function timers() {
  const callbacks: Array<() => void | Promise<void>> = [];
  const cron: CronScheduler = { schedule: (_expression, callback) => {
    callbacks.push(callback);
    return { stop() {} };
  } };
  return { cron, callbacks };
}

async function dedicatedSession() {
  const client = new Client({ connectionString: container!.connectionString });
  await client.connect();
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= client.end());
  const lock = createPgAdvisoryLock(client as unknown as AdvisoryLockQuerier, close);
  return { client, lock, close };
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Node host drain proof requires real PostgreSQL");
  container = await runPostgresContainer({ name: `node-host-drain-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Node host drain PostgreSQL unavailable");
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container); }, postgresTeardownTimeoutMs);

describe("Node callback ownership on real dedicated PostgreSQL sessions", () => {
  it("refuses overlapping callbacks on one session without releasing the first callback's ownership", async () => {
    const owner = await dedicatedSession();
    const replacement = await dedicatedSession();
    const { cron, callbacks } = timers();
    const entered = latch();
    const finish = latch();
    let invocations = 0;
    const body = vi.fn(async () => {
      invocations += 1;
      entered.resolve();
      // A broken reentrant acquisition must finish the second invocation so the
      // assertion observes the duplicate rather than waiting on the first latch.
      if (invocations === 1) await finish.promise;
    });
    const adapter = createNodeScheduler({ cron, jobs, env: {}, lock: owner.lock });
    adapter.register({ ...jobs[0], handler: body });
    const running = callbacks[0]();
    try {
      await entered.promise;
      await callbacks[0]();
      expect(body).toHaveBeenCalledTimes(1);
      await expect(replacement.lock.tryAcquire(jobs[0].jobId)).resolves.toBe(false);
      finish.resolve();
      await running;
      await expect(replacement.lock.tryAcquire(jobs[0].jobId)).resolves.toBe(true);
      await replacement.lock.release(jobs[0].jobId);
    } finally {
      finish.resolve();
      await Promise.allSettled([running, Promise.resolve(adapter.stopAll())]);
      await Promise.all([owner.close(), replacement.close()]);
    }
  });

  it("excludes the replacement host through stop and admits it after the active callback drains", async () => {
    const owner = await dedicatedSession();
    const replacement = await dedicatedSession();
    const entered = latch();
    const finish = latch();
    const oldTimers = timers();
    const newTimers = timers();
    const replacementBody = vi.fn();
    const runtime = { handle: vi.fn() };
    const host = createNodeHost({
      composeBundle: () => ({
        id: "node-supabase",
        descriptor: { ...getBundleDescriptor("node-supabase"), readReadiness: () => ({ ok: true }) },
        ports: { http: runtime, scheduler: null, blob: null, data: null, migrations: null, analytics: null, transactional: null },
      }),
      createHttpRuntime: () => runtime,
      loadSchedulerJobs: () => jobs,
    });
    const oldHost = await host.serveNode({ env: {}, cron: oldTimers.cron, listen: false, advisoryLock: owner.lock,
      scheduledJobHandlers: { "runtime-drain": async () => { entered.resolve(); await finish.promise; } } });
    const newHost = await host.serveNode({ env: {}, cron: newTimers.cron, listen: false, advisoryLock: replacement.lock,
      scheduledJobHandlers: { "runtime-drain": replacementBody } });
    const running = oldTimers.callbacks[0]();
    await entered.promise;
    const stopping = oldHost.stop();
    // Observe a possible release failure immediately, even when an assertion
    // throws before the finally block joins the admitted callback.
    const completed = Promise.allSettled([running, stopping]);
    try {
      expect(oldHost.stop()).toBe(stopping);
      // A real query distinguishes a live dedicated owner from an early end().
      await expect(owner.client.query("SELECT 1 AS alive")).resolves.toMatchObject({ rows: [{ alive: 1 }] });
      await newTimers.callbacks[0]();
      expect(replacementBody).not.toHaveBeenCalled();
      finish.resolve();
      await Promise.all([running, stopping]);
      await oldTimers.callbacks[0]();
      await newTimers.callbacks[0]();
      expect(replacementBody).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      await completed;
      await Promise.allSettled([oldHost.stop(), newHost.stop()]);
      await Promise.all([owner.close(), replacement.close()]);
    }
  });
});
