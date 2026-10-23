import { expect, it, vi } from "vitest";
import { createM09InvoicingReferenceBinding } from "./m09InvoicingBinding.js";
import { runAccountingRuntimeOnce } from "../accounting/accountingRuntime.js";
import { createOutboxDispatchRegistry } from "../../domains/commerce/outboxDispatchRegistry.js";
import { buildAccountingOrderReversalHandlers } from "../../../api/_cron/accountingOrderReversalHandlers.js";
import { createNativeUnsupportedInvoicePorts, createInvoiceContribution } from "@openlup/platform/invoicing";

it("default-off reference construction advertises no jobs or routes and never reads readiness", async () => {
  const readiness = vi.fn(async () => ({ kind: "ready" as const }));
  const binding = createM09InvoicingReferenceBinding({ version: "test", requiredSchema: { version: "full", migration: "full", objects: [] },
    services: { ...createNativeUnsupportedInvoicePorts(), selection: null, capability: null, readiness, factories: {} },
  });
  expect(await binding.readiness()).toMatchObject({ code: "disabled" });
  expect(binding.contributions[0].manifest).toMatchObject({ handles: [], schedules: [], routes: [], env: [] });
  expect(readiness).not.toHaveBeenCalled();
});
it("default-off accounting and refused module readiness cannot construct a gateway or claim a host job lease", async () => {
  const gatewayFactory = vi.fn(); const claim = vi.fn(); const finish = vi.fn();
  const common = { kind: "invoice-issue" as const, context: { triggerKind: "worker" as const, invocationSource: "test" }, gatewayFactory, runControl: { claim, finish } };
  expect(await runAccountingRuntimeOnce({ ...common, env: {} })).toMatchObject({ body: { skipped: true, reason: "disabled" } });
  const run = vi.fn();
  expect(await runAccountingRuntimeOnce({ ...common, env: { ACCOUNTING_CREATE_ENABLED: "true" }, invoicing: { readiness: async () => ({ kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false }), run } })).toMatchObject({ status: 503 });
  expect(gatewayFactory).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
});
it("F6: contribution descriptors equal every existing inline reversal registration and preserve one registry handler per event", () => {
  const handlers = buildAccountingOrderReversalHandlers({ enabled: true, providerKind: "host", accountingPort: {
    requestCorrectionScaffold: vi.fn(), requestInvoiceReversalFromOrderStatus: vi.fn(),
  } });
  expect(handlers).toHaveLength(3);
  const contribution = createInvoiceContribution({ version: "test", requiredSchema: { version: "full", migration: "full", objects: [] }, invoicing: {},
    handlers, schedules: [], routes: [],
  });
  const inline = createOutboxDispatchRegistry({ fulfillmentEnabled: false, extraHandlers: handlers });
  const expected = [
    { eventType: "commerce.order.canceled", timeoutMs: 10000 },
    { eventType: "commerce.order.refunded", timeoutMs: 10000 },
    { eventType: "accounting.order.reversal_requested", timeoutMs: 10000 },
  ];
  expect(handlers.map(({ eventType, timeoutMs }) => ({ eventType, timeoutMs }))).toEqual(expected);
  expect(contribution.contributions[0].manifest.handles).toEqual([...inline.keys()]);
  for (const [eventType, handler] of inline) {
    expect(contribution.contributions[0].handlers.find(value => value.eventType === eventType)).toBe(handler);
    expect(handler.timeoutMs).toBe(contribution.contributions[0].handlers.find(value => value.eventType === eventType)!.timeoutMs);
  }
});
it("executes the selected service once inside the existing host job lease", async () => {
  const trace: string[] = [];
  const result = { ok: true, checked: 1, updated: 1, skipped: false, failures: 0 };
  const claim = vi.fn(async () => { trace.push("claim"); return { acquired: true, runId: "run", reason: "acquired" }; });
  const finish = vi.fn(async () => { trace.push("finish"); });
  const run = vi.fn(async () => { trace.push("execute"); return result; });
  const gatewayFactory = vi.fn(() => ({ asService: async (work: (client: unknown) => Promise<unknown>) => { trace.push("gateway"); return work({}); } }));
  expect(await runAccountingRuntimeOnce({ kind: "invoice-issue", context: { triggerKind: "worker", invocationSource: "test" },
    env: { ACCOUNTING_CREATE_ENABLED: "true", SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-conformance" },
    gatewayFactory: gatewayFactory as never, runControl: { claim, finish },
    invoicing: { readiness: async () => { trace.push("ready"); return { kind: "ready" }; }, run },
  })).toEqual({ status: 200, body: result });
  expect(trace).toEqual(["ready", "gateway", "claim", "execute", "finish"]);
  expect(claim).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledExactlyOnceWith("issue"); expect(finish).toHaveBeenCalledTimes(1);
});
it.each(["invoice-issue", "invoice-delivery"] as const)("refuses targeted %s before a module factory can run outside its order scope", async kind => {
  const gatewayFactory = vi.fn(); const claim = vi.fn(); const finish = vi.fn(); const run = vi.fn();
  expect(await runAccountingRuntimeOnce({ kind, context: { triggerKind: "operator", invocationSource: "test", orderId: "target-order" },
    env: { ACCOUNTING_CREATE_ENABLED: "true", ACCOUNTING_EMAIL_ENABLED: "true" },
    gatewayFactory, runControl: { claim, finish }, invoicing: { readiness: async () => ({ kind: "ready" }), run },
  })).toEqual({ status: 503, body: { ok: false, skipped: true, reason: "order_scoped_invoicing_unsupported" } });
  expect(gatewayFactory).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
});
