import { describe, expect, it, vi } from "vitest";
import { storedMethodCapabilityKinds, storedMethodExpectations } from "../../../src/domains/payment/contracts.js";
import { chargeSubscriptionCycleOffSession, type ChargeDeps } from "../../../server/domains/subscription/chargeSubscriptionCycleOffSession.js";
const PROVIDER = storedMethodCapabilityKinds.find(kind => storedMethodExpectations(kind)?.requiredMethodKind === null)!;

// Incumbent preflight refusal boundary only. No private stock-wait SQL or timing implementation.
describe("incumbent frozen renewal preflight", () => {
  it.each(["short", "stale", "busy"] as const)("passes frozen snapshots to order creation and stops payment calls on %s", async reason => {
    const due = { subscriptionId: "sub-fixture", clientId: "client-fixture", nextCycleAt: "2026-10-20T12:00:00+02:00", currency: "XXX",
      providerKind: PROVIDER, providerCustomerRef: "customer", providerMethodRef: "method", methodKind: "card", payerEmail: null, payerName: null };
    const snapshots = { cycleNumber: 2, retryAttempt: 1, providerAttemptSequence: 3,
      templateSnapshot: { cadence_days: 28, lines: [{ sku: "A", qty: 2 }, { sku: "B", qty: 3 }] }, pricingSnapshot: { scheduledAt: due.nextCycleAt },
      orderSnapshot: { totals: { totalGross: { amountMinor: 5000, currency: "XXX" } } } };
    const before = JSON.stringify({ due, snapshots });
    const createIntent = vi.fn(), prepareProviderAttempt = vi.fn(), execute = vi.fn(), noteRowOutcome = vi.fn();
    const buildCycleSnapshots = vi.fn(async () => snapshots);
    const createCycleOrder = vi.fn(async () => ({ cycleId: "cycle", orderUuid: "order", orderRef: "order_order", replayed: true }));
    const preflightReservation = vi.fn(async () => {
      if (reason === "busy") throw Object.assign(new Error("inventory_admission_busy"), { code: "55P03" });
      return { ok: false, reason: reason === "stale" ? "stock_stale" : "inventory_unavailable" };
    });
    const deps = { persistence: { buildCycleSnapshots, createCycleOrder, preflightReservation, noteRowOutcome },
      paymentPort: { createIntent, prepareProviderAttempt }, executionPort: { execute },
      capability: { requiresStoredMandateEvidence: false, assessMandate: () => ({ chargeable: true }) },
      deliveryAlignmentAdmission: { allowed: true, state: "none", reason: "no_delay_evidence" }, now: () => "2026-10-20T10:00:00Z" } as unknown as ChargeDeps;
    if (reason === "busy") await expect(chargeSubscriptionCycleOffSession(deps, due)).rejects.toMatchObject({ code: "55P03" });
    else expect(await chargeSubscriptionCycleOffSession(deps, due)).toMatchObject({ outcome: "failed", reason: reason === "stale" ? "stock_stale" : "inventory_unavailable" });
    expect(createCycleOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ idempotencyKey: `subscription:sub-fixture:cycle:${due.nextCycleAt}`,
      scheduledAt: due.nextCycleAt, cycleNumber: 2, templateSnapshot: snapshots.templateSnapshot, orderSnapshot: snapshots.orderSnapshot }));
    expect(preflightReservation).toHaveBeenCalledExactlyOnceWith({ orderId: "order", now: "2026-10-20T10:00:00Z" });
    expect(createIntent).not.toHaveBeenCalled(); expect(prepareProviderAttempt).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(noteRowOutcome).not.toHaveBeenCalled(); expect(JSON.stringify({ due, snapshots })).toBe(before);
  });
});
