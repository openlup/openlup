import { describe, expect, it, vi } from "vitest";
import { createPostgresStockWaitStore } from "../../src/subscriptions/postgresStockWaitStore.js";
import type { NativeRenewalCodec, SubscriptionQueryExecutor } from "../../src/subscriptions/postgresRenewalStore.js";
import { effectsFixture } from "./renewalEffectsFixture.js";
function fixture() {
  const f = effectsFixture();
  const binding = { caseId: null, cycleId: null, orderId: null, paymentId: null, engineIdempotencyKey: "original-key" };
  const wire = { original: "wire", scheduledAt: f.at };
  const codec: NativeRenewalCodec = { due: () => f.due, freeze: () => f.snapshot, encode: () => wire,
    decode: vi.fn(() => f.snapshot), identity: () => "original-key", fingerprint: () => f.snapshot.frozenFingerprint, readback: () => f.op };
  const query = vi.fn<SubscriptionQueryExecutor["query"]>();
  const transaction = vi.fn(async <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => work({ query }));
  const store = createPostgresStockWaitStore({ executor: { query }, codec, withTransaction: transaction, workerId: "stock-worker" });
  return { ...f, binding, wire, codec, query, transaction, store };
}
describe("native stock wait adapter", () => {
  it("discovers original frozen operations without inventing a case or rebuilding prices", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows: [{ response: [{ operationId: "op", operationFingerprint: f.snapshot.frozenFingerprint, snapshot: f.wire, binding: f.binding }] }] });
    expect(await f.store.listCandidates({ limit: 2, asOf: f.at })).toEqual([{ subscriptionId: f.snapshot.subscriptionId,
      scheduledAt: f.at, scheduledInstant: Date.parse(f.at), operationId: "op", frozenFingerprint: f.snapshot.frozenFingerprint, frozenSnapshot: f.snapshot, binding: f.binding, case: null }]);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.codec.decode).toHaveBeenCalledWith(f.wire);
  });
  it("passes the complete frozen recovery binding and preserves durable waiting identity", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows: [{ response: { waiting: true, caseId: "case" } }] });
    expect(await f.store.admit({ operationId: "op", claimToken: "token", snapshot: f.snapshot, recovery: f.binding, now: f.at })).toMatchObject({ waiting: true, caseId: "case" });
    expect(f.query.mock.calls[0][1]).toEqual([{ operationId: "op", claimToken: "token", snapshot: f.wire,
      operationFingerprint: f.snapshot.frozenFingerprint, identityKey: "original-key", worker: "stock-worker" }, { stockWaitRecovery: f.binding }, f.at]);
  });
  it.each([new Error("stock_wait_stock_stale"), new Error("inventory_lock_unavailable")])("never translates technical stock failure into waiting", async error => {
    const f = fixture(); f.query.mockRejectedValueOnce(error);
    await expect(f.store.admit({ operationId: "op", claimToken: "token", snapshot: f.snapshot, now: f.at })).rejects.toBe(error);
  });
  it("rejects an unbound wait response", async () => {
    const f = fixture(); f.query.mockResolvedValueOnce({ rows: [{ response: { waiting: true } }] });
    await expect(f.store.admit({ operationId: "op", claimToken: "token", snapshot: f.snapshot, now: f.at })).rejects.toThrow("case_identity_missing");
  });
  it("does not let an expired secured replay bypass a stale generation fence", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ schedule_matches: true,
      operation_fingerprint: f.snapshot.frozenFingerprint, state: "reserved", case_state: "stock_secured",
      claim_generation: 2, live_hold: false, lease_expires_at: "2000-01-01" }] });
    expect(await f.store.recoverRefusedSchedule({ operationId: "op", caseId: "case", claimGeneration: 1,
      frozenFingerprint: f.snapshot.frozenFingerprint, scheduledAt: f.at, now: f.at })).toEqual({ outcome: "refused", reason: "stale_snapshot" });
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ schedule_matches: false }, "stale_snapshot"],
    [{ claim_generation: 9 }, "stale_snapshot"],
    [{ has_artifacts: true }, "external_ownership"],
    [{ terminal_reason: "provider_declined" }, "not_stock_only"],
    [{ lease_expires_at: "2099-01-01" }, "lease_active"],
  ])("fences schedule, generation and lease before recovery", async (delta, reason) => {
    const f = fixture(); f.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ schedule_matches: true,
      operation_fingerprint: f.snapshot.frozenFingerprint, state: "refused", terminal_reason: "inventory_unavailable", claim_generation: 1, lease_expires_at: "2000-01-01", ...delta }] });
    expect(await f.store.recoverRefusedSchedule({ operationId: "op", caseId: "case", claimGeneration: 1,
      frozenFingerprint: f.snapshot.frozenFingerprint, scheduledAt: f.at, now: f.at })).toEqual({ outcome: "refused", reason });
    expect(f.query).toHaveBeenCalledTimes(2);
  });
});
