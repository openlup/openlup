import { describe, expect, it, vi } from "vitest";

const { paymentIntentCreate, paymentIntentRetrieve, paymentIntentSearch, setupIntentCreate, payoutList, balanceTransactionList, stripeCtor } = vi.hoisted(() => {
  const paymentIntentCreate = vi.fn();
  const paymentIntentRetrieve = vi.fn();
  const paymentIntentSearch = vi.fn();
  const setupIntentCreate = vi.fn();
  const payoutList = vi.fn();
  const balanceTransactionList = vi.fn();
  const stripeCtor = vi.fn(function StripeMock(this: object) {
    Object.assign(this, {
      paymentIntents: { create: paymentIntentCreate, retrieve: paymentIntentRetrieve, search: paymentIntentSearch },
      setupIntents: { create: setupIntentCreate },
      payouts: { list: payoutList },
      balanceTransactions: { list: balanceTransactionList },
    });
  });
  return { paymentIntentCreate, paymentIntentRetrieve, paymentIntentSearch, setupIntentCreate, payoutList, balanceTransactionList, stripeCtor };
});

vi.mock("stripe", () => ({ default: stripeCtor }));

import { createStripeApiClient } from "./stripeApiClient.js";
import { normalizeStripeIntent } from "../../adapters/stripe/stripePaymentReconciliationProvider.js";

describe("createStripeApiClient", () => {
  it("forwards createPaymentIntent input + idempotencyKey and confirms the off-session branch", async () => {
    paymentIntentCreate.mockResolvedValueOnce({
      id: "pi_test_1",
      status: "requires_action",
      client_secret: "pi_test_1_secret_abc",
      customer: "cus_1",
      payment_method: "pm_1",
      latest_charge: null,
      next_action: { type: "use_stripe_sdk" },
    });

    const client = createStripeApiClient({ secretKey: "sk_test_dummy" });
    const result = await client.createPaymentIntent(
      {
        amount: 4990,
        currency: "pln",
        customer: "cus_1",
        paymentMethod: "pm_1",
        offSession: true,
        setupFutureUsage: "off_session",
        metadata: { orderRef: "order_1" },
      },
      { idempotencyKey: "openlup:stripe:order_1:pi" },
    );

    expect(paymentIntentCreate).toHaveBeenCalledWith(
      {
        amount: 4990,
        currency: "pln",
        customer: "cus_1",
        payment_method: "pm_1",
        off_session: true,
        setup_future_usage: "off_session",
        metadata: { orderRef: "order_1" },
        // Stripe rejects off_session:true without confirm:true (CJ01-N Bug A).
        confirm: true,
      },
      { idempotencyKey: "openlup:stripe:order_1:pi" },
    );
    expect(result).toEqual({
      id: "pi_test_1",
      status: "requires_action",
      client_secret: "pi_test_1_secret_abc",
      customer: "cus_1",
      payment_method: "pm_1",
      latest_charge: null,
      next_action: { type: "use_stripe_sdk" },
    });
  });

  it("pins interactive PaymentIntents to card (+ wallets) when no method is preset", async () => {
    paymentIntentCreate.mockResolvedValueOnce({
      id: "pi_element_1",
      status: "requires_payment_method",
      client_secret: "pi_element_1_secret",
      customer: "cus_3",
      payment_method: null,
      latest_charge: null,
      next_action: null,
    });

    const client = createStripeApiClient({ secretKey: "sk_test_dummy" });
    await client.createPaymentIntent(
      { amount: 53640, currency: "pln", customer: "cus_3", metadata: { orderRef: "order_2" } },
      { idempotencyKey: "openlup:stripe:order_2:pi" },
    );

    expect(paymentIntentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 53640,
        currency: "pln",
        customer: "cus_3",
        payment_method_types: ["card"],
      }),
      { idempotencyKey: "openlup:stripe:order_2:pi" },
    );
    // The FE confirms the Payment Element with the client_secret, so the server
    // MUST NOT set confirm here (CJ01-N Bug A guard).
    const elementCallArgs = paymentIntentCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(elementCallArgs).not.toHaveProperty("confirm");
  });

  it("omits payment_method_types on the off-session path (saved method present)", async () => {
    paymentIntentCreate.mockResolvedValueOnce({
      id: "pi_offsession_1",
      status: "succeeded",
      client_secret: null,
      customer: "cus_4",
      payment_method: "pm_saved",
      latest_charge: "ch_x",
      next_action: null,
    });

    const client = createStripeApiClient({ secretKey: "sk_test_dummy" });
    await client.createPaymentIntent(
      {
        amount: 53640,
        currency: "pln",
        customer: "cus_4",
        paymentMethod: "pm_saved",
        offSession: true,
        metadata: { orderRef: "order_3" },
      },
      { idempotencyKey: "openlup:stripe:order_3:pi" },
    );

    const lastCall = paymentIntentCreate.mock.calls[paymentIntentCreate.mock.calls.length - 1];
    const callArgs = lastCall?.[0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty("payment_method_types");
    expect(callArgs.payment_method).toBe("pm_saved");
    // Off-session (saved method) MUST be confirmed server-side (CJ01-N Bug A).
    expect(callArgs.off_session).toBe(true);
    expect(callArgs.confirm).toBe(true);
  });

  it("normalizes expanded customer/payment_method/latest_charge objects into string ids", async () => {
    paymentIntentCreate.mockResolvedValueOnce({
      id: "pi_test_2",
      status: "succeeded",
      client_secret: null,
      customer: { id: "cus_expanded" },
      payment_method: { id: "pm_expanded" },
      latest_charge: { id: "ch_expanded" },
      next_action: null,
    });

    const client = createStripeApiClient({ secretKey: "sk_test_dummy" });
    const result = await client.createPaymentIntent(
      { amount: 100, currency: "usd", metadata: {} },
      { idempotencyKey: "k1" },
    );

    expect(result).toMatchObject({
      customer: "cus_expanded",
      payment_method: "pm_expanded",
      latest_charge: "ch_expanded",
    });
  });

  it("forwards createSetupIntent input with off_session usage", async () => {
    setupIntentCreate.mockResolvedValueOnce({
      id: "seti_test_1",
      status: "succeeded",
      client_secret: "seti_test_1_secret_xyz",
      customer: "cus_2",
      payment_method: "pm_2",
      next_action: null,
    });

    const client = createStripeApiClient({ secretKey: "sk_test_dummy" });
    const result = await client.createSetupIntent(
      {
        customer: "cus_2",
        usage: "off_session",
        metadata: { source: "openlup" },
      },
      { idempotencyKey: "openlup:stripe:setup:1" },
    );

    expect(setupIntentCreate).toHaveBeenCalledWith(
      {
        customer: "cus_2",
        payment_method: undefined,
        usage: "off_session",
        metadata: { source: "openlup" },
      },
      { idempotencyKey: "openlup:stripe:setup:1" },
    );
    expect(result).toMatchObject({
      id: "seti_test_1",
      status: "succeeded",
      customer: "cus_2",
      payment_method: "pm_2",
      latest_charge: null,
    });
  });

  it("searches payment intents by metadata with a quoted, escaped value", async () => {
    paymentIntentSearch.mockResolvedValueOnce({ data: [{ id: "pi_found_1" }] });

    const client = createStripeApiClient({ secretKey: "sk_test_dummy" });
    const result = await client.searchPaymentIntentsByMetadata({
      key: "paymentIntentId",
      value: "22222222-2222-4222-8222-222222222222",
    });

    expect(result).toEqual({ ids: ["pi_found_1"] });
    expect(paymentIntentSearch).toHaveBeenCalledWith({
      query: "metadata['paymentIntentId']:'22222222-2222-4222-8222-222222222222'",
      limit: 1,
    });
  });

  it("escapes single quotes in search values so they cannot break the query literal", async () => {
    paymentIntentSearch.mockResolvedValueOnce({ data: [] });

    const client = createStripeApiClient({ secretKey: "sk_test_dummy" });
    await client.searchPaymentIntentsByMetadata({ key: "orderRef", value: "o'ref", limit: 5 });

    expect(paymentIntentSearch).toHaveBeenCalledWith({
      query: "metadata['orderRef']:'o\\'ref'",
      limit: 5,
    });
  });

  it("reads only completed paid payouts and maps expanded charge sources to PaymentIntent refs", async () => {
    payoutList.mockResolvedValueOnce({ data: [
      { id: "po_paid", status: "paid", reconciliation_status: "completed", arrival_date: 1_768_473_600 },
      { id: "po_in_progress", status: "paid", reconciliation_status: "in_progress", arrival_date: 1_768_473_600 },
    ] });
    balanceTransactionList.mockResolvedValueOnce({
      data: [
        {
          id: "txn_charge", amount: 10_000, fee: 290, net: 9_710, currency: "pln",
          source: { object: "charge", payment_intent: "pi_settled", amount: 10_000, currency: "pln" },
        },
        {
          id: "txn_unlinked", amount: 2_000, fee: 100, net: 1_900, currency: "pln",
          source: "ch_not_expanded",
        },
      ],
      has_more: false,
    });

    const result = await createStripeApiClient({ secretKey: "sk_test_dummy" })
      .listRecentSettledPayoutItems(25);

    expect(result).toEqual([{
      payoutId: "po_paid",
      balanceTransactionId: "txn_charge",
      providerPaymentId: "pi_settled",
      grossMinor: 10_000,
      feeMinor: 290,
      netMinor: 9_710,
      currency: "PLN",
      bankReceivedAt: "2026-01-15T10:40:00.000Z",
    }]);
    expect(payoutList).toHaveBeenCalledWith({ limit: 25, status: "paid" });
    expect(balanceTransactionList).toHaveBeenCalledWith({
      payout: "po_paid",
      type: "charge",
      limit: 100,
      expand: ["data.source"],
    });
  });

  it("does not infer order-money equality from a converted Balance Transaction", async () => {
    payoutList.mockResolvedValueOnce({ data: [
      { id: "po_fx", status: "paid", reconciliation_status: "completed", arrival_date: 1_768_473_600 },
    ] });
    balanceTransactionList.mockResolvedValueOnce({
      data: [{
        id: "txn_fx", amount: 12_345, fee: 345, net: 12_000, currency: "usd",
        source: { object: "charge", payment_intent: "pi_fx", amount: 10_000, currency: "pln" },
      }],
      has_more: false,
    });

    const result = await createStripeApiClient({ secretKey: "sk_test_dummy" })
      .listRecentSettledPayoutItems(25);

    expect(result).toEqual([]);
  });

  it("uses pinned API version and launch-safe network defaults", () => {
    stripeCtor.mockClear();

    createStripeApiClient({ secretKey: "sk_test_dummy" });

    expect(stripeCtor).toHaveBeenCalledWith(
      "sk_test_dummy",
      expect.objectContaining({
        apiVersion: "2026-07-29.dahlia",
        timeout: 10_000,
        maxNetworkRetries: 0,
      }),
    );
  });

  it("allows explicit timeout/retry overrides without changing per-request idempotency", async () => {
    stripeCtor.mockClear();
    paymentIntentCreate.mockResolvedValueOnce({
      id: "pi_override_1",
      status: "requires_payment_method",
      client_secret: "pi_override_1_secret",
      customer: null,
      payment_method: null,
      latest_charge: null,
      next_action: null,
    });

    const client = createStripeApiClient({
      secretKey: "sk_test_dummy",
      timeoutMs: 2500,
      maxNetworkRetries: 1,
    });
    await client.createPaymentIntent(
      { amount: 1000, currency: "pln", metadata: {} },
      { idempotencyKey: "openlup:stripe:override" },
    );

    expect(stripeCtor).toHaveBeenCalledWith(
      "sk_test_dummy",
      expect.objectContaining({ timeout: 2500, maxNetworkRetries: 1 }),
    );
    expect(paymentIntentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1000 }),
      { idempotencyKey: "openlup:stripe:override" },
    );
  });
});


describe("real SDK to reconciliation diagnostic continuity", () => {
  it("retains fine codes without populating the legacy classifier input", async () => {
    paymentIntentRetrieve.mockResolvedValueOnce({ id: "pi_real_shape", status: "requires_payment_method",
      amount: 4990, currency: "pln", latest_charge: "ch_current", payment_method_types: ["card"],
      last_payment_error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds",
        advice_code: "do_not_try_again", message: "private payer@example.test", charge: "ch_current" },
    });
    const intent = await createStripeApiClient({ secretKey: "sk_test_dummy" }).retrievePaymentIntent("pi_real_shape");
    expect(paymentIntentRetrieve).toHaveBeenCalledWith("pi_real_shape");
    expect(intent.last_payment_error).toEqual({ type: "card_error", code: "card_declined", message: "private payer@example.test" });
    const reconciled = normalizeStripeIntent(intent);
    expect(reconciled).toMatchObject({ status: "failed", failureReason: "stripe_card_declined",
      rawPayload: { declineCode: null, adviceCode: null, failureClass: "indeterminate", failureClassDecidedBy: "default",
        failureEvidence: { declineCode: "insufficient_funds", adviceCode: "do_not_try_again", source: "readback",
          providerPaymentId: "pi_real_shape", providerChargeId: "ch_current", methodSource: "execution_contract" },
      },
    });
    expect(JSON.stringify(reconciled)).not.toContain("payer@example.test");
  });
});


describe("SDK diagnostic method correlation", () => {
  it.each([
    [{ id: "pm_new", type: "blik" }, { id: "pm_old", type: "card" }],
    ["pm_new", { id: "pm_old", type: "card" }],
    [{ id: "pm_same", type: "blik" }, { id: "pm_same", type: "card" }],
  ])("quarantines conflicting method evidence while preserving the legacy projection", async (current, previous) => {
    paymentIntentRetrieve.mockResolvedValueOnce({ id: "pi_conflict", status: "requires_payment_method",
      latest_charge: "ch_current", payment_method: current,
      last_payment_error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds",
        advice_code: "do_not_try_again", charge: "ch_current", payment_method: previous },
    });
    const intent = await createStripeApiClient({ secretKey: "sk_test_dummy" }).retrievePaymentIntent("pi_conflict");
    expect(intent.last_payment_error).toEqual({ type: "card_error", code: "card_declined", message: null });
    expect(normalizeStripeIntent(intent)).toMatchObject({ status: "failed", failureReason: "stripe_card_declined",
      rawPayload: { declineCode: null, adviceCode: null, failureClass: "indeterminate",
        failureEvidence: { disposition: "unreadable", refusalVerified: false,
          declineCode: null, adviceCode: null, code: null, method: null, operation: null } } });
  });
});
