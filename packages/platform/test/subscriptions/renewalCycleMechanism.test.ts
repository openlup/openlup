import { InventoryPersistenceError } from "../../src/inventory/index.js";
import { describe, expect, it } from "vitest";
import type { PaymentExecutionBaseInput, PaymentExecutionBaseResult, PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";
import type {
  HostedRenewalDue, RenewalCycleDeps, RenewalAttemptResult, RenewalExecutionContext,
  SubscriptionCycleSnapshotResult, SubscriptionRenewalChargeResult,
  CycleChargeFailurePropagationPort, FailurePropagationContext, CycleRetryState,
} from "../../src/subscriptions/contracts/index.js";
import { executeRenewalCycle, checkRenewalDeliveryAdmission, type RenewalCyclePolicy } from "../../src/subscriptions/renewalCycleMechanism.js";
import { recordRenewalPreflightBlock } from "../../src/subscriptions/renewalCycleRefusalMechanism.js";
import { propagateRenewalFailure, type RenewalFailurePolicy } from "../../src/subscriptions/renewalCycleFailureMechanism.js";

type Due = HostedRenewalDue & { currency: string; extension: object };
type IntentInput = { key: string; currency: string; extension: object };
type Intent = { paymentIntentId: string; replayed: boolean; ledger: object };
type Input = PaymentExecutionBaseInput & { merchantContext: object };
type Result = PaymentExecutionBaseResult & { provider: "other-result-rail"; nextActionKind: "custom-action" | null; receipt: object };
type Context = RenewalExecutionContext<Intent, undefined, "send">;

function fixture() {
  const trace: string[] = [];
  const extension = {};
  const due: Due = { subscriptionId: "sub", nextCycleAt: "scheduled", providerKind: "custom-rail", providerMethodRef: "consent", currency: "XYZ", extension };
  const snapshots: SubscriptionCycleSnapshotResult = {
    cycleNumber: 2, retryAttempt: 0, providerAttemptSequence: 0,
    templateSnapshot: {}, pricingSnapshot: {}, orderSnapshot: { total: 23 },
  };
  const order = { cycleId: "cycle", orderRef: "ref", orderUuid: "order", paymentRef: "pay", replayed: false };
  const intent: Intent = { paymentIntentId: "intent", replayed: false, ledger: {} };
  const attempt: RenewalAttemptResult<"custom-action"> = {
    paymentAttemptId: "attempt", status: "processing", replayed: false,
    providerAttemptId: null, providerSessionId: null, nextActionKind: null,
  };
  const result: Result = {
    provider: "other-result-rail", providerAttemptId: "remote", providerSessionId: null,
    attemptStatus: "processing", nextActionKind: null, receipt: {}, requestPayload: {}, responsePayload: {},
  };
  const captured: { execution?: Input; finalize?: unknown; state?: Context } = {};
  const failure: RenewalFailurePolicy = {
    resolveClassification: (supplied, reason) => supplied ?? { failureClass: reason, decidedBy: "custom" },
    recordKey: key => `${key}/record`, applyKey: key => `${key}/apply`, dunningKey: (key, n) => `${key}/dunning/${n}`,
    preparedSuffix: "/prepare", blockedSuffix: "/record", dunningFailureKey: "custom-dunning",
    logBelowRetry: () => {}, logRejected: () => {}, logUnavailable: () => {},
  };
  const failurePort: RenewalCycleDeps<IntentInput, Intent, "custom-rail", "custom-action", Input, Result, undefined>["chargeFailurePropagation"] = {
    async recordBlockedPreflightAttempt() { expect(this).toBe(failurePort); trace.push("blocked"); },
    async readDurableAttemptInstant() { expect(this).toBe(failurePort); trace.push("durable"); return "durable"; },
    async applyFailedResult() { expect(this).toBe(failurePort); trace.push("apply"); return { replayed: false }; },
    async readCycleRetryState() { expect(this).toBe(failurePort); trace.push("retry"); return { retryAttempt: 1, nextRetryAt: null, rowPresent: true }; },
    async openDunningCase() { expect(this).toBe(failurePort); trace.push("dunning"); return { status: "opened", caseId: "case" }; },
  };
  const persistence: RenewalCycleDeps<IntentInput, Intent, "custom-rail", "custom-action", Input, Result, undefined>["persistence"] = {
    async buildCycleSnapshots() { expect(this).toBe(persistence); trace.push("snapshots"); return snapshots; },
    async createCycleOrder(input) {
      expect(this).toBe(persistence);
      expect(input.templateSnapshot).toBe(snapshots.templateSnapshot);
      expect(input.pricingSnapshot).toBe(snapshots.pricingSnapshot);
      expect(input.orderSnapshot).toBe(snapshots.orderSnapshot);
      trace.push("order"); return order;
    },
    async preflightReservation() { expect(this).toBe(persistence); trace.push("stock"); return { ok: true, reason: null, itemsChecked: 1, reacquired: 0 }; },
    async readMandateRecurringModel() { throw new Error("unneeded mandate read"); },
    async noteRowOutcome() { throw new Error("host-owned outcome"); },
  };
  const payment: RenewalCycleDeps<IntentInput, Intent, "custom-rail", "custom-action", Input, Result, undefined>["paymentPort"] = {
    async createIntent(input) { expect(this).toBe(payment); expect(input.extension).toBe(extension); trace.push("intent"); return intent; },
    async prepareProviderAttempt(input) { expect(this).toBe(payment); expect(input.provider).toBe("custom-rail"); trace.push("prepare"); return attempt; },
    async finalizeProviderAttempt(input) {
      expect(this).toBe(payment); expect(input.requestPayload).toBe(result.requestPayload);
      expect(input.responsePayload).toBe(result.responsePayload);
      captured.finalize = input; trace.push("finalize"); return attempt;
    },
  };
  const execution = {
    async execute(input: Input) { expect(this).toBe(execution); captured.execution = input; trace.push("execute"); return result; },
  };
  const capability: PaymentProviderCapabilityDescriptor = {
    providerKind: "custom-rail", captureFlows: [], requiresStoredMandateEvidence: false,
    assessMandate() { expect(this).toBe(capability); trace.push("mandate"); return { chargeable: true }; },
    unattendedChargeFlow: "send", payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
    methodHealth: { requiresCustomerRef: false, requiredMethodKind: null, requiresPayerContact: false },
    terminalOutcomeReporting: { kind: "inbound_event", silenceBecomesSuspectAfterMinutes: 10 }, mandateUpsertIsSubscriptionScoped: false,
  };
  const delivery = {
    async admitDeliveryAlignment() { expect(this).toBe(delivery); trace.push("delivery"); return { allowed: true, state: "clear", reason: "custom" }; },
  };
  const deps: RenewalCycleDeps<IntentInput, Intent, "custom-rail", "custom-action", Input, Result, undefined> = {
    persistence, paymentPort: payment, executionPort: execution, capability,
    chargeFailurePropagation: failurePort, deliveryAlignment: delivery,
    now: () => { trace.push("clock"); return "now"; },
  };
  function failed(d: Due, cycleId: string | null, cycleNumber: number | null, orderId: string | null, paymentIntentId: string | null, reason: string): SubscriptionRenewalChargeResult {
    return { subscriptionId: d.subscriptionId, outcome: "failed", cycleId, cycleNumber, orderId, paymentIntentId, attemptStatus: null, replayed: false, reason };
  }
  const policy: RenewalCyclePolicy<Due, IntentInput, Intent, "custom-rail", Input, undefined, "send"> = {
    validateProvider: d => { expect(d).toBe(due); trace.push("validate"); return null; },
    readTotal: () => 23, failed, cycleKey: () => "custom-cycle", executionKey: () => "custom-execution",
    intentInput: (d, key, s, o) => {
      expect(d).toBe(due); expect(s).toBe(snapshots); expect(o).toBe(order);
      return { key, currency: d.currency, extension: d.extension };
    },
    identity: (d, _key, i, o) => {
      expect(d).toBe(due); expect(i).toBe(intent); expect(o).toBe(order);
      return { providerIdempotencyKey: "custom-key", providerRequestFingerprint: "custom-fingerprint" };
    },
    providerFlow: () => "send",
    prepareInput: (d, c) => {
      captured.state = c;
      return { idempotencyKey: `${c.executionIdempotencyKey}/prepare`, paymentIntentId: c.intent.paymentIntentId,
        provider: "custom-rail", providerIdempotencyKey: c.attemptIdentity.providerIdempotencyKey,
        providerRequestFingerprint: c.attemptIdentity.providerRequestFingerprint, providerFlow: c.providerFlow,
        paymentMethodRef: d.providerMethodRef, requestPayload: {} };
    },
    executionInput: (d, c) => ({ idempotencyKey: c.executionIdempotencyKey, paymentIntentId: c.intent.paymentIntentId,
      providerIdempotencyKey: c.attemptIdentity.providerIdempotencyKey, providerRequestFingerprint: c.attemptIdentity.providerRequestFingerprint,
      amountMinor: c.totalGrossMinor, currency: d.currency, mode: "subscription_cycle", merchantContext: d.extension }),
    isNotChargeable: () => false,
    skippedNotChargeable: (d, c) => ({ subscriptionId: d.subscriptionId, outcome: "skipped", ...c, attemptStatus: null, replayed: false }),
    finalizeKey: key => `${key}/finalize`, executionIndeterminate: () => new Error("custom-indeterminate"), defaultNow: () => "fallback",
    mandateBlockReason: "custom-mandate", invalidTotalsReason: "custom-totals", reservationBlockReason: "custom-stock",
    preflight: {
      isOperatorOnly: reason => reason === "operator", logOperatorBlock: () => { trace.push("operator"); },
      readTotal: () => 23, cycleKey: () => "custom-cycle", executionKey: () => "custom-execution",
      intentInput: (d, key) => ({ key, currency: d.currency, extension: d.extension }),
      identity: () => ({ providerIdempotencyKey: "custom-key", providerRequestFingerprint: "custom-fingerprint" }),
      normalizedProvider: provider => provider, failed, invalidTotalsReason: "custom-totals", defaultNow: () => "fallback", failure,
    },
    replay: { scaReason: "custom-auth", defaultNow: () => "fallback", failure, unacknowledgedReason: () => "custom-unacknowledged" },
    outcome: { scaReason: "custom-auth", defaultNow: () => "fallback", failure,
      declineReason: () => "custom-decline", classifyDecline: () => ({ failureClass: "custom-decline", decidedBy: "custom" }) },
  };
  return { trace, due, snapshots, order, intent, attempt, result, captured, deps, policy };
}

describe("neutral hosted cycle ordering", () => {
  it.each(["stock", "prepare"])("leaves %s busy raw before dispatch or dunning", async phase => {
    const f = fixture();
    const busy = new InventoryPersistenceError("busy", { code: "55P03", reason: "inventory_admission_busy" });
    if (phase === "stock") f.deps.persistence.preflightReservation = async () => { throw busy; };
    else f.deps.paymentPort.prepareProviderAttempt = async () => { throw busy; };
    await expect(executeRenewalCycle(f.deps, f.due, f.policy)).rejects.toBe(busy);
    expect(f.trace).not.toContain("execute");
    expect(f.trace).not.toContain("finalize");
    expect(f.trace).not.toContain("apply");
    expect(f.trace).not.toContain("dunning");
  });

  it("retries postcharge apply busy through the same prepared attempt without redispatch", async () => {
    const f = fixture();
    f.result.attemptStatus = "requires_action";
    f.attempt.status = "requires_action";
    const originalApply = f.deps.chargeFailurePropagation.applyFailedResult;
    const appliedKeys: string[] = [];
    let first = true;
    const busy = new InventoryPersistenceError("busy", { code: "55P03", reason: "inventory_lock_unavailable" });
    f.deps.chargeFailurePropagation.applyFailedResult = async input => {
      appliedKeys.push(input.idempotencyKey);
      if (first) { first = false; throw busy; }
      return originalApply.call(f.deps.chargeFailurePropagation, input);
    };
    await expect(executeRenewalCycle(f.deps, f.due, f.policy)).rejects.toBe(busy);
    expect(f.trace).not.toContain("dunning");
    f.attempt.replayed = true;
    await expect(executeRenewalCycle(f.deps, f.due, f.policy)).resolves.toMatchObject({ outcome: "requires_action", replayed: true });
    expect(f.trace.filter(phase => phase === "execute")).toHaveLength(1);
    expect(f.trace.filter(phase => phase === "finalize")).toHaveLength(1);
    expect(appliedKeys).toEqual(["custom-execution/apply", "custom-execution/apply"]);
    expect(f.captured.state?.attemptIdentity).toEqual({ providerIdempotencyKey: "custom-key", providerRequestFingerprint: "custom-fingerprint" });
  });

  it("accepts an alternate selector, distinct result provider and exact extension/reference receivers", async () => {
    const f = fixture();
    expect(await executeRenewalCycle(f.deps, f.due, f.policy)).toMatchObject({ outcome: "charged", attemptStatus: "processing" });
    expect(f.trace).toEqual(["clock", "delivery", "validate", "mandate", "snapshots", "order", "clock", "stock", "intent", "prepare", "execute", "finalize"]);
    expect(f.captured.execution?.merchantContext).toBe(f.due.extension);
    expect(f.captured.state?.intent).toBe(f.intent);
    expect(f.captured.state?.snapshots).toBe(f.snapshots);
  });

  it("also composes an execution port with only the installed core base input", async () => {
    const f = fixture();
    const baseInput: PaymentExecutionBaseInput = { idempotencyKey: "base", providerIdempotencyKey: "provider", providerRequestFingerprint: "fingerprint", paymentIntentId: "intent", amountMinor: 23, currency: "XYZ", mode: "subscription_cycle" };
    const basePolicy: RenewalCyclePolicy<Due, IntentInput, Intent, "custom-rail", PaymentExecutionBaseInput, undefined, "send"> = { ...f.policy, executionInput: () => baseInput };
    const port = { async execute(input: PaymentExecutionBaseInput) { expect(this).toBe(port); expect(input).toBe(baseInput); return f.result; } };
    expect(await executeRenewalCycle({ ...f.deps, executionPort: port }, f.due, basePolicy)).toMatchObject({ outcome: "charged" });
  });

  it("looks up execute before constructing its DTO and keeps dynamic due reads after awaits", async () => {
    const f = fixture();
    let phase = "before-order";
    Object.defineProperty(f.due, "currency", { get() { f.trace.push(`currency:${phase}`); return "XYZ"; } });
    f.deps.persistence.createCycleOrder = async () => { phase = "after-order"; return f.order; };
    const execute = f.deps.executionPort.execute;
    Object.defineProperty(f.deps.executionPort, "execute", { get() { f.trace.push("execute-lookup"); return execute; } });
    await executeRenewalCycle(f.deps, f.due, f.policy);
    expect(f.trace.filter(x => x.startsWith("currency:") || x === "execute-lookup")).toEqual(["currency:after-order", "execute-lookup", "currency:after-order"]);
  });

  it("maps execution DTO construction but leaves finalize construction and errors raw", async () => {
    const f = fixture();
    f.policy.executionInput = () => { throw new Error("construction"); };
    await expect(executeRenewalCycle(f.deps, f.due, f.policy)).rejects.toThrow("custom-indeterminate");
    expect(f.trace).not.toContain("execute"); expect(f.trace).not.toContain("finalize");
    const g = fixture(); const raw = new Error("finalize getter");
    Object.defineProperty(g.result, "providerAttemptId", { get() { throw raw; } });
    await expect(executeRenewalCycle(g.deps, g.due, g.policy)).rejects.toBe(raw);
    expect(g.trace).toContain("execute"); expect(g.trace).not.toContain("finalize");
    const h = fixture(); let calls = 0;
    h.deps.paymentPort.finalizeProviderAttempt = async () => { calls++; throw raw; };
    await expect(executeRenewalCycle(h.deps, h.due, h.policy)).rejects.toBe(raw);
    expect(calls).toBe(1);
  });

  it("exposes the complete alternate preflight chain while operator policy produces no effects or clock", async () => {
    const f = fixture();
    await recordRenewalPreflightBlock(f.deps, f.due, "repair", f.policy.preflight);
    expect(f.trace).toEqual(["snapshots", "order", "intent", "clock", "blocked", "durable", "apply", "retry", "dunning"]);
    const g = fixture();
    await recordRenewalPreflightBlock(g.deps, g.due, "operator", g.policy.preflight);
    expect(g.trace).toEqual(["operator"]);
  });

  it("replay uses the prepared failure ladder without dispatch, finalize or blocked record", async () => {
    const f = fixture(); f.attempt.replayed = true; f.attempt.status = "requires_action";
    const result = await executeRenewalCycle(f.deps, f.due, f.policy);
    expect(result).toMatchObject({ outcome: "requires_action", dunningCaseId: "case", replayed: true });
    expect("dunningPropagationFailed" in result).toBe(false);
    expect(f.trace.slice(-6)).toEqual(["prepare", "clock", "durable", "apply", "retry", "dunning"]);
    expect(f.trace).not.toContain("execute"); expect(f.trace).not.toContain("finalize"); expect(f.trace).not.toContain("blocked");
  });

  it("explicit alternate-provider refusal enters the generic ladder after one finalize", async () => {
    const f = fixture(); f.result.providerDecline = { code: "custom-decline", mandateUnsupported: false };
    await executeRenewalCycle(f.deps, f.due, f.policy);
    expect(f.trace.slice(-7)).toEqual(["execute", "finalize", "clock", "durable", "apply", "retry", "dunning"]);
    expect(f.trace.filter(x => x === "execute" || x === "finalize")).toEqual(["execute", "finalize"]);
  });

  it("returns the original admission reference and observes a supplied baton without a first clock", async () => {
    const f = fixture(); const admission = { allowed: true, state: "custom-clear", reason: "custom-reason" };
    f.deps.deliveryAlignment.admitDeliveryAlignment = async () => admission;
    expect((await checkRenewalDeliveryAdmission(f.deps.deliveryAlignment, f.due, "instant")).admitted).toBe(admission);
    f.deps.deliveryAlignmentAdmission = { ...admission, allowed: true };
    await executeRenewalCycle(f.deps, f.due, f.policy);
    expect(f.trace[0]).toBe("validate"); expect(f.trace.filter(x => x === "clock")).toHaveLength(1);
  });
});

{

function fixture() {
  const trace: string[] = [];
  const ctx: FailurePropagationContext = {
    kind: "preflight_block", executionIdempotencyKey: "custom-execution",
    providerIdempotencyKey: "custom-provider-key", providerRequestFingerprint: "custom-fingerprint",
    paymentIntentId: "intent", cycleId: "cycle", subscriptionId: "sub", orderUuid: "order",
    providerKind: "custom-rail", failureReason: "custom-reason", occurredAt: "2026-10-05T12:00:00.000Z",
  };
  const captured: { apply?: Parameters<CycleChargeFailurePropagationPort["applyFailedResult"]>[0]; dunning?: Parameters<CycleChargeFailurePropagationPort["openDunningCase"]>[0] } = {};
  const cycle: CycleRetryState = { retryAttempt: 2, nextRetryAt: null, rowPresent: true };
  const policy: RenewalFailurePolicy = {
    resolveClassification: (supplied, reason) => { trace.push("classify"); return supplied ?? { failureClass: reason, decidedBy: "custom" }; },
    recordKey: key => `${key}/record`, applyKey: key => `${key}/apply`, dunningKey: (key, n) => `${key}/dunning/${n}`,
    preparedSuffix: "/prepare", blockedSuffix: "/record", dunningFailureKey: "custom-stranded",
    logBelowRetry: () => { trace.push("below"); }, logRejected: () => { trace.push("rejected"); }, logUnavailable: () => { trace.push("unavailable"); },
  };
  const port: CycleChargeFailurePropagationPort = {
    async recordBlockedPreflightAttempt(input) { expect(this).toBe(port); expect(input.providerKind).toBe("custom-rail"); trace.push("record"); },
    async readDurableAttemptInstant() { expect(this).toBe(port); trace.push("durable"); return "2026-10-05T11:00:00.000Z"; },
    async applyFailedResult(input) { expect(this).toBe(port); captured.apply = input; trace.push("apply"); return { replayed: true }; },
    async readCycleRetryState() { expect(this).toBe(port); trace.push("retry"); return cycle; },
    async openDunningCase(input) { expect(this).toBe(port); captured.dunning = input; trace.push("dunning"); return { status: "opened", caseId: "case" }; },
  };
  return { trace, ctx, captured, cycle, policy, port };
}

describe("neutral durable renewal refusal ladder", () => {
  it("forwards original port receivers with custom namespace and durable instant, then reads classification again", async () => {
    const f = fixture();
    const first = { failureClass: "first-evidence", decidedBy: "custom" };
    const second = { failureClass: "second-evidence", decidedBy: "custom" };
    let current = first;
    Object.defineProperty(f.ctx, "failureClassification", { get() { f.trace.push("evidence"); return current; } });
    f.port.readCycleRetryState = async function () { expect(this).toBe(f.port); current = second; f.trace.push("retry"); return f.cycle; };
    expect(await propagateRenewalFailure(f.port, f.ctx, f.policy)).toEqual({ dunningCaseId: "case", retryAttempt: 2, dunningPropagationFailed: false, applyReplayed: true });
    expect(f.trace).toEqual(["record", "durable", "evidence", "classify", "apply", "retry", "evidence", "classify", "dunning"]);
    expect(f.captured.apply?.failureClassification).toBe(first);
    expect(f.captured.dunning?.failureClass).toBe(second.failureClass);
    expect(f.captured.apply?.occurredAt).toBe(f.captured.dunning?.occurredAt);
    expect(f.captured.dunning?.idempotencyKey).toBe("custom-execution/dunning/2");
  });

  it("observes key and prepared-flag changes after blocked record without snapshotting context", async () => {
    const f = fixture();
    f.port.recordBlockedPreflightAttempt = async function () {
      expect(this).toBe(f.port); f.ctx.executionIdempotencyKey = "after-record"; f.ctx.attemptAlreadyPrepared = true;
    };
    f.port.readDurableAttemptInstant = async function (input) {
      expect(this).toBe(f.port); expect(input.attemptIdempotencyKey).toBe("after-record/prepare"); return null;
    };
    await propagateRenewalFailure(f.port, f.ctx, f.policy);
    expect(f.captured.apply?.idempotencyKey).toBe("after-record/apply");
    expect(f.captured.dunning?.idempotencyKey).toBe("after-record/dunning/2");
  });

  it("does not observe the caller instant getter when a durable instant exists", async () => {
    const f = fixture(); const raw = new Error("caller clock must remain unread");
    Object.defineProperty(f.ctx, "occurredAt", { get() { throw raw; } });
    await expect(propagateRenewalFailure(f.port, f.ctx, f.policy)).resolves.toMatchObject({ dunningCaseId: "case" });
  });

  it("reads stored retry presence and nullable schedule after the second classification", async () => {
    const f = fixture();
    Object.defineProperty(f.cycle, "rowPresent", { get() { f.trace.push("row-present"); return true; } });
    Object.defineProperty(f.cycle, "nextRetryAt", { get() { f.trace.push("stored-null"); return null; } });
    await propagateRenewalFailure(f.port, f.ctx, f.policy);
    expect(f.trace.slice(-4)).toEqual(["classify", "row-present", "stored-null", "dunning"]);
    expect(f.captured.dunning?.nextRetryAt).toBeNull();
  });

  it("constructs stranded fields before the below-one decision and keeps getter errors raw", async () => {
    const f = fixture(); f.ctx.kind = "provider_declined"; f.cycle.retryAttempt = 0;
    const raw = new Error("stranded-field getter");
    Object.defineProperty(f.ctx, "subscriptionId", { get() { throw raw; } });
    await expect(propagateRenewalFailure(f.port, f.ctx, f.policy)).rejects.toBe(raw);
    expect(f.trace).not.toContain("below"); expect(f.trace).not.toContain("dunning");
  });

  it.each(["recordBlockedPreflightAttempt", "readDurableAttemptInstant", "applyFailedResult", "readCycleRetryState", "openDunningCase"] as const)("retains unexpected %s error identity over the generic port", async method => {
    const f = fixture(); const raw = new Error(method);
    f.port[method] = async () => { throw raw; };
    await expect(propagateRenewalFailure(f.port, f.ctx, f.policy)).rejects.toBe(raw);
    expect(f.trace).not.toContain("rejected"); expect(f.trace).not.toContain("unavailable");
  });

  it("keeps unprepared SCA effect-free even when every unused port property would throw", async () => {
    const f = fixture(); f.ctx.kind = "off_session_requires_action";
    Object.defineProperty(f.port, "readDurableAttemptInstant", { get() { throw new Error("unused port read"); } });
    expect(await propagateRenewalFailure(f.port, f.ctx, f.policy)).toEqual({ dunningCaseId: null, retryAttempt: null, applyReplayed: false, dunningPropagationFailed: false });
    expect(f.trace).toEqual([]);
  });
});
}
