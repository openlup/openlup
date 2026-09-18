import { describe, expect, it, vi } from "vitest";
import { createStarterPackCyclePort } from "../../adapters/supabase/subscription/starterPackCycle.js";
import {
  chargeSubscriptionCycleOffSession,
  type DueSubscription,
} from "./chargeSubscriptionCycleOffSession.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type { PaymentExecutionResult } from "../../../src/domains/payment/types.js";
import type { PreparedProviderAttemptRuntimePort } from "../../../src/domains/commerce/ports.js";
import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";
import { parseDeliveryAlignmentAdmissionResponse } from "./callSubscriptionDeliveryAlignmentAdmission.js";
import { createSupabaseCycleChargeFailurePropagationPort } from "../../adapters/supabase/subscription/cycleChargeFailurePropagation.js";
import { createManagedSubscriptionRenewalPersistencePort } from "../../adapters/managed/subscription/subscriptionRenewalDuePort.js";

// Every deps literal below drives the SHIPPED composition of the propagation
// port over the same fake driver the rest of the charge path uses, so the RPC
// assertions in this suite keep meaning what they meant.
const propagationOver = (client: unknown) =>
  createSupabaseCycleChargeFailurePropagationPort(client as never);

// The orchestrator now dispatches on CAPABILITIES, so the rails are stated here
// as descriptors rather than implied by a provider name in the due row. Each
// restates one published adapter descriptor; holding a descriptor to its
// adapter is the conformance matrix's job, in that adapter's own suite.
const cardRail: PaymentProviderCapabilityDescriptor = {
  providerKind: "card_rail",
  captureFlows: [{ kind: "card_on_file_setup", handoff: "embedded_client_secret" }],
  requiresStoredMandateEvidence: false,
  assessMandate: () => ({ chargeable: true }),
  unattendedChargeFlow: "off_session_payment",
  payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
  methodHealth: { requiresCustomerRef: true, requiredMethodKind: null, requiresPayerContact: false },
  mandateUpsertIsSubscriptionScoped: false,
  terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
};
const mandateRail: PaymentProviderCapabilityDescriptor = {
  providerKind: "mandate_rail",
  captureFlows: [{ kind: "scheme_alias_registration", handoff: "payer_supplied_code" }],
  requiresStoredMandateEvidence: true,
  assessMandate: (snapshot) => snapshot.recurringModel === "O"
    ? { chargeable: true }
    : { chargeable: false, blockReason: "mandate_model_unsupported_for_unattended_charge" },
  unattendedChargeFlow: "recurring_charge",
  payerContext: { requiresPayerBlock: true, customerRefFallsBackToContactEmail: true },
  methodHealth: { requiresCustomerRef: false, requiredMethodKind: "blik_payid", requiresPayerContact: true },
  mandateUpsertIsSubscriptionScoped: true,
  terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
};

const SUB_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_UUID = "00000000-0000-4000-8000-000000000aaa";
const ORDER_REF = `order_${ORDER_UUID}`;
const PAYMENT_REF = `payment_${"00000000-0000-4000-8000-000000000bbb"}`;
const CYCLE_ID = "00000000-0000-4000-8000-000000000ccc";
const INTENT_ID = "00000000-0000-4000-8000-000000000ddd";
const PAYMENT_ID = "00000000-0000-4000-8000-000000000eee";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000fff";

function due(overrides: Partial<DueSubscription> = {}): DueSubscription {
  return {
    subscriptionId: SUB_ID,
    clientId: "11111111-1111-4111-8111-111111111111",
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
  const unit = 4900, qty = 2, sub = unit * qty;
  const net = Math.round((sub * 10000) / 10800);
  return {
    sku: "VEL-LAMB-01",
    productSlug: "lamb",
    quantity: qty,
    unitPriceGross: { amountMinor: unit, currency: "PLN" },
    lineSubtotalGross: { amountMinor: sub, currency: "PLN" },
    tax: {
      included: true, country: "PL", category: "pet_food", vatRateBps: 800,
      legalBasis: "PL VAT Annex 3 item 10c",
      netAmount: { amountMinor: net, currency: "PLN" },
      vatAmount: { amountMinor: sub - net, currency: "PLN" },
      grossAmount: { amountMinor: sub, currency: "PLN" },
    },
  };
}

const templateData = () => ({
  cadence_days: 28, currency: "PLN", region_code: "PL", edit_window_hours: 72, size_constraint: {},
  lines: [{ variant_id: "v-1", qty: 2, sort_order: 0, is_addon: false }],
});

function thenable(result: { data: unknown; error: { message?: string } | null }) {
  const builder: Record<string, unknown> = {};
  for (const fn of ["select", "eq", "order", "limit"] as const) {
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

interface MakeClientOpts {
  alignmentAdmissionResponse?: { data: unknown; error: { message?: string; code?: string } | null };
  mandateConsentSnapshot?: { consent_snapshot: Record<string, unknown> } | null;
  mandateConsentError?: { message: string } | null;
  replayedCycle?: boolean;
  reservationPreflightResponse?: { data: unknown; error: { message?: string } | null };
  cycleRetryState?: { retry_attempt: number; next_retry_at: string };
  /**
   * Full `subscription_cycles` row set seen by BOTH `resolveCycleIdentity`
   * (array read for cycle_number/retry_attempt) and `readCycleRetryState`
   * (maybeSingle → first row). Rows must be ordered by cycle_number DESC to
   * mirror the real query. Overrides `cycleRetryState` when set.
   */
  cycleRows?: unknown[];
  dunningResponse?: { data: unknown; error: { message?: string; code?: string } | null };
  /** SR-1: the starter marker on the subscription, and a raising graduation. */
  starterPack?: unknown;
  graduationRpcError?: { message?: string };
}

function makeClient(opts: MakeClientOpts = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admissionCalls: Array<{ subscriptionId: string; scheduledAt: string; asOf: string }> = [];
  const client = {
    admitDeliveryAlignment: vi.fn().mockImplementation(async (input) => {
      admissionCalls.push(input);
      const response = opts.alignmentAdmissionResponse ?? {
        data: { allowed: true, state: "none", reason: "no_delay_evidence" }, error: null,
      };
      return parseDeliveryAlignmentAdmissionResponse(response.data, response.error);
    }),
    rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "subscription_current_template_snapshot") {
        return Promise.resolve({ data: templateData(), error: null });
      }
      if (name === "subscription_apply_starter_graduation") {
        return opts.graduationRpcError
          ? Promise.resolve({ data: null, error: opts.graduationRpcError })
          : Promise.resolve({ data: { starterGraduation: { applied: true } }, error: null });
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
              replayed: opts.replayedCycle ?? false,
            },
          },
          error: null,
        });
      }
      if (name === "subscription_cycle_reservation_preflight") {
        return Promise.resolve(opts.reservationPreflightResponse ?? {
          data: { ok: true, itemsChecked: 1, reacquired: 0 },
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
        return Promise.resolve(opts.dunningResponse ?? {
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
          data: [{ starter_pack: opts.starterPack ?? null, template_version: 1, cadence_days: 28 }],
          error: null,
        });
      }
      if (table === "commerce_payment_method_refs") {
        // The renewal reads the mandate's registered autopayment model so a model
        // M agreement is never charged under model O terms.
        return thenable({
          data: opts.mandateConsentSnapshot ?? null,
          error: opts.mandateConsentError ?? null,
        });
      }
      if (table === "subscription_lines") {
        return thenable({
          data: [
            {
              variant_id: "v-1",
              qty: 2,
              sort_order: 0,
              line_metadata: { productSnapshot: { sku: "S", productSlug: "p", quoteLine: quoteLine() } },
            },
          ],
          error: null,
        });
      }
      if (table === "subscription_cycles") {
        return thenable({
          data: opts.cycleRows
            ? opts.cycleRows
            : opts.cycleRetryState
              ? [opts.cycleRetryState]
              : [{ retry_attempt: 1, next_retry_at: "2026-06-10T00:00:00.000Z" }],
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
  return { client: client as never, rpcCalls, admissionCalls };
}

function makePaymentPort(
  overrides: {
    prepared?: Partial<Awaited<ReturnType<PreparedProviderAttemptRuntimePort["prepareProviderAttempt"]>>>;
    finalized?: Partial<Awaited<ReturnType<PreparedProviderAttemptRuntimePort["finalizeProviderAttempt"]>>>;
    prepareReject?: Error;
  } = {},
): PreparedProviderAttemptRuntimePort {
  return {
    createIntent: vi
      .fn()
      .mockResolvedValue({ paymentIntentId: INTENT_ID, paymentId: PAYMENT_ID, status: "created", replayed: false }),
    prepareProviderAttempt: vi.fn().mockImplementation(async () => {
      if (overrides.prepareReject) throw overrides.prepareReject;
      return {
        paymentAttemptId: ATTEMPT_ID,
        status: "created",
        replayed: false,
        providerAttemptId: null,
        providerSessionId: null,
        nextActionKind: null,
        ...overrides.prepared,
      };
    }),
    finalizeProviderAttempt: vi.fn().mockImplementation(async (input) => ({
      paymentAttemptId: ATTEMPT_ID,
      status: input.attemptStatus,
      replayed: false,
      providerAttemptId: input.providerAttemptId,
      providerSessionId: input.providerSessionId,
      nextActionKind: input.nextActionKind,
      ...overrides.finalized,
    })),
    recordAttempt: vi
      .fn()
      .mockResolvedValue({ paymentAttemptId: ATTEMPT_ID, status: "processing", replayed: false }),
    applyResult: vi.fn(),
  } as PreparedProviderAttemptRuntimePort;
}

function mockExecutionPort(result: Partial<PaymentExecutionResult> & { throws?: unknown }): PaymentExecutionPort {
  return {
    execute: vi.fn().mockImplementation(() => {
      if (result.throws !== undefined) return Promise.reject(result.throws);
      const merged: PaymentExecutionResult = {
        provider: "stripe",
        // `undefined` takes the default; an explicit `null` is a case in its own
        // right — a decline reports no provider reference at all.
        providerAttemptId: result.providerAttemptId !== undefined ? result.providerAttemptId : "pi_x",
        providerSessionId: result.providerSessionId !== undefined ? result.providerSessionId : "pi_x",
        attemptStatus: result.attemptStatus ?? "processing",
        nextActionKind: result.nextActionKind ?? null,
        clientSecret: result.clientSecret ?? null,
        webhookExpected: true,
        providerDecline: result.providerDecline ?? null,
        requestPayload: result.requestPayload ?? {},
        responsePayload: result.responsePayload ?? {},
      };
      return Promise.resolve(merged);
    }),
  };
}

/** A schema-valid starter marker whose graduation is due at cycle 3. */
function starterMarker() {
  return {
    schemaVersion: "1", starterIntervalDays: 17, basisTemplateVersion: 1,
    delivery2: { discountBps: 3500, discountMinor: 3430, basisSubtotalMinor: 9800 },
    graduation: {
      cadenceDays: 28,
      lines: [{ sku: "VEL-BEEF-01", qty: 8, sortOrder: 0, isAddon: false, quoteLine: {} }],
    },
  };
}

describe("chargeSubscriptionCycleOffSession", () => {
  // SR-1 REQ-3. Pins existing behaviour rather than changing it. The graduation
  // runs inside the snapshot build, which happens BEFORE the cycle order
  // exists, so a raise takes the whole row out before anything is written: no
  // cycle, no order, no dunning case — and `next_cycle_at` moves only when a
  // payment reaches its paid terminal, never here. The subscription therefore
  // stays due and the next tick retries the same cycle instead of skipping it.
  it("consumes nothing when a starter graduation raises, so the row stays due", async () => {
    const { client, rpcCalls } = makeClient({
      starterPack: starterMarker(),
      graduationRpcError: { message: "subscription_starter_graduation_open_cycle" },
      cycleRows: [{ cycle_number: 2 }, { cycle_number: 1 }],
    });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({});

    await expect(chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    )).rejects.toThrow(/starter_graduation_open_cycle/);

    const names = rpcCalls.map((call) => call.name);
    expect(names).toContain("subscription_apply_starter_graduation");
    expect(names).not.toContain("subscription_create_cycle_order_with_outbox");
    expect(names).not.toContain("commerce_payment_control_record_attempt");
    expect(names).not.toContain("subscription_handle_payment_failure_dunning");
  });

  it("reports outcome=failed when the provider declined inside execute()", async () => {
    // The adapter keeps `attemptStatus` non-terminal by contract, so without an
    // explicit decline branch this falls through to `charged` and a renewal that
    // collected nothing is counted — and reported by the cron — as money taken.
    const { client } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({
      attemptStatus: "processing",
      providerDecline: { code: "payment_failed", mandateUnsupported: true },
    });
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    );

    expect(result.outcome).toBe("failed");
    expect(result.outcome).not.toBe("charged");
  });

  it("a decline reported by the execution port opens dunning and closes the attempt", async () => {
    // The refusal a renewal charge actually meets: reported inside execute()
    // rather than thrown. It must reach the customer-repair path — apply_result
    // failed plus a dunning case — instead of the indeterminate branch below,
    // which applies nothing and emails nobody.
    const { client, rpcCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({
      attemptStatus: "processing",
      // The execution port reports a refusal WITHOUT a provider reference: the
      // decline was already applied here, so a handle the failure callback could
      // match on would let the same refusal be applied a second time.
      providerAttemptId: null,
      providerSessionId: null,
      providerDecline: {
        code: "card_declined",
        mandateUnsupported: false,
        declineCode: "insufficient_funds",
      },
    });

    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    );

    expect(result.outcome).toBe("failed");
    expect(result.attemptStatus).toBe("failed");
    expect(result.dunningCaseId).toBe("case-1");
    expect(result.retryAttempt).toBe(1);
    const applyResult = rpcCalls.find((c) => c.name === "commerce_payment_control_apply_result");
    expect(applyResult?.args.p_failure_reason).toBe("provider_declined");
    expect(rpcCalls.some((c) => c.name === "subscription_handle_payment_failure_dunning")).toBe(true);
    // The attempt is finalized before it is closed, and carries no provider
    // reference for the ingest matcher to find.
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ providerAttemptId: null, attemptStatus: "processing" }),
    );
  });

  it("dispatches off_session_payment and reports outcome=charged on processing", async () => {
    const { client } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ attemptStatus: "processing" });
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    );
    expect(result.outcome).toBe("charged");
    expect(result.attemptStatus).toBe("processing");
    expect(result.cycleId).toBe(CYCLE_ID);
    expect(result.orderId).toBe(ORDER_UUID);
    expect(result.paymentIntentId).toBe(INTENT_ID);
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFlow: "off_session_payment",
        customerRef: "cus_X",
        paymentMethodRef: "pm_X",
        mode: "subscription_cycle",
      }),
    );
    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: INTENT_ID,
        provider: "stripe",
        providerFlow: "off_session_payment",
        paymentMethodRef: "pm_X",
      }),
    );
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentAttemptId: ATTEMPT_ID,
        paymentIntentId: INTENT_ID,
        attemptStatus: "processing",
        providerAttemptId: "pi_x",
      }),
    );
    expect(vi.mocked(paymentPort.prepareProviderAttempt).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(port.execute).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(port.execute).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(paymentPort.finalizeProviderAttempt).mock.invocationCallOrder[0]!,
    );
  });

  it("reuses the batch admission baton without a second admission call", async () => {
    const { client, admissionCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ attemptStatus: "processing" });

    const result = await chargeSubscriptionCycleOffSession({
      persistence: createManagedSubscriptionRenewalPersistencePort(client),
      deliveryAlignment: client,
      chargeFailurePropagation: propagationOver(client),
      paymentPort,
      executionPort: port,
      capability: cardRail,
      deliveryAlignmentAdmission: { allowed: true, state: "none", reason: "on_time" },
    }, due());

    expect(result.outcome).toBe("charged");
    expect(admissionCalls).toEqual([]);
    expect(paymentPort.createIntent).toHaveBeenCalledTimes(1);
    expect(port.execute).toHaveBeenCalledTimes(1);
  });
  it("dispatches Tpay PAYID renewals as recurring_charge", async () => {
    const { client } = makeClient({ mandateConsentSnapshot: { consent_snapshot: { recurringModel: "O" } } });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ providerAttemptId: "tr_x", providerSessionId: "tr_x" });
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: mandateRail },
      due({ providerKind: "tpay", providerCustomerRef: null, providerMethodRef: "payid_X", methodKind: "blik_payid" }),
    );
    expect(result.outcome).toBe("charged");
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFlow: "recurring_charge",
        customerRef: "anna@example.com",
        paymentMethodRef: "payid_X",
        paymentMethodRecurringModel: "O",
        payer: { email: "anna@example.com", name: "Anna Nowak" },
        mode: "subscription_cycle",
      }),
    );
  });

  it.each([
    ["M", { consent_snapshot: { recurringModel: "M" } }],
    ["unknown", null],
  ] as const)("fails a Tpay %s mandate before durable provider-attempt preparation", async (_label, mandateConsentSnapshot) => {
    const { client } = makeClient({ mandateConsentSnapshot });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ providerAttemptId: "tr_x", providerSessionId: "tr_x" });

    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: mandateRail },
      due({ providerKind: "tpay", providerCustomerRef: null, providerMethodRef: "payid_X", methodKind: "blik_payid" }),
    );

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "tpay_recurring_requires_model_o",
    });
    expect(port.execute).not.toHaveBeenCalled();
    expect(paymentPort.prepareProviderAttempt).not.toHaveBeenCalled();
    expect(result.dunningCaseId).toBe("case-1");
  });

  it("surfaces a mandate-model read failure without provider execution or customer dunning", async () => {
    const { client, rpcCalls, admissionCalls } = makeClient({ mandateConsentError: { message: "db unavailable" } });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ providerAttemptId: "tr_x" });

    await expect(chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: mandateRail },
      due({ providerKind: "tpay", providerCustomerRef: null, providerMethodRef: "payid_X", methodKind: "blik_payid" }),
    )).rejects.toThrow("tpay_mandate_model_read_failed");

    expect(port.execute).not.toHaveBeenCalled();
    expect(paymentPort.prepareProviderAttempt).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(admissionCalls).toHaveLength(1);
  });

  it("dispatches the SAME due row by capability alone", async () => {
    // The de-branch in one assertion: an identical row, with no provider name
    // changed anywhere, takes the mandate rail's flow, payer block and stored
    // consent check because that is what its capability declares. Under identity
    // branching this row could only ever be an off-session card charge.
    const { client } = makeClient({ mandateConsentSnapshot: { consent_snapshot: { recurringModel: "O" } } });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ attemptStatus: "processing" });

    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: mandateRail },
      due(),
    );

    expect(result.outcome).toBe("charged");
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFlow: "recurring_charge",
        customerRef: "cus_X",
        paymentMethodRecurringModel: "O",
        payer: { email: "anna@example.com", name: "Anna Nowak" },
      }),
    );
  });

  it("reads no stored mandate evidence for a rail that does not require it", async () => {
    // The other half of the same seam: a rail that judges without local consent
    // evidence must not pay for the read, and must not send a model it never read.
    const { client } = makeClient({ mandateConsentSnapshot: { consent_snapshot: { recurringModel: "M" } } });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ attemptStatus: "processing" });

    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due({ providerKind: "tpay", providerCustomerRef: null, providerMethodRef: "payid_X", methodKind: "blik_payid" }),
    );

    expect(result.outcome).toBe("charged");
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFlow: "off_session_payment",
        paymentMethodRecurringModel: undefined,
        payer: undefined,
      }),
    );
  });

  it("fails Tpay PAYID renewals before provider execution when payer data is missing", async () => {
    const { client } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({});
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: mandateRail },
      due({ providerKind: "tpay", providerCustomerRef: null, providerMethodRef: "payid_X", methodKind: "blik_payid", payerEmail: null }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("tpay_payer_missing");
    expect(port.execute).not.toHaveBeenCalled();
  });
  it("fails closed before provider execution when the reservation preflight is blocked", async () => {
    const { client } = makeClient({
      reservationPreflightResponse: {
        data: { ok: false, reason: "reservation_preflight_blocked", detail: "inventory_insufficient", skuId: "sku-1", missingQuantity: 5 },
        error: null,
      },
    });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({});
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due({}),
    );
    // No stock means NO charge: the PSP is never called, no intent is created,
    // and the cycle stays payment_pending for the next tick to retry.
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("reservation_preflight_blocked");
    expect(result.paymentIntentId).toBeNull();
    expect(port.execute).not.toHaveBeenCalled();
    expect(paymentPort.createIntent).not.toHaveBeenCalled();
  });

  it("requires_action triggers apply_result(failed,sca) + dunning RPC", async () => {
    const { client, rpcCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ attemptStatus: "requires_action", nextActionKind: "sca_required" });
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    );
    expect(result.outcome).toBe("requires_action");
    expect(result.attemptStatus).toBe("requires_action");
    expect(result.dunningCaseId).toBe("case-1");
    expect(result.retryAttempt).toBe(1);
    const applyResult = rpcCalls.find((c) => c.name === "commerce_payment_control_apply_result");
    expect(applyResult?.args.p_failure_reason).toBe("off_session_sca_required");
    expect(rpcCalls.some((c) => c.name === "subscription_handle_payment_failure_dunning")).toBe(true);
    expect(paymentPort.finalizeProviderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attemptStatus: "requires_action", nextActionKind: "sca_required" }),
    );
  });
  it("keeps a thrown provider execution indeterminate and does not open dunning", async () => {
    const { client, rpcCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ throws: new Error("timeout_after_accept") });

    await expect(chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    )).rejects.toThrow("provider_execution_indeterminate");

    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(rpcCalls.some((c) => c.name === "commerce_payment_control_record_attempt")).toBe(false);
    expect(rpcCalls.some((c) => c.name === "commerce_payment_control_apply_result")).toBe(false);
    expect(rpcCalls.some((c) => c.name === "subscription_handle_payment_failure_dunning")).toBe(false);
  });

  it("does not call the provider again when a prepared attempt replays without provider acknowledgement", async () => {
    const { client, rpcCalls } = makeClient();
    const paymentPort = makePaymentPort({ prepared: { replayed: true, status: "created" } });
    const port = mockExecutionPort({ attemptStatus: "processing" });
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    );

    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("provider_attempt_prepared_without_provider_ack");
    expect(result.attemptStatus).toBe("created");
    expect(result.dunningCaseId).toBeNull();
    expect(port.execute).not.toHaveBeenCalled();
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    expect(rpcCalls.some((c) => c.name === "commerce_payment_control_apply_result")).toBe(false);
    expect(rpcCalls.some((c) => c.name === "subscription_handle_payment_failure_dunning")).toBe(false);
  });

  it("does not call the provider when durable attempt preparation fails", async () => {
    const { client } = makeClient();
    const paymentPort = makePaymentPort({ prepareReject: new Error("prepare_down") });
    const port = mockExecutionPort({ attemptStatus: "processing" });

    await expect(
      chargeSubscriptionCycleOffSession({ persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail }, due()),
    ).rejects.toThrow("prepare_down");

    expect(port.execute).not.toHaveBeenCalled();
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
  });

  it("classifies a cancel-or-pause admission race as a compensated skip", async () => {
    const { client } = makeClient();
    const paymentPort = makePaymentPort({
      prepareReject: Object.assign(new Error("Payment-control subscription not chargeable"), {
        details: { code: "55000", reason: "payment_control_subscription_not_chargeable" },
      }),
    });
    const port = mockExecutionPort({ attemptStatus: "processing" });

    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    );

    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "subscription_not_chargeable",
      paymentIntentId: INTENT_ID,
      attemptStatus: null,
    });
    expect(port.execute).not.toHaveBeenCalled();
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
  });

  it("replays an already-finalized processing attempt without another provider call", async () => {
    const { client } = makeClient();
    const paymentPort = makePaymentPort({
      prepared: { replayed: true, status: "processing", providerAttemptId: "pi_old" },
    });
    const port = mockExecutionPort({ attemptStatus: "processing" });
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    );

    expect(result.outcome).toBe("charged");
    expect(result.attemptStatus).toBe("processing");
    expect(result.replayed).toBe(true);
    expect(port.execute).not.toHaveBeenCalled();
    expect(paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
  });

  it("dunning RPC error is swallowed and outcome still reports failed", async () => {
    const { client } = makeClient({
      dunningResponse: { data: null, error: { code: "X", message: "dunning_invalid_input" } },
    });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({
      providerDecline: { code: "payment_failed", mandateUnsupported: false },
    });
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    );
    expect(result.outcome).toBe("failed");
    expect(result.dunningCaseId).toBeNull();
  });

  it("short-circuits to failed when the due row lacks a provider method ref", async () => {
    const { client, rpcCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({});
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due({ providerMethodRef: null }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("missing_provider_method_ref");
    expect(result.attemptStatus).toBe("failed");
    expect(port.execute).not.toHaveBeenCalled();
    expect(rpcCalls.some((c) => c.name === "commerce_payment_control_record_attempt")).toBe(true);
    expect(rpcCalls.some((c) => c.name === "subscription_handle_payment_failure_dunning")).toBe(true);
  });

  it("short-circuits revoked local payment-method refs before provider execution", async () => {
    const { client, rpcCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({});
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due({ providerMethodRef: null, methodStatus: "revoked", methodActive: false }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("payment_method_revoked");
    expect(port.execute).not.toHaveBeenCalled();
    expect(rpcCalls.some((c) => c.name === "commerce_payment_control_record_attempt")).toBe(true);
  });

  it("routes cross-client payment-method refs to operator-only preflight", async () => {
    const { client, rpcCalls, admissionCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({});
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due({ methodClientId: "other-client" }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("payment_method_cross_client");
    expect(port.execute).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(admissionCalls).toHaveLength(1);
    expect(paymentPort.createIntent).not.toHaveBeenCalled();
  });

  it("propagates cycle-order replay flag into the result", async () => {
    const { client } = makeClient({ replayedCycle: true });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ attemptStatus: "processing" });
    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    );
    expect(result.replayed).toBe(true);
  });

  it("stops before snapshots, order, intent, and dunning when delivery protection blocks admission", async () => {
    const { client, rpcCalls, admissionCalls } = makeClient({
      alignmentAdmissionResponse: {
        data: { allowed: false, state: "protected", reason: "delivery_alignment_protected" },
        error: null,
      },
    });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ attemptStatus: "processing" });
    const now = () => "2026-06-10T12:00:00.000Z";

    const result = await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail, now },
      due(),
    );

    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "delivery_alignment_protected",
      cycleId: null,
      orderId: null,
      paymentIntentId: null,
    });
    expect(rpcCalls).toEqual([]);
    expect(admissionCalls).toEqual([{
      subscriptionId: SUB_ID,
      scheduledAt: "2026-06-09T00:00:00Z",
      asOf: "2026-06-10T12:00:00.000Z",
    }]);
    expect(paymentPort.createIntent).not.toHaveBeenCalled();
    expect(paymentPort.prepareProviderAttempt).not.toHaveBeenCalled();
    expect(port.execute).not.toHaveBeenCalled();
  });

  it("fails closed when delivery admission cannot be read", async () => {
    const { client } = makeClient({
      alignmentAdmissionResponse: { data: null, error: { message: "db unavailable" } },
    });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({});

    await expect(chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due(),
    )).rejects.toThrow("subscription_delivery_alignment_admission_failed: db unavailable");
    expect(paymentPort.createIntent).not.toHaveBeenCalled();
    expect(port.execute).not.toHaveBeenCalled();
  });

  it("uses a deterministic cycle-order idempotency key derived from subscription_id + next_cycle_at", async () => {
    const { client, rpcCalls } = makeClient();
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ attemptStatus: "processing" });
    await chargeSubscriptionCycleOffSession({ persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail }, due());
    const cycleOrderCall = rpcCalls.find(
      (c) => c.name === "subscription_create_cycle_order_with_outbox",
    );
    expect(cycleOrderCall?.args.p_idempotency_key).toBe(
      `subscription:${SUB_ID}:cycle:2026-06-09T00:00:00Z`,
    );
    expect(cycleOrderCall?.args.p_cycle_number).toBe(1);
  });

  it("initial charge (no prior cycle) uses execution attempt 0", async () => {
    const { client } = makeClient({ cycleRows: [] });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ attemptStatus: "processing" });
    await chargeSubscriptionCycleOffSession({ persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail }, due());
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `subscription:${SUB_ID}:cycle:2026-06-09T00:00:00Z:payment-execution:attempt:0`,
      }),
    );
  });

  it("adds provider sequence to the execution key only after prepared/no-ack remediation", async () => {
    const DUE_AT = "2026-06-30T12:00:00Z";
    const { client } = makeClient({
      cycleRows: [
        {
          cycle_number: 2,
          scheduled_at: DUE_AT,
          retry_attempt: 1,
          provider_attempt_sequence: 1,
          next_retry_at: "2026-07-01T12:00:00.000Z",
        },
        { cycle_number: 1, scheduled_at: "2026-06-09T12:00:00Z", retry_attempt: 0 },
      ],
    });
    const paymentPort = makePaymentPort();
    const port = mockExecutionPort({ attemptStatus: "processing" });

    await chargeSubscriptionCycleOffSession(
      { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
      due({ nextCycleAt: DUE_AT }),
    );

    const idempotencyKey = `subscription:${SUB_ID}:cycle:${DUE_AT}:payment-execution:attempt:1:provider-seq:1`;
    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey }));
    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `${idempotencyKey}:prepare-attempt`,
      requestPayload: expect.objectContaining({
        retryAttempt: 1,
        providerAttemptSequence: 1,
      }),
    }));
  });

  it(
    "retry of a retry_scheduled cycle REPLAYS the cycle-order (reuses cycle_number) and charges " +
      "the re-bound card under a FRESH per-attempt key (CJ01-P)",
    async () => {
      // Clean-fixture repro: cycle 1 paid + cycle 2 retry_scheduled (the decline
      // being re-driven). The retry's due row carries the cycle's scheduled_at as
      // next_cycle_at, and the active method ref is now the re-bound card.
      const DUE_AT = "2026-06-30T12:00:00Z";
      const { client, rpcCalls } = makeClient({
        replayedCycle: true,
        cycleRows: [
          { cycle_number: 2, scheduled_at: DUE_AT, retry_attempt: 1, next_retry_at: "2026-07-01T12:00:00.000Z" },
          { cycle_number: 1, scheduled_at: "2026-06-09T12:00:00Z", retry_attempt: 0 },
        ],
      });
      const paymentPort = makePaymentPort();
      const port = mockExecutionPort({ attemptStatus: "processing" });

      const result = await chargeSubscriptionCycleOffSession(
        { persistence: createManagedSubscriptionRenewalPersistencePort(client), deliveryAlignment: client, chargeFailurePropagation: propagationOver(client), paymentPort, executionPort: port, capability: cardRail },
        due({ nextCycleAt: DUE_AT, providerMethodRef: "pm_REBOUND_CARD" }),
      );

      expect(result.outcome).toBe("charged");

      // Cycle-order REPLAYS: reuse the persisted cycle_number (2), NOT max+1 (3)
      // that recomputing would mint — the fingerprint matches so the RPC replays
      // instead of raising subscription_cycle_order_idempotency_conflict.
      const cycleOrderCall = rpcCalls.find(
        (c) => c.name === "subscription_create_cycle_order_with_outbox",
      );
      expect(cycleOrderCall?.args.p_cycle_number).toBe(2);
      expect(cycleOrderCall?.args.p_idempotency_key).toBe(`subscription:${SUB_ID}:cycle:${DUE_AT}`);

      // The charge uses a FRESH per-retry execution key (attempt:1) so Stripe
      // does not reject it as the declined attempt's key, and it charges the
      // re-bound card.
      expect(port.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `subscription:${SUB_ID}:cycle:${DUE_AT}:payment-execution:attempt:1`,
          paymentMethodRef: "pm_REBOUND_CARD",
        }),
      );
    },
  );
});
