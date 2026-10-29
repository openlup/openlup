import { afterEach, expect, it, vi } from "vitest";
import { createOrderPaidRiskAssessmentPort, riskSubjectHash, safeRiskString } from "../../src/risk/server/index.js";
import { createOutboxOrderPaidFulfillmentHandler } from "../../src/fulfillment/index.js";
import type { RiskAssessmentWritePort } from "../../src/risk/contracts/index.js";
const orderId = "10000000-0000-4000-8000-000000000001";
const order = { id: orderId, clientId: "client-a", subtotalCents: 900, discountCents: 0, shippingCents: 0, shippingDiscountCents: 0, taxCents: 0, totalCents: 900, currency: "XTS", mode: "one_time", metadata: {} };
const input = { orderUuid: orderId, outboxEventId: "event-a", signal: new AbortController().signal };
function fixture(options: {
    missingOrder?: boolean;
    missingPayment?: boolean;
    error?: unknown;
    decision?: "allow" | "manual_review" | "block";
    invalidMoney?: boolean;
} = {}) {
    const writes: Parameters<RiskAssessmentWritePort["assessPaidOrder"]>[0][] = [];
    const readOrder = vi.fn(async () => options.missingOrder ? null : { ...order, totalCents: options.invalidMoney ? null : 900 });
    const port = createOrderPaidRiskAssessmentPort({ mode: "shadow", hashSecret: "synthetic-test-hash-secret", evidencePort: { readOrder, readSucceededPaymentIntent: async () => options.missingPayment ? null : { id: "payment-a", amountCents: 900, currency: "XTS" } }, blocklistPort: { checkExactBlocklist: async () => ({ blocked: options.decision === "block", reasonCodes: ["exact_blocklist_match"] }) }, assessmentPort: { assessPaidOrder: async (request) => { writes.push(request); if (options.error)
                throw options.error; return { assessmentId: "assessment-a", caseId: null, holdId: null, holdOpened: false, replayed: false, decision: options.decision ?? "allow" }; } } });
    return { port, writes, readOrder };
}
afterEach(() => vi.useRealTimers());
it("refuses an aborted assessment before reading", async () => { const f = fixture(); expect(await f.port.assessPaidOrder({ ...input, signal: AbortSignal.abort() })).toEqual({ kind: "retryable", reason: "risk_assessment_timeout" }); expect(f.readOrder).not.toHaveBeenCalled(); });
it("refuses a missing order", async () => { expect(await fixture({ missingOrder: true }).port.assessPaidOrder(input)).toEqual({ kind: "fatal", reason: "risk_order_not_found" }); });
it("waits for payment evidence", async () => { const f = fixture({ missingPayment: true }); expect(await f.port.assessPaidOrder(input)).toEqual({ kind: "retryable", reason: "risk_payment_intent_not_ready" }); expect(f.writes).toEqual([]); });
it("never substitutes payment money for missing order truth", async () => { const f = fixture({ invalidMoney: true }); expect(await f.port.assessPaidOrder(input)).toEqual({ kind: "fatal", reason: "risk_order_money_invalid_input" }); expect(f.writes).toEqual([]); });
it("preserves hashes, key bytes, sanitized evidence, zero signals and timestamp regeneration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-01-01T00:00:00Z");
    const f = fixture();
    expect(await f.port.assessPaidOrder(input)).toEqual({ kind: "allow", detail: { assessmentId: "assessment-a" } });
    vi.advanceTimersByTime(1000);
    await f.port.assessPaidOrder(input);
    expect(f.writes[0]).toMatchObject({ idempotencyKey: `risk:event-a:${orderId}`, paymentIntentId: "payment-a", paymentEventId: null, mode: "shadow", occurredAt: "2026-01-01T00:00:00.000Z", evaluation: { decision: "allow", score: 0, matchedRules: [] }, evidence: { sanitized: true, source: "commerce.order.paid", outboxEventId: "event-a", blocklistReasonCodes: ["exact_blocklist_match"] } });
    expect(f.writes[1].occurredAt).toBe("2026-01-01T00:00:01.000Z");
    expect(f.writes[1].idempotencyKey).toBe(f.writes[0].idempotencyKey);
    expect(f.writes[0].subjectRefs).toEqual([{ subjectKind: "client", subjectHash: riskSubjectHash("client", "client-a", "synthetic-test-hash-secret") }, { subjectKind: "identity_cluster", subjectHash: riskSubjectHash("order", orderId, "synthetic-test-hash-secret") }]);
    expect(riskSubjectHash("email", "  A@EXAMPLE.INVALID ")).toBe(riskSubjectHash("email", "a@example.invalid", "short"));
    expect(riskSubjectHash("email", "a@example.invalid", "synthetic-test-hash-secret")).not.toBe(riskSubjectHash("email", "a@example.invalid"));
    expect(safeRiskString("  x ")).toBe("x");
    expect(safeRiskString(0)).toBeNull();
});
it("shadow block still acknowledges without dispatch even with no SQL hold", async () => { const f = fixture({ decision: "block" }), dispatch = vi.fn(); const handler = createOutboxOrderPaidFulfillmentHandler({ riskPort: f.port, isRiskEnabled: () => true, fulfillmentPort: { ensureFulfilledFromPaidOrder: dispatch } }); expect(await handler.handle({ id: "event-a", payload: { orderUuid: orderId } } as never, input.signal)).toMatchObject({ kind: "processed", detail: { skipped: "risk_review_hold", risk: { holdOpened: false } } }); expect(dispatch).not.toHaveBeenCalled(); expect(f.writes[0].evaluation).toMatchObject({ decision: "block", enforcement: { mode: "shadow", holdRequested: false } }); });
it("shadow manual review retains its result", async () => { expect(await fixture({ decision: "manual_review" }).port.assessPaidOrder(input)).toMatchObject({ kind: "review", detail: { holdOpened: false } }); });
it("preserves fatal RPC conflict and retryable unknown error mapping/truncation", async () => { expect(await fixture({ error: { code: "23505" } }).port.assessPaidOrder(input)).toEqual({ kind: "fatal", reason: "23505" }); expect(await fixture({ error: new Error("x".repeat(301)) }).port.assessPaidOrder(input)).toEqual({ kind: "retryable", reason: "x".repeat(300) + "..." }); });
