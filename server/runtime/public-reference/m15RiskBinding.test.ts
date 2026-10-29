import { expect, it, vi } from "vitest";
import { uniqueRegistry } from "@openlup/outbox";
import type { OutboxEventRow } from "@openlup/core/outbox";
import type { ReadinessReport } from "@openlup/core/readiness";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { createOutboxDispatchRegistry } from "@openlup/platform/commerce/server";
import { createOrderPaidRiskAssessmentPort } from "@openlup/platform/risk/server";
import { createM15RiskReferenceBinding } from "./m15RiskBinding.js";

const orderId = "11111111-1111-4111-8111-111111111111";
const schema = { version: "synthetic-catalogue", migration: "synthetic-risk", objects: [{ kind: "table" as const, name: "risk_assessments" }] };
const report: ReadinessReport = {
  state: "ready", candidate: { artifact: "synthetic", configuration: "synthetic", environment: "synthetic", database: "synthetic", schema: "synthetic" },
  loadedPackages: [], issues: [],
};
const row: OutboxEventRow = {
  id: "synthetic-event", created_at: "2026-01-01T00:00:00.000Z", available_at: "2026-01-01T00:00:00.000Z", processed_at: null,
  aggregate_type: "order", aggregate_id: orderId, event_type: "commerce.order.paid", idempotency_key: "synthetic-paid",
  status: "pending", attempts: 0, payload: { orderUuid: orderId }, error: null, metadata: {},
};
function fixture(kind: "allow" | "review" | "block" | "retry" | "fatal" = "allow", enabled?: boolean) {
  const write = vi.fn(async () => {
    if (kind === "fatal") throw new Error("risk_idempotency_conflict");
    return {
      assessmentId: "synthetic-assessment", caseId: null, holdId: null, holdOpened: false, replayed: false,
      decision: kind === "review" ? "manual_review" as const : kind === "block" ? "block" as const : "allow" as const,
    };
  });
  const evidence = {
    readOrder: vi.fn(async () => ({ id: orderId, clientId: null, subtotalCents: 900, discountCents: 0, shippingCents: 0,
      shippingDiscountCents: 0, taxCents: 0, totalCents: 900, currency: "XTS", mode: "one_time", metadata: {} })),
    readSucceededPaymentIntent: vi.fn(async () => kind === "retry" ? null : { id: "synthetic-payment", amountCents: 900, currency: "XTS" }),
  };
  const readiness = vi.fn(async () => report);
  const authorizeAdmin = vi.fn(async () => ({ ok: true as const, userId: "synthetic-operator" }));
  const listCases = vi.fn(async () => ({ contractVersion: "risk.v1" as const, cases: [], totalCount: 0,
    summaryCounts: { open: 0, inReview: 0, highSeverity: 0, blocked: 0 } }));
  const binding = createM15RiskReferenceBinding({
    enabled, selectedRoutes: ["list"], version: "0.0.0", requiredSchema: schema, readiness, authorizeAdmin,
    adminPort: { listCases, getCaseDetail: async () => null, decideCase: async () => { throw new Error("unused"); } },
    mutationsEnabled: () => false,
    assessmentPort: createOrderPaidRiskAssessmentPort({ mode: "shadow", evidencePort: evidence,
      assessmentPort: { assessPaidOrder: write }, blocklistPort: { checkExactBlocklist: async () => ({ blocked: false, reasonCodes: [] }) } }),
  });
  const fulfill = vi.fn(async () => ({ kind: "completed" as const, detail: { dispatched: true } }));
  const registryFactory = vi.fn(uniqueRegistry);
  const registry = createOutboxDispatchRegistry({ uniqueRegistry: registryFactory, fulfillmentEnabled: true,
    fulfillmentPort: { ensureFulfilledFromPaidOrder: fulfill }, ...binding.outboxRisk });
  async function handle() {
    return registry.get("commerce.order.paid")!.handle(row, new AbortController().signal);
  }
  return { binding, readiness, authorizeAdmin, listCases, fulfill, registry, registryFactory, write, evidence, handle };
}

it("default-off binding advertises no routes or effects and leaves incumbent fulfillment unchanged", async () => {
  const f = fixture();
  expect(f.binding.routes).toEqual({}); expect(f.binding.ports).toEqual({});
  expect(f.binding.contributions[0]).toMatchObject({ handlers: [], schedules: [], routes: [], manifest: { handles: [] } });
  expect(f.binding.outboxRisk.riskEnabled).toBe(false);
  await expect(f.handle()).resolves.toEqual({ kind: "processed", detail: { dispatched: true } });
  await expect(f.binding.readiness()).resolves.toEqual({ kind: "refused", code: "disabled" });
  expect(f.fulfill).toHaveBeenCalledTimes(1); expect(f.readiness).not.toHaveBeenCalled();
  expect(f.evidence.readOrder).not.toHaveBeenCalled(); expect(f.authorizeAdmin).not.toHaveBeenCalled();
});

it("unknown readiness retries before evidence, fulfillment or admin authorization", async () => {
  const f = fixture("allow", true); f.readiness.mockResolvedValue({ ...report, state: "unknown" });
  await expect(f.handle()).resolves.toEqual({ kind: "retry", reason: "risk_schema_unknown" });
  let status = 0; let body: unknown;
  const res = { setHeader() {}, status(code: number) { status = code; return res; }, json(value: unknown) { body = value; return res; } } as unknown as HttpResponse;
  await f.binding.services.list({ method: "GET", query: {} } as HttpRequest, res);
  expect(status).toBe(503); expect(body).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE" } });
  expect(f.readiness).toHaveBeenCalledWith(schema);
  expect(f.evidence.readOrder).not.toHaveBeenCalled(); expect(f.fulfill).not.toHaveBeenCalled();
  expect(f.authorizeAdmin).not.toHaveBeenCalled(); expect(f.listCases).not.toHaveBeenCalled();
});

// Independent rows preserve the captured fulfillment ladder, including shadow without a SQL hold.
it.each([
  { kind: "allow", expected: { kind: "processed", detail: { dispatched: true } }, dispatches: 1, writes: 1 },
  { kind: "review", expected: { kind: "processed", detail: { skipped: "risk_review_hold", risk: { assessmentId: "synthetic-assessment", caseId: null, holdId: null, holdOpened: false } } }, dispatches: 0, writes: 1 },
  { kind: "block", expected: { kind: "processed", detail: { skipped: "risk_review_hold", risk: { assessmentId: "synthetic-assessment", caseId: null, holdId: null, holdOpened: false } } }, dispatches: 0, writes: 1 },
  { kind: "retry", expected: { kind: "retry", reason: "risk_payment_intent_not_ready" }, dispatches: 0, writes: 0 },
  { kind: "fatal", expected: { kind: "discard", reason: "risk_idempotency_conflict" }, dispatches: 0, writes: 1 },
] as const)("existing risk slot maps $kind exactly once", async ({ kind, expected, dispatches, writes }) => {
  const f = fixture(kind, true); await expect(f.handle()).resolves.toEqual(expected);
  expect(f.fulfill).toHaveBeenCalledTimes(dispatches); expect(f.write).toHaveBeenCalledTimes(writes);
  expect(f.evidence.readOrder).toHaveBeenCalledExactlyOnceWith(orderId);
  if (writes) expect(f.write).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `risk:${row.id}:${orderId}`, mode: "shadow", occurredAt: expect.any(String) }));
});

it("selected admin callables share one contribution while the commerce executor is registered once", async () => {
  const f = fixture("allow", true);
  expect(f.binding.contributions[0]).toMatchObject({ handlers: [], schedules: [], manifest: { handles: [], routes: ["/api/bff/admin/risk/cases"] } });
  expect(Object.keys(f.binding.routes)).toEqual(["@openlup/platform/risk:/api/bff/admin/risk/cases"]);
  expect(Object.keys(f.binding.ports)).toEqual(["@openlup/platform/risk:assessPaidOrder"]);
  expect(f.registryFactory).toHaveBeenCalledTimes(1);
  expect(f.registryFactory.mock.calls[0][0].filter(h => h.eventType === "commerce.order.paid")).toHaveLength(1);
  expect([...f.registry.keys()]).toEqual(["commerce.order.paid"]);
  await f.handle(); expect(f.write).toHaveBeenCalledTimes(1); expect(f.fulfill).toHaveBeenCalledTimes(1);
  const res = { setHeader() {}, status() { return res; }, json: vi.fn() } as unknown as HttpResponse;
  const selectedRoute = f.binding.routes["@openlup/platform/risk:/api/bff/admin/risk/cases"] as typeof f.binding.services.list;
  await selectedRoute({ method: "GET", query: {} } as HttpRequest, res);
  expect(f.authorizeAdmin).toHaveBeenCalledTimes(1); expect(f.listCases).toHaveBeenCalledExactlyOnceWith({ page: 1, pageSize: 25 });
  expect(res.json).toHaveBeenCalledWith({ ok: true, data: await f.listCases.mock.results[0].value });
});
