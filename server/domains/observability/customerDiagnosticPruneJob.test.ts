import { describe, expect, it, vi } from "vitest";

import {
  CUSTOMER_DIAGNOSTIC_PRUNE_DEFAULT_BATCH_SIZE,
  CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME,
  clampCustomerDiagnosticPruneBatchSize,
  pruneCustomerDiagnosticHistory,
  type CustomerDiagnosticPruneCounts,
} from "./customerDiagnosticPruneJob.js";

const empty: CustomerDiagnosticPruneCounts = {
  eventsDeleted: 0, segmentsDeleted: 0, limitsDeleted: 0, accessDeleted: 0,
};

function port(batches: Array<Partial<CustomerDiagnosticPruneCounts>>) {
  const prune = vi.fn(async () => ({ ...empty, ...(batches.shift() ?? {}) }));
  return { port: { prune }, prune };
}

describe("customer diagnostic retention drain", () => {
  it("names the job the ledger and the ingest gate both address", () => {
    expect(CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME).toBe("customer-diagnostic-prune");
  });

  it("stops after one empty batch and reports nothing more is due", async () => {
    const { port: p, prune } = port([]);
    await expect(pruneCustomerDiagnosticHistory({ port: p, batchSize: 10 })).resolves.toEqual({
      ...empty, batchSize: 10, batches: 1, deleted: 0, morePossible: false,
    });
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(10);
  });

  it("stops on a partial batch and accumulates every lane", async () => {
    const { port: p, prune } = port([{ eventsDeleted: 4, accessDeleted: 2 }]);
    await expect(pruneCustomerDiagnosticHistory({ port: p, batchSize: 10 })).resolves.toMatchObject({
      eventsDeleted: 4, accessDeleted: 2, deleted: 6, batches: 1, morePossible: false,
    });
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it("derives morePossible from a saturated lane, not from any field the RPC returns", async () => {
    // customer_diagnostic_prune_v1 returns four counters and nothing else, so a
    // lane that filled p_batch_size is the only evidence rows remain.
    const { port: p } = port([{ segmentsDeleted: 3 }]);
    await expect(pruneCustomerDiagnosticHistory({ port: p, batchSize: 3, maxBatches: 1 }))
      .resolves.toMatchObject({ batches: 1, morePossible: true });
  });

  it("drains across batches until one does not fill the budget", async () => {
    const { port: p, prune } = port([
      { eventsDeleted: 5 }, { eventsDeleted: 5, limitsDeleted: 1 }, { eventsDeleted: 2 },
    ]);
    await expect(pruneCustomerDiagnosticHistory({ port: p, batchSize: 5, maxBatches: 9 }))
      .resolves.toMatchObject({
        eventsDeleted: 12, limitsDeleted: 1, deleted: 13, batches: 3, morePossible: false,
      });
    expect(prune).toHaveBeenCalledTimes(3);
  });

  it("stops on the batch budget and on the time budget, both still owing work", async () => {
    const saturated = { prune: vi.fn(async () => ({ ...empty, eventsDeleted: 2 })) };
    await expect(pruneCustomerDiagnosticHistory({ port: saturated, batchSize: 2, maxBatches: 2 }))
      .resolves.toMatchObject({ batches: 2, deleted: 4, morePossible: true });
    expect(saturated.prune).toHaveBeenCalledTimes(2);

    let clock = 0;
    const ticking = { prune: vi.fn(async () => { clock += 1_000; return { ...empty, eventsDeleted: 2 }; }) };
    await expect(pruneCustomerDiagnosticHistory({
      port: ticking, batchSize: 2, maxBatches: 50, timeBudgetMs: 2_500, now: () => clock,
    })).resolves.toMatchObject({ batches: 3, morePossible: true });
  });

  it("clamps the batch size into the range the RPC accepts", () => {
    expect(clampCustomerDiagnosticPruneBatchSize(undefined)).toBe(CUSTOMER_DIAGNOSTIC_PRUNE_DEFAULT_BATCH_SIZE);
    expect(clampCustomerDiagnosticPruneBatchSize(Number.NaN)).toBe(CUSTOMER_DIAGNOSTIC_PRUNE_DEFAULT_BATCH_SIZE);
    expect([0, -5, 1, 250, 500, 501, 10_000].map(clampCustomerDiagnosticPruneBatchSize))
      .toEqual([1, 1, 1, 250, 500, 500, 500]);
    expect(clampCustomerDiagnosticPruneBatchSize(7.9)).toBe(7);
  });

  it("sends only a clamped batch size, never one the RPC would refuse", async () => {
    const { port: p, prune } = port([]);
    await pruneCustomerDiagnosticHistory({ port: p, batchSize: 9_000 });
    expect(prune).toHaveBeenCalledWith(500);
  });

  it("surfaces a failing lane instead of swallowing it into a successful run", async () => {
    const failing = { prune: vi.fn().mockRejectedValue(new Error("customer_diagnostic_prune_invalid")) };
    await expect(pruneCustomerDiagnosticHistory({ port: failing, batchSize: 10 }))
      .rejects.toThrow("customer_diagnostic_prune_invalid");
  });
});
