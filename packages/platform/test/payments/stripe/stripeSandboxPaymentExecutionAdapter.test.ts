import { describe, expect, it, vi } from "vitest";
import {
  describePaymentExecutionPortContract,
  describeUnattendedChargeConformance,
} from "./paymentExecutionPortContract.testFixtures.js";
import { unattendedChargeCapability } from "./unattendedCapability.js";
import { PAYMENT_NEXT_ACTION_KINDS } from "../../../src/payments/stripe/donorContracts.js";
import { PAYMENT_EXECUTION_ATTEMPT_STATUSES } from "@openlup/core/payment";
import { PROVIDER_DECLINE_ERROR_TYPE } from "../../../src/payments/stripe/executionDecline.js";
import {
  createStripeSandboxPaymentExecutionAdapter,
  parseStripePaymentWebhookEvent,
  type StripeSandboxClient,
} from "../../../src/payments/stripe/stripeSandboxPaymentExecutionAdapter.js";

const executionInput = {
  idempotencyKey: "checkout-1:payment-execution",
  providerIdempotencyKey: "openlup:stripe:11111111-1111-4111-8111-111111111111:checkout-1:payment-execution",
  providerRequestFingerprint: "stripe|11111111-1111-4111-8111-111111111111|4990|EUR|one_time|order_222",
  paymentIntentId: "11111111-1111-4111-8111-111111111111",
  amountMinor: 4990,
  currency: "EUR",
  mode: "one_time" as const,
  orderRef: "order_222",
};

/** The renewal charge: server-confirmed, so a refusal surfaces inside the call. */
const offSessionRenewalInput = {
  ...executionInput,
  mode: "subscription_cycle" as const,
  providerFlow: "off_session_payment" as const,
  customerRef: "cus_123",
  paymentMethodRef: "pm_123",
};

describePaymentExecutionPortContract({
  name: "stripe sandbox payment execution",
  createSubject: () => createStripeSandboxPaymentExecutionAdapter({
    client: fakeClient({
      paymentIntent: {
        id: "pi_contract",
        status: "processing",
        client_secret: "pi_contract_secret",
        latest_charge: "ch_contract",
      },
    }),
  }),
  scenarios: [{
    allowedNextActionKinds: PAYMENT_NEXT_ACTION_KINDS,
    expectedProvider: "stripe",
    input: executionInput,
    name: "normalizes one-time payment intent execution",
    sensitiveValues: ["pi_contract_secret"],
    assertResult: ({ result }) => {
      expect(result).toMatchObject({
        providerAttemptId: "pi_contract",
        providerSessionId: "pi_contract",
        attemptStatus: "processing",
        webhookExpected: true,
        clientSecret: "pi_contract_secret",
      });
    },
  }],
});

describeUnattendedChargeConformance({
  name: "off-session card charge",
  capability: unattendedChargeCapability,
  chargeInput: offSessionRenewalInput,
  createSoftDecliningPort: () => throwingAdapter(
    Object.assign(new Error("Your card was declined."), {
      type: PROVIDER_DECLINE_ERROR_TYPE,
      code: "card_declined",
      decline_code: "insufficient_funds",
      payment_intent: { id: "pi_conformance", status: "requires_payment_method" },
    }),
    "off_session_payment",
  ).adapter,
  createNonDeclineFailurePort: () => throwingAdapter(
    new Error("connection reset"),
    "off_session_payment",
  ).adapter,
  chargeableMandate: {},
  unchargeableMandate: null,
  // See executionDecline.ts: withheld on purpose until the control plane's failed
  // branch is idempotent, so a later callback cannot re-apply this refusal.
  declineCorrelation: "withheld",
});

describe("stripe sandbox payment execution adapter", () => {
  // The de-branching safety net: the WHOLE off-session renewal request, not a
  // subset. Capability-driven dispatch must leave every byte of this identical,
  // and `toEqual` on the recorded call is what proves it in seconds.
  it("pins the exact PaymentIntent request the off-session renewal path sends", async () => {
    const client = fakeClient({
      paymentIntent: { id: "pi_renewal", status: "processing", client_secret: null },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    await adapter.execute(offSessionRenewalInput);

    expect((client.createPaymentIntent as ReturnType<typeof vi.fn>).mock.calls).toEqual([[
      {
        amount: 4990,
        currency: "eur",
        customer: "cus_123",
        paymentMethod: "pm_123",
        offSession: true,
        setupFutureUsage: undefined,
        metadata: {
          source: "openlup.payment-control",
          paymentIntentId: "11111111-1111-4111-8111-111111111111",
          orderRef: "order_222",
          providerRequestFingerprint: offSessionRenewalInput.providerRequestFingerprint,
          providerFlow: "off_session_payment",
          mode: "subscription_cycle",
        },
      },
      { idempotencyKey: offSessionRenewalInput.providerIdempotencyKey },
    ]]);
  });

  it("creates a one-time PaymentIntent with deterministic provider idempotency", async () => {
    const client = fakeClient({
      paymentIntent: {
        id: "pi_123",
        status: "processing",
        client_secret: "fixture-handoff-value",
        latest_charge: "ch_123",
      },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    const result = await adapter.execute(executionInput);

    expect(client.createPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({
      amount: 4990,
      currency: "eur",
      metadata: expect.objectContaining({
        paymentIntentId: executionInput.paymentIntentId,
        providerRequestFingerprint: executionInput.providerRequestFingerprint,
      }),
    }), { idempotencyKey: executionInput.providerIdempotencyKey });
    expect(result).toMatchObject({
      provider: "stripe",
      providerAttemptId: "pi_123",
      providerSessionId: "pi_123",
      attemptStatus: "processing",
      webhookExpected: true,
      clientSecret: "fixture-handoff-value",
    });
    // The client_secret MUST live only on the top-level result (single canonical
    // exit for the provider's browser SDK). It MUST NOT appear in requestPayload or
    // responsePayload, both of which payment-control persists/logs.
    expect(JSON.stringify(result.requestPayload)).not.toContain("fixture-handoff-value");
    expect(JSON.stringify(result.responsePayload)).not.toContain("fixture-handoff-value");
    expect(result.responsePayload).toEqual({
      providerStatus: "processing",
      providerAttemptId: "pi_123",
      providerSessionIdPresent: true,
      latestChargePresent: true,
      customerRefPresent: false,
      paymentMethodRefPresent: false,
    });
  });

  it("maps off-session requires_action into recovery-required attempt facts", async () => {
    const client = fakeClient({
      paymentIntent: {
        id: "pi_requires_action",
        status: "requires_action",
        customer: "cus_123",
        payment_method: "pm_123",
        next_action: { type: "use_stripe_sdk" },
      },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client, defaultFlow: "off_session_payment" });

    const result = await adapter.execute({
      ...executionInput,
      providerFlow: "off_session_payment",
      customerRef: "cus_123",
      paymentMethodRef: "pm_123",
    });

    expect(result).toMatchObject({
      provider: "stripe",
      providerAttemptId: "pi_requires_action",
      attemptStatus: "requires_action",
      nextActionKind: "3ds_challenge",
      customerProviderRef: "cus_123",
      paymentMethodRef: "pm_123",
      recoveryRequired: true,
    });
  });

  // The interactive card rail is not confirmed by the
  // server: the adapter creates the intent and hands the client secret to the
  // browser, so the intent it returns is ALWAYS `requires_payment_method` with
  // nothing else on it. That state used to reach the durable row as
  // `processing` — a claim that money is in flight — through the mapping's
  // catch-all, and the payer was then told their payment was already being
  // processed when no issuer had been asked.
  it("records a fresh unconfirmed card intent as sent_to_provider, not as a charge in flight", async () => {
    const client = fakeClient({
      paymentIntent: {
        id: "pi_fresh",
        status: "requires_payment_method",
        client_secret: "pi_fresh_secret",
      },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    const result = await adapter.execute(executionInput);

    expect(result.attemptStatus).toBe("sent_to_provider");
    // The provider's own word stays on the row beside our reading of it, so the
    // truth is recoverable even if this mapping is ever wrong again.
    expect(result.responsePayload).toMatchObject({ providerStatus: "requires_payment_method" });
    expect(result.clientSecret).toBe("pi_fresh_secret");
  });

  // The three states that SHARE `requires_payment_method` but are not "no issuer
  // was asked". Each keeps `processing`, because in each of them a charge may
  // have moved: presence of any one of these facts is evidence an attempt
  // happened. This is the fail-closed half of the mapping and it must not drift.
  it.each([
    ["a payment method is attached and may be seconds from confirming", { payment_method: "pm_123" }],
    ["a charge exists", { latest_charge: "ch_123" }],
    ["an issuer answered with a refusal", { last_payment_error: { code: "card_declined" } }],
  ])("keeps requires_payment_method as processing when %s", async (_label, extra) => {
    const client = fakeClient({
      paymentIntent: { id: "pi_ambiguous", status: "requires_payment_method", ...extra },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    expect((await adapter.execute(executionInput)).attemptStatus).toBe("processing");
  });

  it("keeps an unrecognized provider status fail-closed as processing", async () => {
    const client = fakeClient({
      paymentIntent: { id: "pi_unknown", status: "some_status_stripe_added_later" },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    expect((await adapter.execute(executionInput)).attemptStatus).toBe("processing");
  });

  /**
   * The whole status leg of the mapping, in one table, on the path that RETURNS
   * an intent.
   *
   * The named tests above each pin one case with its full result shape, and they
   * are the right pins for the incident they came from. What they cannot state is
   * totality: before this table only two of the provider's documented statuses
   * had a pinned verdict on the returning path, and the remaining five were
   * covered solely by the catch-all — so `succeeded`, `canceled` and
   * `requires_capture` could each have been rerouted with every test still green.
   * The intents here are BARE: no charge, no method, no error, so the verdict is
   * the status's own and not the ambiguity resolution the named tests cover.
   */
  const returnedIntentVerdicts = [
    // Never confirmed by this server, so no issuer has been asked. The verdict
    // that the incident got wrong.
    ["requires_payment_method", "sent_to_provider"],
    // Both hand the payer back a step to complete, so both are one attempt
    // status; `nextActionKind` is what distinguishes them downstream.
    ["requires_confirmation", "requires_action"],
    ["requires_action", "requires_action"],
    // Genuinely in flight.
    ["processing", "processing"],
    // Authorized, captured, or cancelled AFTER a call: in all three a charge may
    // exist, and the control plane — never the adapter — makes the terminal
    // transition, so the attempt row stays non-terminal.
    ["requires_capture", "processing"],
    ["succeeded", "processing"],
    ["canceled", "processing"],
  ] as const;

  it.each(returnedIntentVerdicts)("records a bare %s intent as %s", async (status, expected) => {
    const client = fakeClient({ paymentIntent: { id: `pi_${status}`, status } });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    const result = await adapter.execute(executionInput);

    expect(result.attemptStatus).toBe(expected);
    // The provider's own word survives beside our reading of it on every row, so
    // a wrong verdict stays recoverable from the persisted payload.
    expect(result.responsePayload).toMatchObject({ providerStatus: status });
  });

  it("the table above reaches every attempt status an execution adapter may record", () => {
    // Totality in the other direction: no verdict the execution contract allows
    // is left without a provider status that demonstrably produces it. It fails
    // when the contract gains an allowed status the table cannot reach, and when
    // a row is deleted until some allowed verdict has no row left — which is how
    // coverage of the mapping erodes without any single assertion breaking.
    expect([...new Set(returnedIntentVerdicts.map(([, verdict]) => verdict))].sort())
      .toEqual([...PAYMENT_EXECUTION_ATTEMPT_STATUSES].sort());
  });

  it("forwards off_session:true to the client for the off_session_payment flow (client adds confirm — CJ01-N Bug A)", async () => {
    const client = fakeClient({
      paymentIntent: {
        id: "pi_off_session",
        status: "succeeded",
        customer: "cus_123",
        payment_method: "pm_123",
        latest_charge: "ch_123",
      },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client, defaultFlow: "off_session_payment" });

    await adapter.execute({
      ...executionInput,
      providerFlow: "off_session_payment",
      customerRef: "cus_123",
      paymentMethodRef: "pm_123",
    });

    // The adapter sets off_session:true; the real stripeApiClient derives
    // confirm:true from that flag (asserted in stripeApiClient.test.ts). Stripe
    // rejects off_session without confirm, which stranded renewals in CJ01-N.
    expect(client.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        offSession: true,
        customer: "cus_123",
        paymentMethod: "pm_123",
      }),
      { idempotencyKey: executionInput.providerIdempotencyKey },
    );
  });

  it("does NOT set off_session for the one-time payment flow (no server-side confirm)", async () => {
    const client = fakeClient({
      paymentIntent: { id: "pi_one_time", status: "processing", client_secret: "pi_one_time_secret" },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    await adapter.execute(executionInput);

    const callArgs = (client.createPaymentIntent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArgs.offSession).toBeUndefined();
  });

  it("propagates clientId + mode into provider metadata when supplied (W11.7 Wave C)", async () => {
    const client = fakeClient({
      paymentIntent: {
        id: "pi_meta",
        status: "processing",
        client_secret: "pi_meta_secret",
      },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    await adapter.execute({
      ...executionInput,
      mode: "subscription_cycle",
      clientId: "11111111-2222-4222-8222-333333333333",
    });

    expect(client.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          clientId: "11111111-2222-4222-8222-333333333333",
          mode: "subscription_cycle",
        }),
      }),
      expect.any(Object),
    );
  });

  it("ensures a provider customer for a save-for-future-use intent and attaches it", async () => {
    const client = fakeClient({
      paymentIntent: {
        id: "pi_sub",
        status: "processing",
        client_secret: "pi_sub_secret",
        customer: "cus_new",
      },
      customerId: "cus_new",
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    await adapter.execute({
      ...executionInput,
      mode: "subscription_cycle",
      clientId: "11111111-2222-4222-8222-333333333333",
      saveForFutureUse: true,
    });

    expect(client.ensureCustomer).toHaveBeenCalledWith(
      {
        clientId: "11111111-2222-4222-8222-333333333333",
        metadata: { clientId: "11111111-2222-4222-8222-333333333333" },
      },
      { idempotencyKey: "openlup:stripe:customer:11111111-2222-4222-8222-333333333333" },
    );
    expect(client.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new", setupFutureUsage: "off_session" }),
      expect.anything(),
    );
  });

  it("does not create a customer when one is already supplied", async () => {
    const client = fakeClient({
      paymentIntent: { id: "pi_x", status: "processing", client_secret: "s", customer: "cus_existing" },
      customerId: "cus_should_not_be_used",
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    await adapter.execute({ ...executionInput, customerRef: "cus_existing", saveForFutureUse: true, clientId: "abc" });

    expect(client.ensureCustomer).not.toHaveBeenCalled();
    expect(client.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
      expect.anything(),
    );
  });

  it("omits clientId from metadata when caller does not supply it", async () => {
    const client = fakeClient({
      paymentIntent: { id: "pi_no_meta", status: "processing" },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client });

    await adapter.execute(executionInput);

    const callMetadata = (client.createPaymentIntent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      ?.metadata;
    expect(callMetadata).not.toHaveProperty("clientId");
    expect(callMetadata).not.toHaveProperty("mode");
  });

  it("creates a SetupIntent for reusable payment method setup without using billing semantics", async () => {
    const client = fakeClient({
      setupIntent: {
        id: "seti_123",
        status: "succeeded",
        customer: "cus_123",
        payment_method: "pm_123",
      },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({ client, defaultFlow: "setup_reusable_method" });

    const result = await adapter.execute({
      ...executionInput,
      providerFlow: "setup_reusable_method",
      customerRef: "cus_123",
    });

    expect(client.createSetupIntent).toHaveBeenCalledWith(expect.objectContaining({
      usage: "off_session",
      customer: "cus_123",
    }), { idempotencyKey: executionInput.providerIdempotencyKey });
    expect(result).toMatchObject({
      providerAttemptId: "seti_123",
      paymentMethodRef: "pm_123",
      customerProviderRef: "cus_123",
      attemptStatus: "processing",
    });
  });

  // --- W0 decline branch (dunning-hardening PR-0b) ---------------------------
  // The provider reports an off-session issuer refusal by THROWING its refusal
  // type out of the confirm call, not by returning an intent. Until this wave
  // the adapter had no catch, so the error escaped `execute()` and the renewal
  // orchestrator recorded `provider_execution_indeterminate`: no result applied,
  // no dunning case, no customer email, a permanently stranded attempt. The
  // refusal is now normalized into the decline the orchestrator already knows
  // how to handle.
  it("normalizes a thrown issuer refusal into a providerDecline result", async () => {
    const declined = Object.assign(new Error("Your card was declined."), {
      type: PROVIDER_DECLINE_ERROR_TYPE,
      code: "card_declined",
      decline_code: "insufficient_funds",
      advice_code: "try_again_later",
      payment_intent: { id: "pi_declined", status: "requires_payment_method" },
    });
    const { adapter, client } = throwingAdapter(declined, "off_session_payment");

    const result = await adapter.execute(offSessionRenewalInput);

    expect(result.providerDecline).toEqual({
      code: "card_declined",
      mandateUnsupported: false,
      declineCode: "insufficient_funds",
      adviceCode: "try_again_later",
      neutralReasonHints: ["transient"],
    });
    // The refused intent is NOT published as a correlation handle — see the named
    // pin in executionDecline.test.ts: it would let the provider's failure
    // callback re-apply this same refusal, advancing the dunning ladder twice and
    // emailing the customer twice. It survives in responsePayload for forensics.
    expect(result.providerAttemptId).toBeNull();
    expect(result.providerSessionId).toBeNull();
    expect(result.webhookExpected).toBe(false);
    // Non-terminal by contract: only the control plane makes the terminal
    // transition, and it makes it from `providerDecline`.
    expect(result.attemptStatus).toBe("processing");
    expect(result.responsePayload.failureEvidence).toMatchObject({
      source: "execution", refusalVerified: true, providerPaymentId: "pi_declined",
      declineCode: "insufficient_funds", adviceCode: "try_again_later",
    });
    const { failureEvidence: _diagnostic, ...legacyPayload } = result.responsePayload;
    expect(legacyPayload).toEqual({
      providerStatus: "requires_payment_method",
      providerAttemptId: "pi_declined",
      providerDeclined: true,
      providerErrorCodes: ["card_declined", "insufficient_funds", "try_again_later"],
    });
    // Codes only: the provider's message is free-form and can carry
    // payer-identifying text, so it never reaches a persisted payload.
    expect(JSON.stringify(result.responsePayload)).not.toContain("Your card was declined.");
    expect(client.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("still declines when the refusal names no intent at all", async () => {
    const declined = Object.assign(new Error("Your card was declined."), {
      type: PROVIDER_DECLINE_ERROR_TYPE,
    });
    const { adapter } = throwingAdapter(declined, "off_session_payment");

    const result = await adapter.execute(offSessionRenewalInput);

    expect(result.providerDecline).toEqual({ code: "provider_declined", mandateUnsupported: false });
    expect(result.providerAttemptId).toBeNull();
    expect(result.webhookExpected).toBe(false);
    // Nothing to trace either: no intent existed to name.
    expect(result.responsePayload).toMatchObject({ providerAttemptId: null, providerStatus: null });
  });

  it("keeps a non-refusal provider error thrown, codes or not", async () => {
    // Fail closed: after an infrastructure error the charge may still have been
    // accepted, so applying a terminal failed result here would open dunning on a
    // possibly-paid cycle and eventually authorize a second charge. Shaped like a
    // transport failure — an error code and no refusal type — because a code is
    // exactly what must NOT be enough to reach the decline branch.
    const infrastructure = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const { adapter } = throwingAdapter(infrastructure, "off_session_payment");

    await expect(adapter.execute(offSessionRenewalInput)).rejects.toBe(infrastructure);
  });

  it("leaves the interactive one-time rail throwing on the same refusal", async () => {
    // That rail is confirmed by the browser, not here, so a refusal cannot reach
    // this call; leaving it untouched confines this wave's behavior change to the
    // off-session renewal rail.
    const declined = Object.assign(new Error("Your card was declined."), {
      type: PROVIDER_DECLINE_ERROR_TYPE,
      code: "card_declined",
    });
    const { adapter } = throwingAdapter(declined, "one_time_payment");

    await expect(adapter.execute(executionInput)).rejects.toBe(declined);
  });

  it("returns no providerDecline field on a successful execute", async () => {
    const client = fakeClient({
      paymentIntent: {
        id: "pi_no_decline",
        status: "processing",
        customer: "cus_123",
        payment_method: "pm_123",
      },
    });
    const adapter = createStripeSandboxPaymentExecutionAdapter({
      client,
      defaultFlow: "off_session_payment",
    });

    const result = await adapter.execute({
      ...executionInput,
      providerFlow: "off_session_payment",
      customerRef: "cus_123",
      paymentMethodRef: "pm_123",
    });

    // The decline branch the orchestrator checks (execute().providerDecline) is
    // reachable only from a refusal; a created intent never synthesizes one.
    expect(result.providerDecline).toBeUndefined();
  });

  it("parses provider webhook payloads into canonical payment events without storing raw payload", () => {
    const event = parseStripePaymentWebhookEvent({
      id: "evt_123",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_123",
          amount_received: 4990,
          currency: "eur",
          status: "succeeded",
          client_secret: "must_not_be_copied",
        },
      },
    });

    expect(event).toEqual({
      provider_event_id: "evt_123",
      event_type: "payment.succeeded",
      payment_provider_id: "pi_123",
      amount_minor: 4990,
      next_action_kind: undefined,
      raw_payload: {
        provider: "stripe",
        eventId: "evt_123",
        eventType: "payment_intent.succeeded",
        providerPaymentId: "pi_123",
        amountMinor: 4990,
        currency: "EUR",
      },
    });
    expect(JSON.stringify(event)).not.toContain("must_not_be_copied");
  });
});

/** An adapter whose provider refuses every intent creation with `error`. */
function throwingAdapter(
  error: unknown,
  defaultFlow: "one_time_payment" | "off_session_payment",
) {
  const client: StripeSandboxClient = {
    createPaymentIntent: vi.fn(async () => { throw error; }),
    createSetupIntent: vi.fn(async () => { throw new Error("unused"); }),
  };
  return { adapter: createStripeSandboxPaymentExecutionAdapter({ client, defaultFlow }), client };
}

function fakeClient(fixtures: {
  paymentIntent?: Awaited<ReturnType<StripeSandboxClient["createPaymentIntent"]>>;
  setupIntent?: Awaited<ReturnType<StripeSandboxClient["createSetupIntent"]>>;
  customerId?: string;
}): StripeSandboxClient {
  return {
    createPaymentIntent: vi.fn(async () => {
      if (!fixtures.paymentIntent) throw new Error("missing payment intent fixture");
      return fixtures.paymentIntent;
    }),
    createSetupIntent: vi.fn(async () => {
      if (!fixtures.setupIntent) throw new Error("missing setup intent fixture");
      return fixtures.setupIntent;
    }),
    ensureCustomer: vi.fn(async () => {
      if (!fixtures.customerId) throw new Error("missing customer fixture");
      return fixtures.customerId;
    }),
  };
}
