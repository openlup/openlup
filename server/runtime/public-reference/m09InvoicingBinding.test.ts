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
it("default-off selected accounting and refused module readiness cannot construct a gateway or claim a host job lease", async () => {
  const gatewayFactory = vi.fn(); const claim = vi.fn(); const finish = vi.fn();
  const common = { kind: "invoice-issue" as const, context: { triggerKind: "worker" as const, invocationSource: "test" }, gatewayFactory, runControl: { claim, finish } };
  const run = vi.fn();
  expect(await runAccountingRuntimeOnce({ ...common, env: {}, invoicing: { readiness: vi.fn(), run } })).toMatchObject({ body: { skipped: true, reason: "disabled" } });
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

it("refuses an order-scoped correction before the gateway or lease for unselected accounting", async () => {
  const gatewayFactory = vi.fn(); const claim = vi.fn(); const finish = vi.fn();
  expect(await runAccountingRuntimeOnce({ kind: "invoice-correction",
    context: { triggerKind: "operator", invocationSource: "test", orderId: "target-order" },
    env: {}, gatewayFactory, runControl: { claim, finish },
  })).toEqual({ status: 503, body: { ok: false, skipped: true, reason: "order_scoped_correction_unsupported" } });
  expect(gatewayFactory).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
});

  it("does not construct payment readback providers for non-issue jobs", async () => {
    const finish = vi.fn();
    const result = await runAccountingRuntimeOnce({
      kind: "invoice-delivery",
      context: { triggerKind: "worker", invocationSource: "test" },
      env: runtimeEnvWithInvalidStripeKey(),
      gatewayFactory: (() => ({ asService: async (run: (client: unknown) => unknown) => run({}) })) as never,
      runControl: {
        claim: vi.fn().mockResolvedValue({ acquired: true, runId: "run-1", reason: "claimed" }),
        finish,
      },
    });

    expect(result).toEqual({
      status: 200,
      body: expect.objectContaining({ ok: true, skipped: true, reason: "provider_email_disabled" }),
    });
    expect(finish).toHaveBeenCalledWith(
      {}, "accounting-invoice-delivery", "run-1", "success",
      expect.objectContaining({ reason: "provider_email_disabled" }),
      expect.any(Object),
    );
  });


function runtimeEnvWithInvalidStripeKey(): Record<string, string> {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    COMMERCE_ACCOUNTING_PROVIDER_MODE: "test",
    ACCOUNTING_CREATE_ENABLED: "true",
    STRIPE_PROVIDER_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_live_not-confirmed",
  };
}

it.each([
  { name: "disabled", env: {}, reason: "create_disabled", status: 200, finishStatus: "success" },
  { name: "provider rollback", env: { ACCOUNTING_CREATE_ENABLED: "true" }, reason: "provider_disabled", status: 200, finishStatus: "success" },
  { name: "provider config error", env: { ACCOUNTING_PROVIDER: "test", ACCOUNTING_MUTATIONS_ENABLED: "true" }, reason: "accounting_provider_mode_conflict_real_mutations_enabled", status: 502, finishStatus: "failed" },
])("records unselected $name inside the existing lease", async row => {
  const trace: string[] = [];
  const finish = vi.fn(async () => { trace.push("finish"); });
  const result = await runAccountingRuntimeOnce({ kind: "invoice-issue",
    context: { triggerKind: "scheduler", invocationSource: "test" },
    env: { SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic", ...row.env },
    gatewayFactory: (() => ({ asService: async (run: (client: unknown) => unknown) => run({}) })) as never,
    runControl: { claim: vi.fn(async () => { trace.push("claim"); return { acquired: true, runId: "run", reason: "claimed" }; }), finish },
  });
  expect(result).toMatchObject({ status: row.status, body: { reason: row.reason } });
  expect(trace).toEqual(["claim", "finish"]);
  expect(finish).toHaveBeenCalledWith({}, "accounting-invoice-issue", "run", row.finishStatus,
    expect.objectContaining({ reason: row.reason }), expect.any(Object));
});
