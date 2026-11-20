import { expect, it } from "vitest";
import type { FulfillmentStockSyncPort, StockSnapshot, SyncCursor } from "../../src/fulfillment/contracts/index.js";
import { runFulfillmentStockSyncWorker as run } from "../../src/fulfillment/index.js";
import { stockMovementWindow } from "../../src/fulfillment/providerStockAvailability.js";
import { at } from "./fixtures.js";

function fixture() {
  let cursor: SyncCursor | null = null, fail = false;
  const evidence: Parameters<FulfillmentStockSyncPort["recordLowStockEvidence"]>[0][] = [], snapshots: Parameters<FulfillmentStockSyncPort["recordStockSnapshot"]>[0][] = [], requested: string[] = [], resolutions: Parameters<FulfillmentStockSyncPort["resolveLowStockEvidence"]>[0][] = [];
  const stock: StockSnapshot = { providerRef: "warehouse-a", syncRunId: "legacy-run", collectedAt: at, sourceRevision: null, revisionSource: "collection", skuRef: "sku-a", quantityKind: "snapshot", totalQuantity: 9, forSaleQuantity: 5, reservedOrUnavailableQuantity: 4 };
  const line: Awaited<ReturnType<FulfillmentStockSyncPort["readLocalInventoryStock"]>>[number] = { skuRef: "sku-a", quantity: { onHand: 10, reserved: 2, unavailable: 1, safetyStock: 0 }, fulfillable: true, locationStatus: "active", lotStatus: "available", expiresAt: null };
  const lines = [line];
  const input: Parameters<typeof run>[0] = {
    now: () => new Date(at), movementBatchSize: 20,
    compatibility: { syncRunId: () => "legacy-stock-run", staleEvidenceSku: "legacy-sentinel", timeZone: "Etc/GMT-2", currentKey: (r, s) => `${r}:current:${s}`, snapshotKey: (r, s) => `${r}:snapshot:${s}`, lowStockKey: (s, t) => `legacy:${s}:${t}`, staleKey: last => `legacy-stale:${last}` },
    provider: { async getStock() { return [stock]; }, async getStockMovements() { return []; } },
    port: { async readCursor() { return cursor; }, async readLocalInventoryStock(requestedAt) { requested.push(requestedAt); return lines; },
      async readSkuInventoryClasses() { return new Map([["sku-a", "sellable"]]); }, async readActiveReservations(_skus, requestedAt) { requested.push(requestedAt); return new Map([["sku-a", 6]]); },
      async recordCursor(value) { cursor = structuredClone(value); },
      async recordStockSnapshot(value) { snapshots.push(value); if (fail) throw new Error("synthetic-private-stock"); return { replayed: false, readBack: true }; },
      async recordProviderStockCurrent() { return { replayed: false, readBack: true }; }, async recordMovement() { return { replayed: false, readBack: false }; },
      async recordLowStockEvidence(value) { evidence.push(value); return { replayed: false }; }, async resolveLowStockEvidence(value) { resolutions.push(value); return { resolved: 1 }; },
    },
  };
  return { input, lines, evidence, snapshots, requested, resolutions, cursor: () => cursor, setCursor(value: SyncCursor | null) { cursor = value; }, fail(value: boolean) { fail = value; } };
}

it("confirms reservation coverage on the second consecutive successful gap run and resets after failure (G15)", async () => {
  const f = fixture();
  expect(await run(f.input)).toMatchObject({ ok: true, reservationCoverage: 0, lowStock: 0 });
  expect(f.cursor()).toMatchObject({ status: "succeeded", coverageGapSkus: ["sku-a"] });
  expect(await run(f.input)).toMatchObject({ ok: true, reservationCoverage: 1 });
  expect(f.evidence).toEqual([expect.objectContaining({ thresholdKind: "reservation_coverage", severity: "critical", providerForSaleQuantity: 5 })]);
  f.fail(true); expect(await run(f.input)).toMatchObject({ ok: false, failures: 1 });
  expect(f.cursor()).toMatchObject({ status: "failed", coverageGapSkus: [] });
  f.fail(false); f.evidence.length = 0;
  expect(await run(f.input)).toMatchObject({ ok: true, reservationCoverage: 0 });
  expect(f.evidence).toEqual([]);
  expect(await run(f.input)).toMatchObject({ reservationCoverage: 1 });
  const legacy = fixture(); legacy.setCursor({ status: "succeeded", lastStockSyncedAt: at, lastMovementOccurredAt: null, continuation: { nextRef: null, startLocalDate: null, endLocalDate: null }, refusal: null });
  expect(await run(legacy.input)).toMatchObject({ reservationCoverage: 0 });
});

it("filters exact-time expiry and unusable locations/lots at captured now while preserving freshness/window rules (G16)", async () => {
  const f = fixture(); const usable = f.lines[0];
  f.lines.push({ ...usable, expiresAt: at }, { ...usable, expiresAt: "2026-10-21T11:59:59.999Z" },
    { ...usable, fulfillable: false }, { ...usable, locationStatus: "inactive" }, { ...usable, lotStatus: "quarantined" },
    { ...usable, expiresAt: "2026-10-21T12:00:00.001Z" });
  expect(await run(f.input)).toMatchObject({ ok: true, readBacks: 2 });
  expect(f.snapshots[0].local).toEqual({ skuRef: "sku-a", onHand: 20, reserved: 4, unavailable: 2, safetyStock: 0 });
  expect(f.requested).toEqual([at, at]);
  f.setCursor({ status: "succeeded", lastStockSyncedAt: "2026-10-21T06:00:00.000Z", lastMovementOccurredAt: null, continuation: { nextRef: null, startLocalDate: null, endLocalDate: null }, coverageGapSkus: [], refusal: null });
  await run(f.input);
  expect(f.evidence).toContainEqual(expect.objectContaining({ skuRef: "legacy-sentinel", thresholdKind: "stale_sync", severity: "warning" }));
  expect(stockMovementWindow(null, new Date("2026-10-21T22:30:00Z"), "Etc/GMT-2")).toEqual({ startLocalDate: "2026-10-21", endLocalDate: "2026-10-21" });
  f.input.port.readSkuInventoryClasses = async () => new Map([["sku-a", "packaging"]]);
  f.evidence.length = 0; await run(f.input);
  expect(f.evidence).toEqual([]); expect(f.resolutions).toContainEqual(expect.objectContaining({ skuRef: "sku-a", activeThresholdKinds: [] }));
});

// Mirror the native SQL fingerprint fence without claiming to refresh stored observations.
async function nativeAlertPort() {
  const { createPostgresFulfillmentStockSyncPort } = await import("../../src/fulfillment/postgresStockSyncPort.js");
  const receipts = new Map<string, unknown>();
  return createPostgresFulfillmentStockSyncPort({ async query(_sql, values = []) {
    const key = String(values[1]), prior = receipts.get(key);
    if (prior && prior !== values[2]) throw Object.assign(Error("fulfillment_stock_evidence_idempotency_conflict"), { code: "23505" });
    receipts.set(key, values[2]);
    return { rows: [{ response: { replayed: Boolean(prior) } }] };
  } }, { sourceKey: "warehouse-a", readLocalInventoryStock: async () => [] });
}

it("replays native alerts across stock runs when quantities and severity change (S4)", async () => {
  const port = await nativeAlertPort(), f = fixture();
  let runNumber = 0, forSaleQuantity = 5;
  const stock = (await f.input.provider.getStock())[0];
  if ("kind" in stock) throw new Error("expected_stock_fixture");
  f.input.provider.getStock = async () => [{ ...stock, forSaleQuantity }];
  f.input.compatibility.syncRunId = () => `run-${++runNumber}`;
  f.input.port.readActiveReservations = async () => new Map([["sku-a", 3]]);
  f.lines[0].quantity.safetyStock = 6;
  f.input.port.recordLowStockEvidence = async value => {
    f.evidence.push(value);
    return port.recordLowStockEvidence(value);
  };
  expect(await run(f.input)).toMatchObject({ ok: true, lowStock: 1, replayed: 0, failures: 0 });
  forSaleQuantity = 3;
  f.lines[0].quantity.onHand = 9;
  expect(await run(f.input)).toMatchObject({ ok: true, lowStock: 0, replayed: 1, failures: 0 });
  expect(f.evidence).toEqual([
    expect.objectContaining({ requestKey: "legacy:sku-a:safety_stock", syncRunId: "run-1", severity: "warning", providerForSaleQuantity: 5, localAvailableQuantity: 1 }),
    expect.objectContaining({ requestKey: "legacy:sku-a:safety_stock", syncRunId: "run-2", severity: "critical", providerForSaleQuantity: 3, localAvailableQuantity: 0 }),
  ]);
  expect(await port.recordLowStockEvidence(f.evidence[1])).toEqual({ replayed: true });
});

it("uses distinct alert keys for different SKUs or thresholds and fences reused identity (S4)", async () => {
  const port = await nativeAlertPort(), f = fixture();
  const alert = { requestKey: f.input.compatibility.lowStockKey("sku-a", "reservation_coverage"), skuRef: "sku-a", thresholdKind: "reservation_coverage" as const,
    severity: "critical" as const, providerForSaleQuantity: 5, localAvailableQuantity: 6, syncRunId: "run-1" };
  expect(await port.recordLowStockEvidence(alert)).toEqual({ replayed: false });
  for (const change of [{ skuRef: "sku-b", thresholdKind: "reservation_coverage" as const },
    { skuRef: "sku-a", thresholdKind: "safety_stock" as const }]) {
    const requestKey = f.input.compatibility.lowStockKey(change.skuRef, change.thresholdKind);
    expect(requestKey).not.toBe(alert.requestKey);
    const changedAlert = { ...alert, ...change, requestKey };
    expect(await port.recordLowStockEvidence(changedAlert)).toEqual({ replayed: false });
    expect(await port.recordLowStockEvidence(changedAlert)).toEqual({ replayed: true });
    await expect(port.recordLowStockEvidence({ ...alert, ...change })).rejects.toMatchObject({ code: "23505" });
  }
});


it("skips blank stock SKU refs before classification and persistence as in the base worker", async () => {
  const f = fixture(), [stock] = await f.input.provider.getStock();
  if ("kind" in stock) throw Error("expected_stock_fixture");
  f.input.provider.getStock = async () => [{ ...stock, skuRef: "" }, stock, { ...stock, skuRef: "  " }];
  f.input.port.readSkuInventoryClasses = async skus => {
    expect(skus).toEqual(["sku-a"]);
    return new Map([["sku-a", "sellable"]]);
  };
  const written: string[] = [];
  f.input.port.recordProviderStockCurrent = async ({ snapshot }) => {
    written.push(snapshot.skuRef); return { replayed: false, readBack: true };
  };
  expect(await run(f.input)).toMatchObject({ ok: true, checked: 1, rejected: 0, failures: 0 });
  expect(written).toEqual(["sku-a"]);
  expect(f.snapshots.map(value => value.snapshot.skuRef)).toEqual(["sku-a"]);
});

it("keeps mixed-batch alerts, coverage confirmation, resolution and stale recovery successful", async () => {
  const f = fixture(), [stock] = await f.input.provider.getStock();
  if ("kind" in stock) throw Error("expected_stock_fixture");
  f.lines[0].quantity.safetyStock = 1;
  f.input.provider.getStock = async () => [stock, { kind: "rejected", itemIndex: 1, reason: "invalid_sku_ref" }];
  f.input.provider.getStockMovements = async () => [{ kind: "rejected", itemIndex: 0, reason: "invalid_sku_ref" }];
  expect(await run(f.input)).toMatchObject({ ok: true, checked: 1, rejected: 2, lowStock: 1 });
  expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: at, coverageGapSkus: ["sku-a"],
    counts: { rejected: 2 }, error: null, refusal: null });
  expect(await run(f.input)).toMatchObject({ ok: true, reservationCoverage: 1 });
  expect(f.evidence).toContainEqual(expect.objectContaining({ skuRef: "sku-a", thresholdKind: "reservation_coverage" }));
  expect(f.resolutions).toContainEqual({ skuRef: "sku-a", activeThresholdKinds: ["safety_stock", "reservation_coverage"], syncRunId: "legacy-stock-run" });
  expect(f.resolutions).toContainEqual({ skuRef: "legacy-sentinel", activeThresholdKinds: [], syncRunId: "legacy-stock-run" });
  f.input.port.readActiveReservations = async () => new Map();
  f.evidence.length = 0; f.resolutions.length = 0;
  expect(await run(f.input)).toMatchObject({ ok: true, lowStock: 0, reservationCoverage: 0, rejected: 2 });
  expect(f.evidence).toEqual([]);
  expect(f.resolutions).toContainEqual({ skuRef: "sku-a", activeThresholdKinds: [], syncRunId: "legacy-stock-run" });
  expect(f.cursor()).toMatchObject({ status: "succeeded", coverageGapSkus: [] });
});

it("contains pre-terminal port failures as safe failed results, preserving terminal cursor rejection", async () => {
  for (const [method, reason] of [
    ["readCursor", "cursor_read_failed"], ["readLocalInventoryStock", "stock_read_failed"],
    ["readSkuInventoryClasses", "stock_inventory_read_failed"], ["readActiveReservations", "stock_inventory_read_failed"],
    ["recordProviderStockCurrent", "stock_current_write_failed"], ["recordStockSnapshot", "snapshot_write_failed"],
    ["recordLowStockEvidence", "stock_evidence_write_failed"], ["resolveLowStockEvidence", "stock_evidence_resolve_failed"],
  ] as const) {
    const f = fixture(); f.lines[0].quantity.safetyStock = 1;
    f.input.port[method] = async () => { throw Error("private-transport-error"); };
    expect(await run(f.input), method).toMatchObject({ ok: false, failures: 1, reason });
    expect(f.cursor(), method).toMatchObject({ status: "failed", lastStockSyncedAt: null, error: { reason }, refusal: { reason: "io_failure", retryable: true } });
  }
  const f = fixture(), recordCursor = f.input.port.recordCursor;
  f.input.port.recordCursor = async value => {
    if (value.status === "running") throw Error("private-transport-error");
    await recordCursor(value);
  };
  expect(await run(f.input)).toMatchObject({ ok: false, reason: "cursor_write_failed" });
  expect(f.cursor()).toMatchObject({ status: "failed", error: { reason: "cursor_write_failed" } });
  f.input.port.recordCursor = async value => {
    if (value.status !== "running") throw Error("terminal-cursor-unavailable");
  };
  await expect(run(f.input)).rejects.toThrow("terminal-cursor-unavailable");
});

it("resolves stale recovery only after the terminal cursor and preserves completion if cleanup fails", async () => {
  const f = fixture(), resolve = f.input.port.resolveLowStockEvidence;
  let recoveries = 0;
  f.input.port.resolveLowStockEvidence = async value => {
    if (value.skuRef !== "legacy-sentinel") return resolve(value);
    recoveries += 1;
    expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: at });
    throw Error("private-stale-recovery-error");
  };
  expect(await run(f.input)).toMatchObject({ ok: true, failures: 0 });
  expect(f.cursor()).toMatchObject({ status: "succeeded", error: null, refusal: null });
  expect(recoveries).toBe(1);
  f.input.port.recordCursor = async value => {
    if (value.status !== "running") throw Error("terminal-cursor-unavailable");
  };
  await expect(run(f.input)).rejects.toThrow("terminal-cursor-unavailable");
  expect(recoveries).toBe(1);
});

it("preserves successful completion when stale recovery throws synchronously", async () => {
  const f = fixture();
  f.input.provider.getStock = async () => [];
  let recoveries = 0;
  f.input.port.resolveLowStockEvidence = () => {
    recoveries += 1;
    expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: at });
    throw Error("synchronous-cleanup-failure");
  };
  expect(await run(f.input)).toMatchObject({ ok: true, failures: 0 });
  expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: at, error: null, refusal: null });
  expect(recoveries).toBe(1);
});


it("keeps prior coverage gaps and stale alerts when all stock rows are rejected despite valid movements", async () => {
  for (const lastStockSyncedAt of ["2026-10-21T06:00:00.000Z", at]) {
    const f = fixture(), [stock] = await f.input.provider.getStock();
    if ("kind" in stock) throw Error("expected_stock_fixture");
    f.setCursor({ status: "succeeded", lastStockSyncedAt, lastMovementOccurredAt: null,
      continuation: { nextRef: null, startLocalDate: null, endLocalDate: null }, coverageGapSkus: ["sku-a"], refusal: null });
    f.input.provider.getStock = async () => [{ kind: "rejected", itemIndex: 0, reason: "invalid_sku_ref" }];
    f.input.provider.getStockMovements = async () => [{ ...stock, quantityKind: "movement", quantity: 1, occurredAt: at,
      operationType: "receipt", documentRef: null, lotRef: null, expirationDate: null }];
    const cursors: SyncCursor[] = [], recordCursor = f.input.port.recordCursor;
    f.input.port.recordCursor = async value => { cursors.push(value); await recordCursor(value); };
    expect(await run(f.input)).toMatchObject({ ok: false, checked: 0, updated: 0, movements: 1, rejected: 1,
      reason: "invalid_sku_ref", refusal: { reason: "malformed", retryable: false } });
    expect(cursors.map(cursor => cursor.coverageGapSkus)).toEqual([["sku-a"], ["sku-a"]]);
    expect(f.cursor()).toMatchObject({ status: "failed", lastStockSyncedAt: null, coverageGapSkus: ["sku-a"],
      error: { reason: "invalid_sku_ref" }, refusal: { reason: "malformed", phase: "sync", retryable: false } });
    expect(f.snapshots).toEqual([]);
    expect(f.resolutions).toEqual([]);
    expect(f.evidence.every(value => value.thresholdKind === "stale_sync")).toBe(true);
  }
});

it("preserves typed admission retryability without copying arbitrary error fields", async () => {
  const f = fixture();
  f.input.provider.getStock = async () => { throw { reason: "not_ready", phase: "sync", retryable: true, payload: "private-value" }; };
  expect(await run(f.input)).toMatchObject({ ok: false, reason: "not_ready", refusal: { reason: "not_ready", phase: "sync", retryable: true } });
  expect(f.cursor()).toMatchObject({ refusal: { reason: "not_ready", phase: "sync", retryable: true } });
  expect(JSON.stringify(f.cursor())).not.toContain("private-value");
});

it("runs snapshots without movement I/O and retains the prior watermark with a separate refusal", async () => {
  const f = fixture(), watermark = "2026-10-20T12:00:00.000Z";
  f.setCursor({ status: "succeeded", lastStockSyncedAt: at, lastMovementOccurredAt: watermark,
    continuation: { nextRef: null, startLocalDate: null, endLocalDate: null }, refusal: null });
  f.input.stockMovements = false;
  f.input.provider.getStockMovements = async () => { throw new Error("movement I/O forbidden"); };
  f.input.port.recordMovement = async () => { throw new Error("movement persistence forbidden"); };
  const movementRefusal = { reason: "stock_movements_unsupported", phase: "sync", retryable: false };
  expect(await run(f.input)).toMatchObject({ ok: true, checked: 1, updated: 2, providerCalls: 1, movements: 0, lastMovementOccurredAt: watermark, movementRefusal });
  expect(f.snapshots).toHaveLength(1);
  expect(f.cursor()).toMatchObject({ status: "succeeded", lastStockSyncedAt: at, lastMovementOccurredAt: watermark, refusal: null, movementRefusal });
  f.fail(true);
  expect(await run(f.input)).toMatchObject({ ok: false, movementRefusal, refusal: { reason: "io_failure" } });
  expect(f.cursor()).toMatchObject({ status: "failed", lastMovementOccurredAt: watermark, movementRefusal });
});

it("uses batch stock and evidence writes when supplied and preserves parity across SKU classes", async () => {
  const f = fixture();
  const baseStock = (await f.input.provider.getStock())[0];
  if ("kind" in baseStock) throw new Error("expected_stock_fixture");
  f.setCursor({ status: "succeeded", lastStockSyncedAt: at, lastMovementOccurredAt: null,
    continuation: { nextRef: null, startLocalDate: null, endLocalDate: null }, coverageGapSkus: ["sku-a"], refusal: null });
  f.input.provider.getStock = async () => [
    { ...baseStock, skuRef: "sku-c", forSaleQuantity: 10 },
    { ...baseStock, skuRef: "sku-a", forSaleQuantity: 5 },
    { ...baseStock, skuRef: "sku-pkg", forSaleQuantity: 100 },
    { ...baseStock, skuRef: "sku-unknown", forSaleQuantity: 2 },
  ];
  f.lines[0].quantity.safetyStock = 4;
  f.input.port.readSkuInventoryClasses = async () => new Map([
    ["sku-c", "sellable"], ["sku-a", "sellable"], ["sku-pkg", "packaging"], ["sku-unknown", null],
  ]);
  f.input.port.readActiveReservations = async () => new Map([["sku-a", 6], ["sku-c", 1]]);

  const singleCalls: string[] = [];
  const batchCounts = { current: 0, snapshot: 0, evidence: 0, resolve: 0 };
  f.input.port.recordProviderStockCurrent = async () => { singleCalls.push("current"); return { replayed: false, readBack: true }; };
  f.input.port.recordStockSnapshot = async () => { singleCalls.push("snapshot"); return { replayed: false, readBack: true }; };
  f.input.port.recordLowStockEvidence = async () => { singleCalls.push("evidence"); return { replayed: false }; };
  f.input.port.resolveLowStockEvidence = async value => {
    if (value.skuRef !== "legacy-sentinel") singleCalls.push("resolve");
    return { resolved: 0 };
  };
  f.input.port.recordProviderStockCurrentBatch = async inputs => {
    batchCounts.current += 1;
    return inputs.map((item) => ({ replayed: item.snapshot.skuRef === "sku-c", readBack: true }));
  };
  f.input.port.recordStockSnapshotBatch = async inputs => {
    batchCounts.snapshot += 1;
    return inputs.map(() => ({ replayed: false, readBack: true }));
  };
  f.input.port.recordLowStockEvidenceBatch = async inputs => {
    batchCounts.evidence += 1;
    f.evidence.push(...inputs);
    return inputs.map(() => ({ replayed: false }));
  };
  f.input.port.resolveLowStockEvidenceBatch = async inputs => {
    batchCounts.resolve += 1;
    f.resolutions.push(...inputs);
    return inputs.map(() => ({ resolved: 1 }));
  };

  const out = await run(f.input);
  expect(out).toMatchObject({
    ok: true, checked: 4, updated: 7, replayed: 1, readBacks: 8,
    unclassified: 1, lowStock: 2, reservationCoverage: 1, failures: 0,
  });
  expect(batchCounts).toEqual({ current: 1, snapshot: 1, evidence: 1, resolve: 1 });
  expect(singleCalls).toEqual([]);
  expect(f.evidence.map((e) => `${e.skuRef}:${e.thresholdKind}`)).toEqual(["sku-a:safety_stock", "sku-a:reservation_coverage"]);
  expect(f.resolutions).toEqual([
    { skuRef: "sku-c", activeThresholdKinds: [], syncRunId: "legacy-stock-run" },
    { skuRef: "sku-a", activeThresholdKinds: ["safety_stock", "reservation_coverage"], syncRunId: "legacy-stock-run" },
    { skuRef: "sku-pkg", activeThresholdKinds: [], syncRunId: "legacy-stock-run" },
  ]);
  expect(f.cursor()).toMatchObject({ status: "succeeded", coverageGapSkus: ["sku-a"] });
});

it("falls back to per-item stock writes to isolate individual failures without double-writing current stock", async () => {
  const f = fixture();
  const baseStock = (await f.input.provider.getStock())[0];
  if ("kind" in baseStock) throw new Error("expected_stock_fixture");
  f.input.provider.getStock = async () => [
    { ...baseStock, skuRef: "sku-ok" },
    { ...baseStock, skuRef: "sku-bad" },
  ];
  f.input.port.readSkuInventoryClasses = async () => new Map([["sku-ok", "sellable"], ["sku-bad", "sellable"]]);

  // Case 1: recordProviderStockCurrentBatch fails -> falls back to per-item current + snapshot
  let currentSingleCalls = 0;
  f.input.port.recordProviderStockCurrentBatch = async () => { throw Object.assign(new Error("batch-conflict"), { code: "23505" }); };
  f.input.port.recordStockSnapshotBatch = async () => { throw new Error("should-not-be-called"); };
  f.input.port.recordProviderStockCurrent = async ({ snapshot }) => {
    currentSingleCalls += 1;
    if (snapshot.skuRef === "sku-bad") throw Object.assign(new Error("conflict"), { code: "23505" });
    return { replayed: false, readBack: true };
  };
  const out1 = await run(f.input);
  expect(currentSingleCalls).toBe(2);
  expect(out1).toMatchObject({ ok: false, checked: 1, updated: 2, failures: 1, reason: "stock_current_write_failed:23505" });
  expect(out1.items).toEqual([
    expect.objectContaining({ itemIndex: 0, skuRef: "sku-ok", status: "recorded" }),
    expect.objectContaining({ itemIndex: 1, skuRef: "sku-bad", status: "failed", reason: "stock_current_write_failed:23505" }),
  ]);

  // Case 2: recordProviderStockCurrentBatch succeeds, recordStockSnapshotBatch fails -> per-item snapshot only
  currentSingleCalls = 0;
  let snapshotSingleCalls = 0;
  f.input.port.recordProviderStockCurrentBatch = async inputs => inputs.map(() => ({ replayed: false, readBack: true }));
  f.input.port.recordStockSnapshotBatch = async () => { throw Object.assign(new Error("snapshot-conflict"), { code: "23505" }); };
  f.input.port.recordStockSnapshot = async ({ snapshot }) => {
    snapshotSingleCalls += 1;
    if (snapshot.skuRef === "sku-bad") throw Object.assign(new Error("conflict"), { code: "23505" });
    return { replayed: false, readBack: true };
  };
  const out2 = await run(f.input);
  expect(currentSingleCalls).toBe(0);
  expect(snapshotSingleCalls).toBe(2);
  expect(out2).toMatchObject({ ok: false, checked: 1, updated: 2, replayed: 0, readBacks: 2, failures: 1, reason: "snapshot_write_failed:23505" });
  expect(out2.items).toEqual([
    expect.objectContaining({ itemIndex: 0, skuRef: "sku-ok", status: "recorded" }),
    expect.objectContaining({ itemIndex: 1, skuRef: "sku-bad", status: "failed", reason: "snapshot_write_failed:23505" }),
  ]);
});

it("maps batch evidence and resolve failures to their safe stage reasons without leaking unwritten alerts", async () => {
  for (const [method, reason] of [
    ["recordLowStockEvidenceBatch", "stock_evidence_write_failed"],
    ["resolveLowStockEvidenceBatch", "stock_evidence_resolve_failed"],
  ] as const) {
    const f = fixture();
    f.lines[0].quantity.safetyStock = 1;
    f.input.port[method] = async () => { throw new Error("private-batch-error"); };
    expect(await run(f.input), method).toMatchObject({ ok: false, failures: 1, reason });
    expect(f.cursor(), method).toMatchObject({ status: "failed", error: { reason }, refusal: { reason: "io_failure", retryable: true } });
    if (method === "recordLowStockEvidenceBatch") {
      expect(f.cursor()?.alerts).toEqual([]);
    }
  }
});

it("falls back cleanly without double-counting on malformed batch stock responses and duplicate candidate SKUs", async () => {
  const f = fixture();
  const baseStock = (await f.input.provider.getStock())[0];
  if ("kind" in baseStock) throw new Error("expected_stock_fixture");
  f.input.provider.getStock = async () => [
    { ...baseStock, skuRef: "sku-a" },
    { ...baseStock, skuRef: "sku-b" },
  ];
  f.input.port.readSkuInventoryClasses = async () => new Map([["sku-a", "sellable"], ["sku-b", "sellable"]]);
  // Malformed sparse response from recordStockSnapshotBatch must not partially mutate before fallback
  f.input.port.recordProviderStockCurrentBatch = async inputs => inputs.map(() => ({ replayed: false, readBack: true }));
  f.input.port.recordStockSnapshotBatch = async () => [{ replayed: false, readBack: true }, undefined as never];
  const out = await run(f.input);
  expect(out).toMatchObject({ ok: true, checked: 2, updated: 4, failures: 0 });
  expect(out.items).toHaveLength(2);

  // Duplicate SKU in coverageCandidates falls back to exact per-item evidence/resolve interleaving
  const dup = fixture();
  dup.lines[0].quantity.safetyStock = 4;
  dup.input.port.readActiveReservations = async () => new Map();
  dup.input.provider.getStock = async () => [
    { ...baseStock, skuRef: "sku-a", forSaleQuantity: 20 },
    { ...baseStock, skuRef: "sku-a", forSaleQuantity: 2 },
  ];
  const ops: string[] = [];
  dup.input.port.recordLowStockEvidenceBatch = async () => { throw new Error("batch-must-not-run-on-duplicate-sku"); };
  dup.input.port.resolveLowStockEvidenceBatch = async () => { throw new Error("batch-must-not-run-on-duplicate-sku"); };
  dup.input.port.recordLowStockEvidence = async value => { ops.push(`record:${value.skuRef}:${value.thresholdKind}`); return { replayed: false }; };
  dup.input.port.resolveLowStockEvidence = async value => { if (value.skuRef !== "legacy-sentinel") ops.push(`resolve:${value.skuRef}:${value.activeThresholdKinds.join(",")}`); return { resolved: 0 }; };
  expect(await run(dup.input)).toMatchObject({ ok: true, lowStock: 1 });
  expect(ops).toEqual(["resolve:sku-a:", "record:sku-a:safety_stock", "resolve:sku-a:safety_stock"]);
});
