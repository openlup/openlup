import { describe, expect, it, vi } from "vitest";
import { createStarterPackCyclePort } from "../../adapters/supabase/subscription/starterPackCycle.js";
import { classifyPaymentFailure, customerCauseForFailureClass } from "@openlup/core/payment";
import type { PaymentControlRuntimePort } from "../../../src/domains/commerce/ports.js";
import { createSupabaseCycleChargeFailurePropagationPort } from "../../adapters/supabase/subscription/cycleChargeFailurePropagation.js";
import { createManagedSubscriptionRenewalPersistencePort } from "../../adapters/managed/subscription/subscriptionRenewalDuePort.js";
import type { DueSubscription } from "./chargeSubscriptionCycleOffSession.js";
import {
  isOperatorConfigPreflightReason,
  isOperatorOnlyPreflightReason,
  isPaymentMethodIntegrityPreflightReason,
  recordSubscriptionRenewalPreflightBlock,
} from "./recordSubscriptionRenewalPreflightBlock.js";
import {
  neutralHintsForPreflightReason,
  SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS,
} from "../../../src/domains/subscription/paymentMethodLifecycle.js";

const SUB_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_UUID = "00000000-0000-4000-8000-000000000aaa";
const ORDER_REF = `order_${ORDER_UUID}`;
const PAYMENT_REF = `payment_${"00000000-0000-4000-8000-000000000bbb"}`;
const CYCLE_ID = "00000000-0000-4000-8000-000000000ccc";
const INTENT_ID = "00000000-0000-4000-8000-000000000ddd";
const PAYMENT_ID = "00000000-0000-4000-8000-000000000eee";

function due(overrides: Partial<DueSubscription> = {}): DueSubscription {
  return {
    subscriptionId: SUB_ID,
    clientId: CLIENT_ID,
    nextCycleAt: "2026-06-09T00:00:00Z",
    currency: "PLN",
    providerKind: "stripe",
    providerCustomerRef: "cus_X",
    providerMethodRef: "pm_X",
    methodKind: "card",
    payerEmail: "anna@example.com",
    payerName: "Anna Nowak",
    ...overrides,
  };
}

function quoteLine() {
  const unit = 4900;
  const qty = 2;
  const sub = unit * qty;
  const net = Math.round((sub * 10000) / 10800);
  return {
    sku: "VEL-LAMB-01",
    productSlug: "lamb",
    quantity: qty,
    unitPriceGross: { amountMinor: unit, currency: "PLN" },
    lineSubtotalGross: { amountMinor: sub, currency: "PLN" },
    tax: {
      included: true,
      country: "PL",
      category: "pet_food",
      vatRateBps: 800,
      legalBasis: "PL VAT Annex 3 item 10c",
      netAmount: { amountMinor: net, currency: "PLN" },
      vatAmount: { amountMinor: sub - net, currency: "PLN" },
      grossAmount: { amountMinor: sub, currency: "PLN" },
    },
  };
}

function templateData() {
  return {
    cadence_days: 28,
    currency: "PLN",
    region_code: "PL",
    edit_window_hours: 72,
    size_constraint: {},
    lines: [{ variant_id: "v-1", qty: 2, sort_order: 0, is_addon: false }],
  };
}

function thenable(result: { data: unknown; error: { message?: string } | null }) {
  const builder: Record<string, unknown> = {};
  for (const fn of ["select", "eq", "order"] as const) {
    builder[fn] = vi.fn().mockReturnValue(builder);
  }
  builder.maybeSingle = vi.fn().mockResolvedValue(
    Array.isArray(result.data) && result.data.length > 0
      ? { data: result.data[0], error: result.error }
      : { data: result.data ?? null, error: result.error },
  );
  builder.then = (resolve: (value: typeof result) => unknown) => resolve(result);
  return builder as never;
}

function makeClient() {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "subscription_current_template_snapshot") {
        return Promise.resolve({ data: templateData(), error: null });
      }
      if (name === "subscription_create_cycle_order_with_outbox") {
        return Promise.resolve({
          data: {
            subscriptionCycleOrder: {
              cycleId: CYCLE_ID,
              orderId: ORDER_REF,
              paymentId: PAYMENT_REF,
              status: "payment_pending",
              idempotencyKey: "k",
              replayed: false,
            },
          },
          error: null,
        });
      }
      if (name === "commerce_payment_control_record_attempt") {
        return Promise.resolve({ data: {}, error: null });
      }
      if (name === "commerce_payment_control_apply_result") {
        return Promise.resolve({ data: {}, error: null });
      }
      if (name === "subscription_handle_payment_failure_dunning") {
        return Promise.resolve({
          data: { subscriptionDunning: { caseId: "case-1", status: "open" } },
          error: null,
        });
      }
      throw new Error(`unexpected rpc ${name}`);
    }),
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "subscriptions") {
        // Harness extension only: the snapshot builder reads the subscription's
        // starter-pack state. No marker, so every case here is unchanged.
        return thenable({
          data: [{ starter_pack: null, template_version: 1, cadence_days: 28 }],
          error: null,
        });
      }
      if (table === "subscription_lines") {
        return thenable({
          data: [
            {
              variant_id: "v-1",
              qty: 2,
              sort_order: 0,
              line_metadata: {
                productSnapshot: { sku: "S", productSlug: "p", quoteLine: quoteLine() },
              },
            },
          ],
          error: null,
        });
      }
      if (table === "subscription_cycles") {
        return thenable({
          data: [{ retry_attempt: 1, next_retry_at: "2026-06-10T00:00:00.000Z" }],
          error: null,
        });
      }
      throw new Error(`unexpected from ${table}`);
    }),
  };
  // The renewal snapshot builder reads starter-pack state through the neutral
  // `StarterPackCyclePort`; production composes the managed adapter onto the
  // client, so this harness does the same. No marker is present, so every
  // expectation here is unchanged.
  Object.assign(client, createStarterPackCyclePort(client as never));
  return { client: client as never, rpcCalls };
}

function makePaymentPort(): PaymentControlRuntimePort {
  return {
    createIntent: vi
      .fn()
      .mockResolvedValue({ paymentIntentId: INTENT_ID, paymentId: PAYMENT_ID, status: "created", replayed: false }),
    recordAttempt: vi.fn(),
    applyResult: vi.fn(),
  } as PaymentControlRuntimePort;
}

describe("recordSubscriptionRenewalPreflightBlock", () => {
  it("records a durable failed attempt and dunning case for customer-actionable method blocks without calling the provider", async () => {
    const { client, rpcCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const result = await recordSubscriptionRenewalPreflightBlock(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), chargeFailurePropagation: createSupabaseCycleChargeFailurePropagationPort(client as never), paymentPort, now: () => "2026-06-09T01:00:00.000Z" },
      due(),
      "missing_provider_method_ref",
    );

    expect(result).toEqual(
      expect.objectContaining({
        subscriptionId: SUB_ID,
        outcome: "failed",
        cycleId: CYCLE_ID,
        cycleNumber: 1,
        orderId: ORDER_UUID,
        paymentIntentId: INTENT_ID,
        attemptStatus: "failed",
        dunningCaseId: "case-1",
        retryAttempt: 1,
        reason: "missing_provider_method_ref",
      }),
    );
    expect(paymentPort.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "subscription_cycle",
        orderId: ORDER_UUID,
        subscriptionId: SUB_ID,
        subscriptionCycleId: CYCLE_ID,
        amountMinor: 9800,
        currency: "PLN",
      }),
    );

    const recordAttempt = rpcCalls.find((call) => call.name === "commerce_payment_control_record_attempt");
    const applyResult = rpcCalls.find((call) => call.name === "commerce_payment_control_apply_result");
    expect(recordAttempt?.args.p_request_payload).toEqual(
      expect.objectContaining({ providerFlow: "renewal_preflight" }),
    );
    expect(recordAttempt?.args.p_attempt_status).toBe("blocked_preflight");
    expect(recordAttempt?.args.p_response_payload).toEqual(
      expect.objectContaining({
        providerCall: false,
        reason: "missing_provider_method_ref",
      }),
    );
    expect(applyResult?.args.p_failure_reason).toBe("missing_provider_method_ref");
    expect(rpcCalls.some((call) => call.name === "subscription_handle_payment_failure_dunning")).toBe(true);
  });

  it("persists revoked-method preflight reasons through payment-control and dunning", async () => {
    const { client, rpcCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const result = await recordSubscriptionRenewalPreflightBlock(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), chargeFailurePropagation: createSupabaseCycleChargeFailurePropagationPort(client as never), paymentPort, now: () => "2026-06-09T01:00:00.000Z" },
      due({ providerMethodRef: null, methodStatus: "revoked", methodActive: false }),
      "payment_method_revoked",
    );

    expect(result.reason).toBe("payment_method_revoked");
    expect(rpcCalls.find((call) => call.name === "commerce_payment_control_record_attempt")?.args.p_attempt_status)
      .toBe("blocked_preflight");
    expect(rpcCalls.find((call) => call.name === "commerce_payment_control_apply_result")?.args.p_failure_reason)
      .toBe("payment_method_revoked");
    expect(rpcCalls.find((call) => call.name === "subscription_handle_payment_failure_dunning")?.args.p_failure_reason)
      .toBe("payment_method_revoked");
  });

  it("does NOT open customer dunning or create a chargeable cycle for operator/config preflight blocks", async () => {
    const { client, rpcCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await recordSubscriptionRenewalPreflightBlock(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), chargeFailurePropagation: createSupabaseCycleChargeFailurePropagationPort(client as never), paymentPort, now: () => "2026-06-09T01:00:00.000Z" },
      due(),
      "stripe_provider_not_configured",
    );
    warn.mockRestore();

    expect(result).toEqual(
      expect.objectContaining({
        subscriptionId: SUB_ID,
        outcome: "failed",
        cycleId: null,
        cycleNumber: null,
        orderId: null,
        paymentIntentId: null,
        attemptStatus: null,
        dunningCaseId: null,
        retryAttempt: null,
        reason: "stripe_provider_not_configured",
      }),
    );
    // Operator/config fault (adapter disabled) must not touch the customer:
    // no cycle order, no payment intent, no dunning, no retry burn.
    expect(paymentPort.createIntent).not.toHaveBeenCalled();
    expect(rpcCalls.some((call) => call.name === "subscription_create_cycle_order_with_outbox")).toBe(false);
    expect(rpcCalls.some((call) => call.name === "commerce_payment_control_record_attempt")).toBe(false);
    expect(rpcCalls.some((call) => call.name === "subscription_handle_payment_failure_dunning")).toBe(false);
  });

  it("keeps every operator-only reason out of cycle, intent, attempt, and dunning writes", async () => {
    const reasons = [
      "stripe_provider_not_configured",
      "tpay_provider_not_configured",
      "subscription_provider_not_supported",
      "payment_method_cross_client",
      "payment_method_unhandled_status",
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      for (const reason of reasons) {
        const { client, rpcCalls } = makeClient();
        const paymentPort = makePaymentPort();
        const result = await recordSubscriptionRenewalPreflightBlock(
          { persistence: createManagedSubscriptionRenewalPersistencePort(client), chargeFailurePropagation: createSupabaseCycleChargeFailurePropagationPort(client as never), paymentPort, now: () => "2026-06-09T01:00:00.000Z" },
          due(),
          reason,
        );

        expect(result).toEqual(expect.objectContaining({
          outcome: "failed",
          cycleId: null,
          orderId: null,
          paymentIntentId: null,
          attemptStatus: null,
          dunningCaseId: null,
          retryAttempt: null,
          reason,
        }));
        expect(paymentPort.createIntent, reason).not.toHaveBeenCalled();
        expect(rpcCalls, reason).toHaveLength(0);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe("preflight reason classification coverage", () => {
  // Drift guard: every reason in the single-source-of-truth list must be
  // classified as operator-config OR payment-method-integrity OR (by exclusion)
  // customer-actionable — and the operator-config / integrity buckets must not
  // overlap. A newly-added reason that nobody classifies would otherwise
  // silently fall through to the customer dunning path.
  const OPERATOR_CONFIG = new Set([
    "stripe_provider_not_configured",
    "tpay_provider_not_configured",
    "subscription_provider_not_supported",
  ]);
  const INTEGRITY = new Set(["payment_method_cross_client", "payment_method_unhandled_status"]);

  it("classifies every known preflight reason exactly once", () => {
    for (const reason of SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS) {
      const config = isOperatorConfigPreflightReason(reason);
      const integrity = isPaymentMethodIntegrityPreflightReason(reason);
      // operator-config and integrity are disjoint
      expect(config && integrity, reason).toBe(false);
      // operator-only is exactly config OR integrity
      expect(isOperatorOnlyPreflightReason(reason), reason).toBe(config || integrity);
    }
  });

  it("pins the operator-config and integrity buckets to the expected reasons", () => {
    const config = SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS.filter(isOperatorConfigPreflightReason);
    const integrity = SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS.filter(isPaymentMethodIntegrityPreflightReason);
    expect(new Set(config)).toEqual(OPERATOR_CONFIG);
    expect(new Set(integrity)).toEqual(INTEGRITY);
  });
});

// ---- audit scenario 4 of 2026-08-09 -----------------------------------------
//
// The audit's fourth mandatory scenario is "every PERSISTED preflight reason owes
// a neutral hint". This is the table that says what each of them classifies as.
//
// Four of the eight customer-facing reasons are classified by the kernel from the
// key alone. The other four name the mandate rail in the string, and the kernel
// refuses to guess at those — correctly, since the meaning belongs to the module
// that emits them. Wave 3g paid that debt at the owner rather than in the kernel:
// `neutralHintsForPreflightReason` publishes what each asserts, and the runtime
// derivation (`resolvedFailureClassification`) hands those hints to the
// classifier. So this table is evaluated the way the runtime evaluates it, which
// is the whole point — a hint the owner publishes but nobody passes would be
// worth nothing.
//
// Driven off SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS rather than a local
// copy, so a reason added without a decision fails here instead of quietly
// joining the silent half.
describe("neutral-hint coverage of persisted preflight reasons", () => {
  // Exactly how the runtime classifies a persisted reason it holds no other
  // evidence for. Reads as the kernel call it is, with the owner's hints beside
  // the key rather than folded into the kernel's own table.
  const classifyAsRuntimeDoes = (reason: string) => classifyPaymentFailure({
    failureReasonKey: reason,
    neutralReasonHints: neutralHintsForPreflightReason(reason),
  });

  // The rail-named rows are addressed by the shape the runtime matches on and
  // resolved back through the frozen list, the same way scenario 1 reaches its
  // reason. Spelling the vestigial prefix here would put a provider name into a
  // platform surface to say something that is not about the provider at all.
  const reasonShaped = (shape: string) => {
    const reason = SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS.find((r) => r.endsWith(shape));
    expect(reason, shape).toBeTruthy();
    return reason!;
  };

  // One row per reason. `failure_reason_key` rows are the kernel's own readings,
  // unchanged by this wave; `neutral_hint` rows are the four 3g taught, each
  // justified where the table of shapes is defined.
  const CLASSIFIED: Record<string, { failureClass: string; decidedBy: string }> = {
    missing_provider_method_ref: { failureClass: "fix_and_retry_customer_action", decidedBy: "failure_reason_key" },
    payment_method_invalid: { failureClass: "fix_and_retry_customer_action", decidedBy: "failure_reason_key" },
    payment_method_requires_action: { failureClass: "sca_required", decidedBy: "failure_reason_key" },
    payment_method_revoked: { failureClass: "hard_do_not_retry", decidedBy: "failure_reason_key" },
    // Stored consent cannot back an unattended charge, whatever the instrument.
    [reasonShaped("_requires_model_o")]: { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
    [reasonShaped("_requires_blik_payid")]: { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
    // Nothing stored / contact missing: the payer supplies data, the same remedy
    // and the same class as the generic twin one branch above each of them.
    [reasonShaped("_recurring_payid_missing")]: { failureClass: "fix_and_retry_customer_action", decidedBy: "neutral_hint" },
    [reasonShaped("_payer_missing")]: { failureClass: "fix_and_retry_customer_action", decidedBy: "neutral_hint" },
  };

  it.each(SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS)(
    "%s classifies exactly as the table says",
    (reason) => {
      expect(classifyAsRuntimeDoes(reason)).toEqual(
        CLASSIFIED[reason] ?? { failureClass: "indeterminate", decidedBy: "default" },
      );
    },
  );

  it("leaves no customer-facing reason without a cause the payer may be told", () => {
    const customerFacing = SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS
      .filter((reason) => !isOperatorOnlyPreflightReason(reason));
    const silent = customerFacing.filter(
      (reason) => classifyAsRuntimeDoes(reason).failureClass === "indeterminate",
    );

    expect(customerFacing).toHaveLength(8);
    expect(silent).toHaveLength(0);
    // The consequence, stated where it can be read: every one of them now reaches
    // the payer as a cause that earns a sentence, instead of the one cause that
    // means "add no sentence at all".
    for (const reason of customerFacing) {
      expect(
        customerCauseForFailureClass(classifyAsRuntimeDoes(reason).failureClass),
        reason,
      ).not.toBe("unknown");
    }
  });

  it("keeps the kernel's table free of the rail's own vocabulary", () => {
    // The hint is what crosses, never the string. Asked WITHOUT the owner's
    // hints, the kernel still declines to read a reason naming a scheme it does
    // not own — which is what makes the four rows above the owner's assertion
    // rather than a kernel guess.
    const railNamed = SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS
      .filter((reason) => neutralHintsForPreflightReason(reason).length > 0);

    expect(railNamed).toHaveLength(4);
    for (const reason of railNamed) {
      expect(classifyPaymentFailure({ failureReasonKey: reason }), reason)
        .toEqual({ failureClass: "indeterminate", decidedBy: "default" });
    }

    // And the owner speaks only for what it emits: a reason shaped like one of
    // these but arriving from a rail this list does not carry stays unread,
    // rather than inheriting a verdict nobody here is entitled to give.
    expect(neutralHintsForPreflightReason(`unowned${railNamed[0]}`)).toHaveLength(0);
  });

  it("owes nothing for the operator-only reasons, which never reach the classifier", () => {
    // They return before any attempt, intent or dunning write (pinned above), so
    // their class is unwritten rather than wrong. 3g did not "fix" them: a class
    // on a row that is never persisted would be a second, invisible register.
    const operatorOnly = SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS
      .filter(isOperatorOnlyPreflightReason);

    expect(operatorOnly).toHaveLength(5);
    for (const reason of operatorOnly) {
      expect(CLASSIFIED[reason], reason).toBeUndefined();
      expect(neutralHintsForPreflightReason(reason), reason).toHaveLength(0);
    }
  });
});

// ---- SR-4: the class the RUNTIME writes, per reason ------------------------
//
// The block above pins the kernel's verdict for each reason by calling the
// kernel the way the runtime does. This one pins what the runtime ACTUALLY
// sends, by driving `recordSubscriptionRenewalPreflightBlock` and reading
// `p_failure_class` off the RPC arguments. The difference matters: a derivation
// nobody hands to the write is worth nothing, and until this table existed the
// only evidence that the preflight rail classified at all was a re-derivation
// performed by the test itself.
//
// It is load-bearing because the ladder consults the class
// (`20260826180000_the_retry_ladder_consults_the_failure_class.sql`, applied on
// production). A reason added to SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS
// without a row here fails, so the class is decided when the reason is written
// rather than defaulted to whatever the kernel happens to fall through to.
describe("SR-4 failure_class written by the preflight block, per reason", () => {
  // The seven-value taxonomy the NOT VALID CHECK on
  // `commerce_payment_attempts.failure_class` enforces on every INSERT. Kept
  // here as a literal rather than imported so a widening of the TS union cannot
  // silently widen what this test accepts: the constraint is in SQL, and only a
  // migration may move it.
  const PERSISTABLE_CLASSES = new Set([
    "hard_do_not_retry",
    "mandate_dead",
    "sca_required",
    "fix_and_retry_customer_action",
    "soft_retry_delayed",
    "soft_retryable",
    "indeterminate",
  ]);

  // The rail-named rows are addressed by the SHAPE the runtime matches on and
  // resolved back through the frozen list, exactly as the block above reaches
  // them. Spelling the vestigial rail prefix here would put a provider name into
  // a platform surface in order to say something that is not about the provider.
  const reasonShaped = (shape: string) => {
    const reason = SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS.find((r) => r.endsWith(shape));
    expect(reason, shape).toBeTruthy();
    return reason!;
  };

  // One row per customer-facing reason: the class stamped on the attempt and the
  // rule that produced it. `neutral_hint` rows are the four whose reason string
  // names the mandate rail, which the kernel refuses to read on its own; their
  // meaning arrives as a hint published by the module that emits the string.
  const WRITTEN: Record<string, { failureClass: string; decidedBy: string }> = {
    // Kernel reads these four from the key alone.
    missing_provider_method_ref: { failureClass: "fix_and_retry_customer_action", decidedBy: "failure_reason_key" },
    payment_method_invalid: { failureClass: "fix_and_retry_customer_action", decidedBy: "failure_reason_key" },
    payment_method_requires_action: { failureClass: "sca_required", decidedBy: "failure_reason_key" },
    payment_method_revoked: { failureClass: "hard_do_not_retry", decidedBy: "failure_reason_key" },
    // Stored consent cannot back an unattended charge, whatever the instrument's
    // own health. THIS is the row SR-4 exists for: a mandate that can never
    // charge must not be handed the ordinary four-rung ladder.
    [reasonShaped("_requires_model_o")]: { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
    [reasonShaped("_requires_blik_payid")]: { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
    // Nothing stored / payer contact absent: the payer supplies data, which is
    // the same remedy and the same class as the generic twin beside each.
    [reasonShaped("_recurring_payid_missing")]: { failureClass: "fix_and_retry_customer_action", decidedBy: "neutral_hint" },
    [reasonShaped("_payer_missing")]: { failureClass: "fix_and_retry_customer_action", decidedBy: "neutral_hint" },
  };

  const customerFacing = SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS
    .filter((reason) => !isOperatorOnlyPreflightReason(reason));
  const operatorOnly = SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS
    .filter(isOperatorOnlyPreflightReason);

  it("has a decided row for every customer-facing reason and no row for the rest", () => {
    // The exhaustiveness half: adding a reason to the frozen list without
    // deciding its class fails here rather than at a customer's renewal.
    expect(new Set(Object.keys(WRITTEN))).toEqual(new Set(customerFacing));
  });

  it.each(customerFacing)("%s reaches the attempt and the case with its class", async (reason) => {
    const { client, rpcCalls } = makeClient();
    await recordSubscriptionRenewalPreflightBlock(
      {
        persistence: createManagedSubscriptionRenewalPersistencePort(client),
        chargeFailurePropagation: createSupabaseCycleChargeFailurePropagationPort(client as never),
        paymentPort: makePaymentPort(),
        now: () => "2026-06-09T01:00:00.000Z",
      },
      due(),
      reason,
    );

    const applyResult = rpcCalls.find((call) => call.name === "commerce_payment_control_apply_result");
    const dunning = rpcCalls.find((call) => call.name === "subscription_handle_payment_failure_dunning");
    const expected = WRITTEN[reason];

    // REQ-1: the class arrives on the call that makes the outcome terminal, not
    // on a later pass over a row that already reads as failed.
    expect(applyResult?.args.p_result_status).toBe("failed");
    expect(applyResult?.args.p_failure_class).toBe(expected.failureClass);
    expect(applyResult?.args.p_failure_class_decided_by).toBe(expected.decidedBy);
    // The case carries the same verdict as the attempt that opened it; a
    // disagreement would let the ladder and the customer's cause sentence be
    // read from two different classes.
    expect(dunning?.args.p_failure_class).toBe(expected.failureClass);
    // Nothing outside the taxonomy may be sent: the CHECK raises at write time,
    // on the money path.
    expect(PERSISTABLE_CLASSES.has(String(applyResult?.args.p_failure_class))).toBe(true);
  });

  it("never leaves a persisted preflight attempt unclassified", async () => {
    // The defect SR-4 names, stated as its own assertion: no customer-facing
    // reason may send NULL. `mandate_dead` in particular must be produced for
    // the model-O mandate, since an unclassified refusal enters the ladder as an
    // ordinary one and burns four attempts that cannot succeed.
    for (const reason of customerFacing) {
      const { client, rpcCalls } = makeClient();
      await recordSubscriptionRenewalPreflightBlock(
        {
          persistence: createManagedSubscriptionRenewalPersistencePort(client),
          chargeFailurePropagation: createSupabaseCycleChargeFailurePropagationPort(client as never),
          paymentPort: makePaymentPort(),
          now: () => "2026-06-09T01:00:00.000Z",
        },
        due(),
        reason,
      );
      const applyResult = rpcCalls.find((call) => call.name === "commerce_payment_control_apply_result");
      expect(applyResult?.args.p_failure_class, reason).not.toBeNull();
      expect(applyResult?.args.p_failure_class, reason).toBeDefined();
    }
  });

  it("records the operator-only abstention as telemetry and writes no row for it", async () => {
    // REQ-3: the branch keeps skipping customer dunning, so there is no row to
    // classify and none is written. What this pins is the abstention itself —
    // zero RPC calls — because the value of the branch is what it does NOT
    // persist. The verdict for all five reasons is `indeterminate` (they say the
    // adapter is disabled or local evidence is unreadable, neither of which is a
    // statement about the payer's instrument), and deriving it only to log it
    // would compute a constant on a path that stores nothing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const reason of operatorOnly) {
        warn.mockClear();
        const { client, rpcCalls } = makeClient();
        await recordSubscriptionRenewalPreflightBlock(
          {
            persistence: createManagedSubscriptionRenewalPersistencePort(client),
            chargeFailurePropagation: createSupabaseCycleChargeFailurePropagationPort(client as never),
            paymentPort: makePaymentPort(),
            now: () => "2026-06-09T01:00:00.000Z",
          },
          due(),
          reason,
        );
        expect(rpcCalls, reason).toHaveLength(0);
        expect(warn, reason).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ reason }),
        );
      }
    } finally {
      warn.mockRestore();
    }
  });
});
