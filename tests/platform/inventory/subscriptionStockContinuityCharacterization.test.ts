import { describe, expect, it, vi } from "vitest";
import { storedMethodCapabilityKinds, storedMethodExpectations } from "../../../src/domains/payment/contracts.js";
import { PLATFORM_DEFAULT_CURRENCY } from "../../../src/lib/currency/platformCurrency.js";
import { chargeSubscriptionCycleOffSession, type ChargeDeps } from "../../../server/domains/subscription/chargeSubscriptionCycleOffSession.js";
const PROVIDER = storedMethodCapabilityKinds.find(kind => storedMethodExpectations(kind)?.requiredMethodKind === null)!;


// W4 is a boundary transcript, not a stock-wait implementation or durable parity proof.
// Only the incumbent charge routine executes. These finite fixture bindings replay the
// captured admission responses; selection, recovery, SQL and lifecycle remain private.
type CycleInput = Parameters<ChargeDeps["persistence"]["createCycleOrder"]>[0];
type Due = Parameters<typeof chargeSubscriptionCycleOffSession>[1];
type Admission = { waiting: boolean; caseId: string; bypass: boolean; order: {
  cycleId: string; orderRef: string; orderUuid: string; paymentRef: string; replayed: boolean;
} | null };
function createStockWaitStore(client: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code: string; message: string } | null }> }) {
  return { async admit(request: CycleInput, due: Due, at: string): Promise<Admission> {
    const response = await client.rpc("fixture_admission_transcript", { request, due, at });
    if (response.error) throw Object.assign(new Error("transcript admission refused"), {
      details: { code: response.error.code, reason: response.error.message },
    });
    const data = response.data as { error?: string; waiting?: boolean; caseId: string; subscriptionCycleOrder?: {
      cycleId: string; orderId: string; paymentId: string; replayed: boolean;
    } };
    if (data.error) throw new Error(data.error);
    const row = data.subscriptionCycleOrder;
    return { waiting: data.waiting === true, caseId: data.caseId, bypass: false,
      order: row ? { cycleId: row.cycleId, orderRef: row.orderId, orderUuid: row.orderId.replace(/^order_/, ""), paymentRef: row.paymentId, replayed: row.replayed } : null };
  } };
}
function createStockWaitRenewalPorts(input: { store: {
  listCandidates: () => Promise<Due[]>;
  read: () => Promise<{ snapshots: Awaited<ReturnType<ChargeDeps["persistence"]["buildCycleSnapshots"]>> }>;
  admit: (request: CycleInput, due: Due, at: string) => Promise<Admission>;
}; persistence: ChargeDeps["persistence"]; now: () => string }) {
  let selected: Due, captured: CycleInput;
  const admit = async (request: CycleInput) => {
    const result = await input.store.admit(request, selected, input.now());
    if (result.bypass) throw new Error("stock_wait_recovery_provider_owned");
    if (result.waiting) throw Object.assign(new Error("subscription_stock_wait"), {
      name: "RenewalAdmissionDeferral", reason: "subscription_stock_wait", reference: result.caseId,
    });
    if (!result.order) throw new Error("transcript order missing");
    return result.order;
  };
  return { duePort: { async listDue(_limit: number) { const rows = await input.store.listCandidates(); selected = rows[0]; return rows; } },
    persistence: { ...input.persistence,
      buildCycleSnapshots: async () => (await input.store.read()).snapshots,
      createCycleOrder: async (request: CycleInput) => { captured = request; return admit(request); },
      preflightReservation: async () => { await admit(captured); return { ok: true, reason: null, itemsChecked: 0, reacquired: 0 }; },
    },
  };
}

const AT = "2026-10-20T12:00:00+02:00";
const KEY = `subscription:sub-a:cycle:${AT}`;
function setup(refusal?: "shortage" | "stale" | "busy") {
  const due = { subscriptionId: "sub-a", clientId: "client-a", nextCycleAt: AT, currency: PLATFORM_DEFAULT_CURRENCY, providerKind: PROVIDER,
    providerCustomerRef: "customer-example", providerMethodRef: "method-example", methodKind: "card", payerEmail: null, payerName: null };
  const binding = { caseId: "case-a", cycleId: "cycle-a", orderId: "order-a", paymentId: "payment-a", engineIdempotencyKey: KEY };
  const snapshots = { cycleNumber: 2, retryAttempt: 1, providerAttemptSequence: 3,
    templateSnapshot: { cadence_days: 28, lines: [{ sku: "A", qty: 2 }, { sku: "B", qty: 3 }] },
    pricingSnapshot: { scheduledAt: AT }, orderSnapshot: { totals: { totalGross: { amountMinor: 5000, currency: PLATFORM_DEFAULT_CURRENCY } } } };
  const admitted = { data: { waiting: false, caseId: "case-a", subscriptionCycleOrder: {
    cycleId: "cycle-a", orderId: "order_order-a", paymentId: "payment-a", replayed: true,
  } }, error: null };
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: { code: string; message: string } | null }> => admitted);
  if (refusal) rpc.mockResolvedValueOnce(admitted).mockResolvedValueOnce(refusal === "busy"
    ? { data: null, error: { code: "55P03", message: "inventory_admission_busy" } }
    : { data: refusal === "stale" ? { error: "stock_wait_check_failed" }
      : { waiting: true, caseId: "case-a" }, error: null });
  const realStore = createStockWaitStore({ rpc });
  const store = { listNormalCandidates: vi.fn(async () => [due]),
    listCandidates: vi.fn(async () => [{ ...due, stockWaitRecovery: binding }]),
    read: vi.fn(async () => ({ case: {}, binding, snapshots })),
    admit: vi.fn(realStore.admit),
    markResumed: vi.fn(), findCase: vi.fn() };
  const original = { buildCycleSnapshots: vi.fn(), createCycleOrder: vi.fn(), preflightReservation: vi.fn(),
    readMandateRecurringModel: vi.fn(), noteRowOutcome: vi.fn() };
  const ports = createStockWaitRenewalPorts({ store: store as never, persistence: original as never, now: () => AT });
  const execute = vi.fn(async () => ({ providerAttemptId: "attempt", providerSessionId: null, attemptStatus: "succeeded",
    nextActionKind: null, requestPayload: {}, responsePayload: {} }));
  const createIntent = vi.fn(async () => ({ paymentIntentId: "payment-a", replayed: true }));
  const prepare = vi.fn(async () => ({ paymentAttemptId: "attempt-a", status: "prepared", replayed: false }));
  const deps = { persistence: ports.persistence, executionPort: { execute }, paymentPort: { createIntent,
    prepareProviderAttempt: prepare, finalizeProviderAttempt: vi.fn(async () => ({ status: "succeeded" })) },
    capability: { requiresStoredMandateEvidence: false, assessMandate: () => ({ chargeable: true }),
      unattendedChargeFlow: "off_session_payment", payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false } },
    deliveryAlignmentAdmission: { allowed: true, state: "none", reason: "no_delay_evidence" }, now: () => AT } as unknown as ChargeDeps;
  return { due, binding, snapshots, store, original, ports, execute, createIntent, prepare,
    charge: async () => { const [selected] = await ports.duePort.listDue(1); return chargeSubscriptionCycleOffSession(deps, selected!); } };
}

describe("W4 frozen stock-wait → preflight → actual provider preparation", () => {
  it("keeps the full frozen basket, literal schedule and retry sequence through the charge boundary", async () => {
    const f = setup(); const bytes = JSON.stringify(f.snapshots);
    expect(await f.charge()).toMatchObject({ outcome: "charged", cycleNumber: 2 });
    expect(f.store.admit).toHaveBeenCalledTimes(2);
    expect(f.store.admit.mock.calls[0]?.slice(0, 2)).toEqual(f.store.admit.mock.calls[1]?.slice(0, 2));
    expect(f.store.admit.mock.calls[1]?.[0]).toMatchObject({ idempotencyKey: KEY, scheduledAt: AT,
      templateSnapshot: f.snapshots.templateSnapshot, orderSnapshot: f.snapshots.orderSnapshot });
    expect(f.store.admit.mock.invocationCallOrder[1]).toBeLessThan(f.prepare.mock.invocationCallOrder[0]!);
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ requestPayload: expect.objectContaining({
      scheduledAt: AT, retryAttempt: 1, providerAttemptSequence: 3, amountMinor: 5000,
    }) }));
    expect(f.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.snapshots)).toBe(bytes);
    expect(f.original.buildCycleSnapshots).not.toHaveBeenCalled();
    expect(f.original.createCycleOrder).not.toHaveBeenCalled();
    expect(f.store.markResumed).not.toHaveBeenCalled(); // Payment + local fulfilment own resumption.
  });
  it.each(["shortage", "stale", "busy"] as const)("stops %s admission before intent/attempt without lifecycle or schedule writes", async refusal => {
    const f = setup(refusal);
    const expected = refusal === "shortage"
      ? { name: "RenewalAdmissionDeferral", message: "subscription_stock_wait", reason: "subscription_stock_wait", reference: "case-a" }
      : refusal === "stale" ? { name: "Error", message: "stock_wait_check_failed" }
        : { details: { code: "55P03", reason: "inventory_admission_busy" } };
    await expect(f.charge()).rejects.toMatchObject(expected);
    expect(f.createIntent).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.original.noteRowOutcome).not.toHaveBeenCalled();
    expect(f.store.markResumed).not.toHaveBeenCalled();
    expect(f.due.nextCycleAt).toBe(AT);
    expect(f.snapshots.templateSnapshot.cadence_days).toBe(28);
  });
  it("refuses a recovery graph that became provider-owned before any new payment work", async () => {
    const f = setup();
    f.store.admit.mockResolvedValue({ waiting: false, caseId: "case-a", order: null, bypass: true } as never);
    await expect(f.charge()).rejects.toThrow("stock_wait_recovery_provider_owned");
    expect(f.original.preflightReservation).not.toHaveBeenCalled();
    expect(f.createIntent).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
});
