import { afterEach, describe, expect, it, vi } from "vitest";

import { closeCustomerDiagnosticRuntimeLanes } from "./customerDiagnosticHistoryBinding.js";
import {
  CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME,
  resolveCustomerDiagnosticPruneInvocationSource,
  runCustomerDiagnosticPrune,
} from "./customerDiagnosticPruneRuntime.js";

const runId = "33333333-3333-4333-8333-333333333333";
const counts = { eventsDeleted: 2, segmentsDeleted: 1, limitsDeleted: 0, accessDeleted: 3 };
const pruneEnv = { COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED: "true", CUSTOMER_DIAGNOSTIC_RETENTION_DAYS: "14" };
const portableEnv = { ...pruneEnv, PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://local" };

type RpcCall = [string, Record<string, unknown>];

function managedClient(options: {
  prune?: { data?: unknown; error?: { message: string } };
  claim?: { acquired: boolean; run_id: string | null; reason: string };
  control?: { data: unknown; error: unknown };
} = {}) {
  const calls: RpcCall[] = [];
  const control = options.control ?? { data: { last_status: "success", last_success_at: null }, error: null };
  const client = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      if (name === "customer_diagnostic_prune_v1") {
        return options.prune ?? { data: counts, error: null };
      }
      if (name === "platform_claim_job_run_v3") {
        return {
          data: options.claim ?? { acquired: true, run_id: runId, reason: "acquired" },
          error: null,
        };
      }
      return { data: true, error: null };
    }),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => control }) }),
    }),
  };
  return { client, calls, names: () => calls.map(([name]) => name) };
}

function portableLane(options: { failPruneAt?: number } = {}) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let transactions = 0;
  let pruneCalls = 0;
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      if (text.includes("customer_diagnostic_prune_v1")) {
        pruneCalls += 1;
        if (options.failPruneAt === pruneCalls) throw new Error("deadlock detected");
        return { rows: [{ customer_diagnostic_prune_v1: counts }] };
      }
      if (text.includes("platform_claim_job_run_v3")) {
        return { rows: [{ acquired: true, run_id: runId, reason: "acquired" }] };
      }
      return { rows: [{ released: true }] };
    },
  };
  return {
    statements,
    texts: () => statements.map(({ text }) => text),
    transactions: () => transactions,
    createPostgresLane: (() => ({
      run: async (work: (c: unknown) => unknown) => { transactions += 1; return work(client); },
      close: async () => undefined,
    })) as never,
  };
}

function managedOptions(client: unknown) {
  return { bindData: (() => ({ asService: (work: (c: unknown) => unknown) => work(client) })) as never };
}

describe("customer diagnostic prune runtime", () => {
  afterEach(async () => { await closeCustomerDiagnosticRuntimeLanes(); });

  it("drains while collection is switched off, claiming as a worker with an honest source", async () => {
    const managed = managedClient();
    // No COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED in this env: retention must
    // run exactly when the ingest binding would refuse.
    const result = await runCustomerDiagnosticPrune({
      env: pruneEnv, batchSize: 500, options: managedOptions(managed.client),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, ...counts, deleted: 6, batches: 1, morePossible: false });
    expect(managed.names()).toEqual([
      "platform_claim_job_run_v3", "customer_diagnostic_prune_v1", "platform_finish_job_run_v3",
    ]);
    expect(managed.calls[0]![1]).toMatchObject({
      p_job_name: CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME,
      p_trigger_kind: "worker",
      p_invocation_source: "unattributed_post",
    });
    expect(managed.calls[1]![1]).toEqual({ p_batch_size: 500 });
    expect(managed.calls[2]![1]).toMatchObject({
      p_run_id: runId,
      p_status: "success",
      p_checked: 1,
      p_updated: 6,
      p_metadata: expect.objectContaining({ ...counts, morePossible: false, driver: "unattributed_post" }),
    });
  });

  it("attributes the poker only on its own scheduler header, and stays unattributed otherwise", async () => {
    const attributed = managedClient();
    await runCustomerDiagnosticPrune({
      env: pruneEnv,
      schedulerSource: "github_actions_poker_schedule",
      options: managedOptions(attributed.client),
    });
    expect(attributed.calls[0]![1]).toMatchObject({ p_invocation_source: "github_poker" });

    for (const header of [undefined, "", "curl", "github_actions_schedule"]) {
      const unattributed = managedClient();
      await runCustomerDiagnosticPrune({
        env: pruneEnv, schedulerSource: header, options: managedOptions(unattributed.client),
      });
      expect(unattributed.calls[0]![1]).toMatchObject({ p_invocation_source: "unattributed_post" });
    }

    expect(resolveCustomerDiagnosticPruneInvocationSource("github_actions_poker_dispatch")).toBe("github_poker");
    expect(resolveCustomerDiagnosticPruneInvocationSource(null)).toBe("unattributed_post");
  });

  it("runs the portable lane through the direct PostgreSQL ledger with the scheduler's own source", async () => {
    const lane = portableLane();
    const result = await runCustomerDiagnosticPrune({
      env: portableEnv, invocationSource: "node_cron", options: { createPostgresLane: lane.createPostgresLane },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, ...counts, batches: 1 });
    expect(lane.texts()).toEqual([
      expect.stringContaining("platform_claim_job_run_v3"),
      expect.stringContaining("customer_diagnostic_prune_v1"),
      expect.stringContaining("platform_finish_job_run_v3"),
    ]);
    expect(lane.statements[0]!.values).toEqual(expect.arrayContaining(["worker", "node_cron"]));
    // One transaction per statement: the claim, the batch and the finish must
    // commit independently on a lane that wraps each callback in BEGIN/COMMIT.
    expect(lane.transactions()).toBe(3);
  });

  it("still finishes the run failed when a batch aborts mid-drain on the portable lane", async () => {
    // The claim, each batch and the finish are separate transactions, so the
    // failing second batch cannot abort the transaction the finish needs — a
    // shared one would raise 25P02 and roll the claim away, leaving no attempt.
    const lane = portableLane({ failPruneAt: 2 });
    const result = await runCustomerDiagnosticPrune({
      env: portableEnv,
      invocationSource: "node_cron",
      batchSize: 2,
      options: { createPostgresLane: lane.createPostgresLane },
    });

    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ ok: false, error: "customer_diagnostic_prune_failed" });
    expect(lane.texts()).toEqual([
      expect.stringContaining("platform_claim_job_run_v3"),
      expect.stringContaining("customer_diagnostic_prune_v1"),
      expect.stringContaining("customer_diagnostic_prune_v1"),
      expect.stringContaining("platform_finish_job_run_v3"),
    ]);
    expect(lane.statements.at(-1)!.values).toEqual(expect.arrayContaining([runId, "failed"]));
    expect(lane.transactions()).toBe(4);
  });

  it("stays fail-closed on the prune flag without touching any lane", async () => {
    const bindData = vi.fn();
    await expect(runCustomerDiagnosticPrune({ env: {}, options: { bindData: bindData as never } }))
      .resolves.toEqual({ status: 200, body: { ok: true, skipped: "mutations_disabled" } });
    await expect(runCustomerDiagnosticPrune({
      env: { COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED: "false" }, options: { bindData: bindData as never },
    })).resolves.toMatchObject({ body: { skipped: "mutations_disabled" } });
    expect(bindData).not.toHaveBeenCalled();
  });

  it("refuses an absent or out-of-policy retention value the way a bad ingest configuration refuses", async () => {
    for (const retention of [undefined, "", "0", "91", "seven"]) {
      await expect(runCustomerDiagnosticPrune({
        env: { ...pruneEnv, CUSTOMER_DIAGNOSTIC_RETENTION_DAYS: retention },
      })).resolves.toEqual({
        status: 503,
        body: { ok: false, error: "customer_diagnostic_history_configuration_invalid" },
      });
    }
  });

  it("refuses when the portable lane has no connection string", async () => {
    await expect(runCustomerDiagnosticPrune({ env: { ...portableEnv, DATABASE_URL: "" } }))
      .resolves.toEqual({
        status: 503,
        body: { ok: false, error: "customer_diagnostic_history_configuration_invalid" },
      });
  });

  it("answers primary_fresh before claiming a lease, and runs once the window has passed", async () => {
    const fresh = managedClient({
      control: { data: { last_status: "success", last_success_at: new Date().toISOString() }, error: null },
    });
    await expect(runCustomerDiagnosticPrune({
      env: pruneEnv, backstopMode: "freshness", options: managedOptions(fresh.client),
    })).resolves.toEqual({
      status: 200,
      body: { ok: true, skipped: true, reason: "primary_fresh", lastSuccessAt: expect.any(String) },
    });
    expect(fresh.names()).toEqual([]);

    const stale = managedClient({
      control: {
        data: { last_status: "success", last_success_at: "2020-01-01T00:00:00.000Z" },
        error: null,
      },
    });
    await expect(runCustomerDiagnosticPrune({
      env: pruneEnv, backstopMode: "freshness", options: managedOptions(stale.client),
    })).resolves.toMatchObject({ status: 200, body: { ok: true } });
    expect(stale.names()).toContain("platform_claim_job_run_v3");
  });

  it("maps a backstop read failure to a fixed code and refuses an unknown backstop mode", async () => {
    const failing = managedClient({ control: { data: null, error: { message: "down" } } });
    await expect(runCustomerDiagnosticPrune({
      env: pruneEnv, backstopMode: "freshness", options: managedOptions(failing.client),
    })).resolves.toEqual({
      status: 503,
      body: { ok: false, error: "customer_diagnostic_prune_backstop_unavailable" },
    });
    expect(failing.names()).toEqual([]);

    await expect(runCustomerDiagnosticPrune({ env: pruneEnv, backstopMode: "checkpoint" }))
      .resolves.toEqual({
        status: 400, body: { ok: false, error: "invalid_customer_diagnostic_prune_backstop" },
      });
  });

  it("reports a refused lease as the ledger's own reason", async () => {
    const managed = managedClient({ claim: { acquired: false, run_id: null, reason: "job_disabled" } });
    await expect(runCustomerDiagnosticPrune({ env: pruneEnv, options: managedOptions(managed.client) }))
      .resolves.toEqual({ status: 200, body: { ok: true, skipped: true, reason: "job_disabled" } });
    expect(managed.names()).toEqual(["platform_claim_job_run_v3"]);
  });

  it("finishes a failed drain as failed in the ledger instead of leaving the lease held", async () => {
    const managed = managedClient({ prune: { data: null, error: { message: "deadlock" } } });
    const result = await runCustomerDiagnosticPrune({
      env: pruneEnv, options: managedOptions(managed.client),
    });

    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ ok: false, error: "customer_diagnostic_prune_failed" });
    expect(managed.names()).toEqual([
      "platform_claim_job_run_v3", "customer_diagnostic_prune_v1", "platform_finish_job_run_v3",
    ]);
    expect(managed.calls[2]![1]).toMatchObject({
      p_status: "failed",
      p_error: "customer_diagnostic_history_unavailable",
      p_metadata: expect.objectContaining({ failures: 1 }),
    });
  });
});
