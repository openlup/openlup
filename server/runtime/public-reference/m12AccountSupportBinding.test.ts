import { expect, expectTypeOf, it, vi } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { createTransactionalDelivery, type TransactionalDeliveryReceipt, type TransactionalDeliveryReceiptStore } from "@openlup/platform/communications";
import { createAccountReadFacade, createOperatorRecovery, type AccountSupportCapabilities, type AccountSupportHostBindingRequired, type AccountSupportBindingRefusal,
  type NativeOperatorSubscriptionResult, type OperatorRecoveryCommand, type OperatorRecoveryCommandEnvelope } from "@openlup/platform/account-support";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import type { ReadinessReport } from "@openlup/core/readiness";
import { createM12AccountSupportReferenceBinding, createM12OperatorSubscriptionActionRoute, type M12CommerceSelection } from "./m12AccountSupportBinding.js";
import { createM11CommerceReferenceBinding } from "./m11CommerceBinding.js";
import { createOutboxDispatchRegistry, describeCoreOutboxHandlers, outboxCheckoutRecoveryEmailDescriptor, type CommerceEmailRuntime } from "@openlup/platform/commerce/server";
import { m11CommerceSchema } from "./m11CommerceSchema.js";
import { createReferenceSubscriptionFacades } from "./subscriptionFacades.js";
import { requestBff } from "../../../src/lib/bff/client.js";
import { operatorSubscriptionActionResponseSchema } from "../../../src/domains/support/customerSupportCommandContracts.js";
import { OperatorSubscriptionAuthorityUnavailableError } from "../../domains/support/customerRecoveryCommand.js";

const unavailable = { supported: false as const, refusalCode: "host_binding_required" as const };
const capabilities: AccountSupportCapabilities = {
  graph: "native", accountRead: { supported: true }, customer360Read: unavailable, invoiceAccess: unavailable,
  commerceRecovery: unavailable, configuredPurchase: unavailable, paymentMethodSetup: { supported: false, refusalCode: "unsupported" },
  operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  subscriptions: NATIVE_SUBSCRIPTION_CAPABILITIES, communicationGifts: { supported: false, refusalCode: "unsupported_preference" },
};
const candidate = { artifact: "artifact", configuration: "config", environment: "local", database: "db", schema: "full" };
function fixture(enabled?: boolean) {
  const owner = vi.fn(async (principal: string) => ({ principal }));
  const read = createAccountReadFacade({ account: { getAccount: owner }, orders: { listOrders: async () => null, getOrderDetail: async () => null } });
  const readiness = vi.fn(async (): Promise<ReadinessReport> => ({ state: "ready", candidate, loadedPackages: [], issues: [] }));
  const options = { enabled, graph: "native" as const, capabilities, operations: { account: read.getAccount, alias: read.getAccount, invoice: null },
    commerce: null, ownerSchemas: [], requiredObjects: [], dependsOn: [], version: "0.26.0", catalogue: { version: "full", migration: "host" },
    routes: [{ id: "account", handle: read.getAccount }], readiness };
  return { owner, readiness, options };
}

const operatorRequest: OperatorRecoveryCommandEnvelope<Extract<OperatorRecoveryCommand, { action: "apply_subscription_action" }>> = {
  actor: { operatorId: "operator-a", graph: "native", role: "admin", isMachineActor: false },
  subject: { subjectId: "customer-a", subscriptionId: "subscription-a" }, command: { action: "apply_subscription_action",
    subscriptionId: "subscription-a", subscriptionAction: "pause", expectedVersion: 7, idempotencyKey: "original-key", payload: { pausePreset: "indefinite" } },
  expectedVersion: 7, idempotencyKey: "original-key", reason: null, evidence: [],
};
const operatorWireBase = { contractVersion: "support.customer_360.v2", action: "apply_subscription_action",
  subscriptionAction: "pause", subscriptionId: "subscription-a" };
const ownerReceipt = { id: "receipt-a", actorId: "operator-a", idempotencyKey: "original-key",
  commandFingerprint: "original-fingerprint", result: { subscriptionStatus: "paused", templateVersion: 7 } };
const settled = { subscriptionStatus: "paused", nextCycleAt: "2026-09-11T12:00:00.000Z", templateVersion: 7,
  eventId: "event-a", appliedBy: null };

it.each([
  { result: { outcome: "applied", ...settled, ownerReceipt }, wire: { outcome: "applied", ...settled } },
  { result: { outcome: "noop", ...settled, nextCycleAt: null, eventId: null }, wire: { outcome: "noop", ...settled, nextCycleAt: null, eventId: null } },
  { result: { outcome: "replayed", ...settled, appliedBy: "customer_self_service_delegate", ownerReceipt },
    wire: { outcome: "replayed", ...settled, appliedBy: "customer_self_service_delegate" } },
  { result: { outcome: "refused", refusalCode: "payment_blocked", ownerReceipt }, wire: { outcome: "refused", refusalCode: "payment_blocked" } },
  { result: { outcome: "conflict", refusalCode: "version_conflict", ownerReceipt }, wire: { outcome: "conflict", refusalCode: "version_conflict" } },
] satisfies { result: NativeOperatorSubscriptionResult; wire: object }[])("operator route round-trips the complete donor $result.outcome wire through the browser client", async ({ result, wire }) => {
  const unselected = async () => { throw new Error("unexpected_operator_command"); };
  const recovery = createOperatorRecovery({ graph: "native", authority: {
    applySubscriptionAction: async () => result, correctSubjectEmail: unselected, correctSubjectPhone: unselected,
    issueRecovery: unselected, absorbLead: unselected, linkSubjectAccount: unselected,
  } });
  const execute = vi.spyOn(recovery, "execute");
  const operator = createM12OperatorSubscriptionActionRoute(execute), f = fixture(true);
  const binding = createM12AccountSupportReferenceBinding({ ...f.options, operations: { operator }, routes: [{ id: "operator", handle: operator }] });
  const route = binding.routes["@openlup/platform/account-support:operator"] as typeof binding.services.operations.operator;
  expect(route).toBe(binding.services.operations.operator);
  const response = await route(operatorRequest);
  expect(response).toEqual({ ...operatorWireBase, ...wire });
  expect(execute).toHaveBeenCalledExactlyOnceWith(operatorRequest);
  expect(execute.mock.calls[0]![0]).toBe(operatorRequest);
  expect(response).not.toHaveProperty("ownerReceipt");
  // The donor applyOperatorSubscriptionAction client uses this parser and schema.
  expect(await requestBff("/api/bff/admin/support/customer-journey", operatorSubscriptionActionResponseSchema, {
    fetcher: async () => Response.json({ ok: true, data: response }),
  })).toEqual(response);
  expect(await execute.mock.results[0]!.value).toBe(result);
  if ("ownerReceipt" in result) expect(result.ownerReceipt).toBe(ownerReceipt);
});

it("operator route translates native authority unavailability to the donor error", async () => {
  const result = { outcome: "refused", refusalCode: "operator_subscription_authority_unavailable" } as const;
  const execute = vi.fn(async (_request: typeof operatorRequest) => result);
  const response = createM12OperatorSubscriptionActionRoute(execute)(operatorRequest);
  await expect(response).rejects.toThrow(OperatorSubscriptionAuthorityUnavailableError);
  await expect(response).rejects.toThrow("operator_subscription_authority_unavailable");
  expect(execute).toHaveBeenCalledExactlyOnceWith(operatorRequest);
});

it("operator route propagates R4 errors without returning a settled wire response", async () => {
  const failure = new Error("customer_support_operator_scope_mismatch");
  const execute = vi.fn(async (_request: typeof operatorRequest) => { throw failure; });
  await expect(createM12OperatorSubscriptionActionRoute(execute)(operatorRequest)).rejects.toBe(failure);
  expect(execute).toHaveBeenCalledExactlyOnceWith(operatorRequest);
});

it.each([undefined, false])("R1/R2 enablement %s leaves every entrance cold", async enabled => {
  const f = fixture(enabled), binding = createM12AccountSupportReferenceBinding(f.options);
  expect(binding.contributions[0]!.routes).toEqual([]); expect(binding.ports).toEqual({}); expect(binding.routes).toEqual({}); expect(binding.triggers).toEqual({});
  expect(await binding.readiness()).toEqual({ kind: "refused", code: "disabled" });
  expect(await binding.services.operations.account("principal")).toEqual({ kind: "refused", code: "disabled" });
  expect(await binding.services.commerce("checkoutStart")).toEqual({ kind: "refused", code: "disabled" });
  expect(f.readiness).not.toHaveBeenCalled(); expect(f.owner).not.toHaveBeenCalled();
});

it("disabled M12 refuses keyed commerce before the enabled M11 owner or injected record", async () => {
  const f = fixture(false), start = vi.fn(async (key: string) => ({ key }));
  const injected = vi.fn(async (key: string) => ({ key }));
  const commerceOwner = createM11CommerceReferenceBinding({ enabled: true,
    executor: { query: vi.fn((): never => { throw new Error("unexpected_query"); }) }, commerce: { start },
    version: f.options.version, catalogue: f.options.catalogue, requiredObjects: [], readiness: f.readiness,
    routes: [{ id: "start", handle: start }], schedules: [{ id: "start", cadenceSeconds: 60, run: start }] });
  const ownerService = vi.spyOn(commerceOwner.services, "start");
  const binding = createM12AccountSupportReferenceBinding({ ...f.options, commerce: { start: injected }, commerceOwner, commerceRegistry: new Map() });
  const disabled = createM12AccountSupportReferenceBinding(f.options);
  expect(binding.contributions).toEqual(disabled.contributions);
  expect(binding.contributions).toHaveLength(1); expect(binding.contributions[0]!.routes).toEqual([]);
  expect(binding.ports).toEqual({}); expect(binding.ports).toEqual(disabled.ports);
  expect(binding.routes).toEqual({}); expect(binding.routes).toEqual(disabled.routes);
  expect(binding.triggers).toEqual({}); expect(binding.triggers).toEqual(disabled.triggers);
  expect(binding.commerceOwner).toBeNull(); expect(binding.commerceRegistry).toBeNull();
  expect(await binding.services.commerce("start", "original-key")).toEqual({ kind: "refused", code: "disabled" });
  expect(ownerService).not.toHaveBeenCalled(); expect(injected).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled(); expect(f.readiness).not.toHaveBeenCalled();
});

it("R3 unknown schema refuses services and route aliases before owner work", async () => {
  const f = fixture(true); f.readiness.mockResolvedValue({ state: "unknown", candidate, loadedPackages: [], issues: [] });
  const binding = createM12AccountSupportReferenceBinding(f.options);
  expect(await binding.services.operations.account("principal")).toEqual({ kind: "refused", code: "schema_unknown" });
  expect(await binding.contributions[0]!.routes[0]!.handle(...[] as never[])).toEqual({ kind: "refused", code: "schema_unknown" });
  expect(f.owner).not.toHaveBeenCalled(); expect(f.readiness).toHaveBeenCalledTimes(2);
});

it("R4 re-observes selected objects and refuses unsatisfied readiness after an earlier success", async () => {
  const f = fixture(true);
  const preview = { kind: "function" as const, name: "public.subscription_command_preview", signature: "uuid,uuid,text,uuid,text,jsonb,timestamp with time zone" };
  const apply = { ...preview, name: "public.subscription_command_apply" }, overload = { ...preview, signature: "uuid" };
  const objects = [preview, apply, overload];
  const binding = createM12AccountSupportReferenceBinding({ ...f.options,
    ownerSchemas: [{ version: "partial", migration: "owner", objects: [preview, apply] }], requiredObjects: [preview, overload] });
  expect(binding.schema).toEqual({ version: "full", migration: "host", objects });
  expect(await binding.services.operations.account("principal")).toEqual({ principal: "principal" });
  f.readiness.mockResolvedValue({ state: "unsatisfied", candidate, loadedPackages: [], issues: [] });
  expect(await binding.services.operations.account("principal")).toEqual({ kind: "refused", code: "schema_unsatisfied" });
  expect(await binding.contributions[0]!.routes[0]!.handle(...[] as never[])).toEqual({ kind: "refused", code: "schema_unsatisfied" });
  expect(f.owner).toHaveBeenCalledTimes(1); expect(f.readiness).toHaveBeenCalledTimes(3);
  expect(f.readiness).toHaveBeenLastCalledWith(binding.schema);
  expect(objects).toEqual([preview, apply, overload]);
});

it("R5 service, port and route aliases use the same selected executor", async () => {
  const f = fixture(true), binding = createM12AccountSupportReferenceBinding(f.options);
  const operation = binding.services.operations.account;
  expect(binding.services.operations.alias).toBe(operation);
  expect(binding.ports["@openlup/platform/account-support:account"]).toBe(operation);
  expect(binding.contributions[0]!.routes[0]!.handle).toBe(operation);
  expect(binding.routes["@openlup/platform/account-support:account"]).toBe(operation);
  expect(await operation("actor-original")).toEqual({ principal: "actor-original" }); expect(f.owner).toHaveBeenCalledExactlyOnceWith("actor-original");
  expect(await binding.services.commerce("checkoutStart")).toEqual({ kind: "unsupported", code: "host_binding_required" });
  expect(binding.services.capabilities.commerceRecovery).toEqual(unavailable);
  expect(binding.services.capabilities.configuredPurchase).toEqual(unavailable);
});

it("R5 refuses a route whose executor was not selected", () => {
  const f = fixture(true);
  expect(() => createM12AccountSupportReferenceBinding({ ...f.options, routes: [{ id: "unselected", handle: async () => "wrong" }] })).toThrow("account_support_entry_operation_required");
});

it("R5 retains concrete commerce key/request/result correlation through readiness", async () => {
  const request = { orderId: "order-a", idempotencyKey: "original-key" }, result = { kind: "owner-start" as const, revision: 7 };
  const start = vi.fn(async (input: typeof request) => { expect(input).toBe(request); return result; });
  const f = fixture(true), binding = createM12AccountSupportReferenceBinding({ ...f.options, commerce: {
    checkoutStart: start, checkoutRecoveryPay: async (_input: { token: string }) => ({ kind: "owner-pay" as const }),
  } });
  const response = await binding.services.commerce("checkoutStart", request);
  expectTypeOf(response).toEqualTypeOf<typeof result | AccountSupportHostBindingRequired | AccountSupportBindingRefusal>();
  expect(response).toBe(result); expect(start).toHaveBeenCalledTimes(1);
  // @ts-expect-error another commerce operation's request does not fit checkoutStart
  const wrongRequest: Parameters<typeof binding.services.commerce<"checkoutStart">>[1] = { token: "not-an-order" };
  void wrongRequest;
  const file = fileURLToPath(import.meta.url);
  const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true,
    esModuleInterop: true, allowImportingTsExtensions: true, types: ["node"] });
  const source = program.getSourceFile(file)!;
  expect(ts.formatDiagnosticsWithColorAndContext([...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)], {
    getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  })).toBe("");
}, 30_000);

it("R6 selected subscription notices retain M04's message identity and replay", async () => {
  const ledger = new Map<string, TransactionalDeliveryReceipt>();
  const readReceipt = async (key: string) => ledger.get(key) ?? null;
  const store: TransactionalDeliveryReceiptStore = { readReceipt,
    async recordAccepted(input) { const receipt = { ...input, state: "accepted" as const, errorCode: null, attemptCount: 1 }; ledger.set(input.idempotencyKey, receipt); return receipt; },
    async recordFailed() { throw new Error("unexpected failure"); } };
  const deliver = vi.fn(async () => ({ deliveryReference: "captured:notice" }));
  const delivery = createTransactionalDelivery({ store, delivery: { deliver } });
  const facades = createReferenceSubscriptionFacades({ commands: { capabilities: NATIVE_SUBSCRIPTION_CAPABILITIES, apply: async () => ({ outcome: "refused", reason: "subscription_command_payment_blocked" }) },
    delivery: { ...delivery, readReceipt, bind: async descriptor => ({ recipientReference: descriptor.recipientRef, templateReference: descriptor.templateSlug }) } });
  const f = fixture(true), binding = createM12AccountSupportReferenceBinding({ ...f.options, operations: { subscriptionMessage: facades.messages.deliver }, routes: [] });
  const notice = { fact: { kind: "stock_wait_resumed" as const, factId: "fact", idempotencyKey: "wait:resumed", subscriptionId: "sub", clientId: "client", cycleId: null,
    caseId: "case", orderId: "order", occurredAt: "at", firstRecordedAt: "at", frozenFingerprint: "frozen" }, messageKey: "wait:resumed", recipientRef: "customer:1", locale: "en", recoveryUrlPath: null };
  expect(deliver).not.toHaveBeenCalled();
  expect(await binding.services.operations.subscriptionMessage(notice)).toEqual({ notificationId: "captured:notice", replayed: false });
  expect(await binding.services.operations.subscriptionMessage(notice)).toEqual({ notificationId: "captured:notice", replayed: true });
  expect(deliver).toHaveBeenCalledExactlyOnceWith({ idempotencyKey: "wait:resumed", recipientReference: "customer:1", templateReference: "subscription-stock-wait-resumed" });
  expect(binding.contributions[0]!.handlers).toEqual([]); expect(binding.contributions[0]!.schedules).toEqual([]);
});


it("R7 selected commerce effects join the existing registry without eager execution", async () => {
  const unused = vi.fn((): never => { throw new Error("unexpected_effect"); });
  const runtime: CommerceEmailRuntime = {
    parseOutboxPayload: (schema, payload) => ({ ok: true, data: schema.parse(payload) }),
    mapSendOutcome: () => ({ kind: "processed" }),
    createTransactionalEmailHandler: ({ eventType, timeoutMs }) => ({ eventType, timeoutMs, handle: unused }),
    resolveLocale: () => "fixture", formatMoney: (minor, currency) => `${currency}:${minor}`, genericItemLabel: () => "Item",
    presentPaidOrder: () => null, providerOwnsDeliveredNotification: () => false,
    normalizeCarrierKind: () => null, carrierTrackingUrl: () => null, legacyTrackingUrl: () => null,
  };
  const extra = { eventType: "fixture.account.notice", timeoutMs: 1000, handle: unused };
  const uniqueRegistry = vi.fn((handlers: Parameters<Parameters<typeof createOutboxDispatchRegistry>[0]["uniqueRegistry"]>[0]) =>
    new Map(handlers.map(handler => [handler.eventType, handler])));
  const registry = createOutboxDispatchRegistry({ uniqueRegistry, fulfillmentEnabled: false, extraHandlers: [extra],
    transactionalEmail: { runtime, recipientPort: { resolve: unused }, lifecyclePort: { read: unused }, orderPaidLinesPort: { read: unused },
      emailPort: { findExistingSend: unused, sendReturnApprovedNotice: unused, sendReturnRejectedNotice: unused,
        sendOrderConfirmation: unused, sendCheckoutRecovery: unused, sendOrderPaidConfirmation: unused,
        sendPaymentFailedNotice: unused, sendCheckoutExpiredNotice: unused, sendOrderCanceledNotice: unused,
        sendOrderRefundedNotice: unused, sendShipmentDispatchedNotice: unused, sendShipmentDeliveredNotice: unused, sendShipmentExceptionNotice: unused } } });
  const f = fixture(true), start = vi.fn(async (key: string) => ({ key }));
  const stockSchema = { version: "stock", migration: "stock", objects: [{ kind: "function" as const, name: "public.inventory_new_purchase_stock_read", signature: "text,jsonb,timestamp with time zone" }] };
  // ID-5: the real reference-source result must satisfy M12's local injection contract.
  const commerceOwner = createM11CommerceReferenceBinding({ enabled: true, executor: { query: unused }, commerce: { start },
    version: f.options.version, catalogue: f.options.catalogue, requiredObjects: stockSchema.objects,
    readiness: f.readiness, handlers: [...registry.values()], routes: [{ id: "start", handle: start }] }) satisfies M12CommerceSelection;
  const binding = createM12AccountSupportReferenceBinding({ ...f.options, commerce: { start },
    commerceOwner, commerceRegistry: registry });
  expect(binding.commerceOwner).toBe(commerceOwner);
  expect(uniqueRegistry).toHaveBeenCalledTimes(1); expect(binding.commerceRegistry).toBe(registry);
  expect(registry.get(extra.eventType)).toBe(extra);
  const descriptors = [...describeCoreOutboxHandlers({ transactionalEmail: true, fulfillmentEnabled: false }),
    { eventType: extra.eventType, timeoutMs: extra.timeoutMs }];
  expect(binding.commerceOwner!.contributions[0]!.handlers).toEqual(descriptors);
  expect(descriptors).toContainEqual(outboxCheckoutRecoveryEmailDescriptor);
  expect(binding.contributions[1]).toBe(binding.commerceOwner!.contributions[0]);
  const selected = binding.commerceOwner!.services.start;
  expect(binding.ports["@openlup/platform/commerce:start"]).toBe(selected);
  expect(binding.routes["@openlup/platform/commerce:start"]).toBe(selected);
  expect(binding.schema.objects).toEqual(m11CommerceSchema(f.options.catalogue, stockSchema.objects).objects);
  expect(f.readiness).not.toHaveBeenCalled(); expect(unused).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  const result = await binding.services.commerce("start", "original-key");
  expectTypeOf(result).toEqualTypeOf<{ key: string } | AccountSupportHostBindingRequired | AccountSupportBindingRefusal>();
  // @ts-expect-error the selected M11 start entrance still requires its own request
  const invalid: Parameters<typeof binding.services.commerce<"start">>[1] = { token: "wrong-request" };
  void invalid;
  expect(result).toEqual({ key: "original-key" });
  expect(start).toHaveBeenCalledExactlyOnceWith("original-key");
  expect(f.readiness).toHaveBeenCalledExactlyOnceWith(binding.schema);
  f.readiness.mockResolvedValue({ state: "unsatisfied", candidate, loadedPackages: [], issues: [] });
  expect(await selected("original-key")).toEqual({ kind: "refused", code: "schema_unsatisfied" });
  expect(start).toHaveBeenCalledTimes(1);
  expect(f.readiness).toHaveBeenLastCalledWith(binding.schema);
});
