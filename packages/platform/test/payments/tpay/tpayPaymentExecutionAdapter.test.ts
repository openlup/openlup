import { describe, expect, it, vi } from "vitest";

import {
  describePaymentExecutionPortContract,
  describeUnattendedChargeConformance,
} from "./paymentExecutionPortContract.testFixtures.js";
import { unattendedChargeCapability } from "./unattendedCapability.js";
import { PAYMENT_NEXT_ACTION_KINDS } from "../../../src/payments/tpay/donorContracts.js";
import { createTpayPaymentExecutionAdapter, TpayExecutionInputError } from "../../../src/payments/tpay/tpayPaymentExecutionAdapter.js";
import { normalizeTpayTransaction } from "../../../src/payments/tpay/tpayPaymentReconciliationProvider.js";
import { classifyDecline } from "../../../src/payments/tpay/classifyDecline.js";
import type { TpayHttpClient } from "../../../src/payments/tpay/tpayHttpClient.js";
import { TpayTransactionDispatchError } from "../../../src/payments/tpay/tpayDispatchFailure.js";

const baseInput = {
  idempotencyKey: "checkout:payment-execution",
  providerIdempotencyKey: "openlup:tpay:payment-intent:checkout",
  providerRequestFingerprint: "tpay|payment-intent|4990|PLN|one_time|order_123",
  paymentIntentId: "11111111-1111-4111-8111-111111111111",
  amountMinor: 4990,
  currency: "PLN",
  mode: "one_time" as const,
  orderRef: "order_123",
  customerRef: "anna@example.com",
};

describePaymentExecutionPortContract({
  name: "tpay HTTP payment execution",
  createSubject: () => createTpayPaymentExecutionAdapter({
    client: fakeClient(),
    notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
    successUrl: "https://example.test/success",
    errorUrl: "https://example.test/error",
  }),
  scenarios: [{
    allowedNextActionKinds: PAYMENT_NEXT_ACTION_KINDS,
    expectedProvider: "tpay",
    input: {
      ...baseInput,
      providerFlow: "blik_one_time",
      transientProviderInput: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
    },
    name: "normalizes BLIK HTTP execution",
    sensitiveValues: ["123456"],
    assertResult: ({ result }) => {
      expect(result).toMatchObject({
        providerAttemptId: "TR-123",
        providerSessionId: "01HX",
        attemptStatus: "processing",
        webhookExpected: true,
      });
    },
  }],
});

describeUnattendedChargeConformance({
  name: "recurring mandate charge",
  capability: unattendedChargeCapability,
  // Neutral construction values on purpose: the conformance kit must read the
  // same for any provider, so nothing here carries deployment vocabulary.
  chargeInput: {
    ...baseInput,
    mode: "subscription_cycle" as const,
    paymentMethodRef: "stored_mandate_1",
    paymentMethodAliasType: "PAYID" as const,
    paymentMethodRecurringModel: "O" as const,
  },
  createSoftDecliningPort: () => conformanceAdapter(
    conformanceClient([{ errorCode: "103", errorMessage: "Brak srodkow", fieldName: null }]),
  ),
  createNonDeclineFailurePort: () => conformanceAdapter(
    conformanceClient(new Error("connection reset")),
  ),
  chargeableMandate: { recurringModel: "O" },
  // Model M and unknown are the same answer: not chargeable unattended.
  unchargeableMandate: { recurringModel: "M" },
  // This rail keeps the provider handles it already received; unlike the card
  // rail it has no refused-intent id to withhold.
  declineCorrelation: "published",
});

function conformanceAdapter(client: ReturnType<typeof fakeClient>) {
  return createTpayPaymentExecutionAdapter({
    client,
    notificationUrl: "https://conformance.test/hook",
    successUrl: "https://conformance.test/ok",
    errorUrl: "https://conformance.test/err",
  });
}

/** A client that refuses with `outcome` codes, or fails outright when given an error. */
function conformanceClient(
  outcome: { errorCode: string; errorMessage: string; fieldName: null }[] | Error,
): ReturnType<typeof fakeClient> {
  return {
    createTransaction: vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return {
        transactionId: "01HX",
        title: "TR-123",
        status: "pending",
        transactionPaymentUrl: null,
        requestId: "req-1",
        payIdEligible: null,
        errors: outcome,
      };
    }),
    getTransaction: vi.fn(),
    listPaymentChannels: vi.fn(),
  } as unknown as ReturnType<typeof fakeClient>;
}

describe("Tpay payment execution adapter", () => {
  it("creates BLIK Level 0 attempts without returning or persisting the BLIK token", async () => {
    const client = fakeClient();
    const adapter = createTpayPaymentExecutionAdapter({
      client,
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
    });

    const result = await adapter.execute({
      ...baseInput,
      providerFlow: "blik_one_time",
      transientProviderInput: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
    });

    expect(client.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      amount: 49.9,
      hiddenDescription: baseInput.paymentIntentId,
      groupId: 150,
      blikToken: "123456",
    }));
    expect(result).toMatchObject({
      provider: "tpay",
      providerAttemptId: "TR-123",
      providerSessionId: "01HX",
      attemptStatus: "processing",
      webhookExpected: true,
    });
    expect(JSON.stringify(result)).not.toContain("123456");
  });

  it("preserves only typed facts when Tpay proves transaction dispatch never started", async () => {
    const client = fakeClient();
    client.createTransaction = vi.fn().mockRejectedValue(new TpayTransactionDispatchError({
      phase: "oauth",
      code: "tpay_oauth_failed",
      dispatchState: "not_dispatched",
    }));
    const adapter = conformanceAdapter(client);

    await expect(adapter.execute({
      ...baseInput,
      providerFlow: "blik_one_time",
      transientProviderInput: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
    })).rejects.toMatchObject({
      name: "ProviderAttemptPreDispatchError",
      phase: "oauth",
      code: "tpay_oauth_failed",
      dispatchState: "not_dispatched",
      paymentAttemptId: null,
    });
  });

  it("can request BLIK alias registration on code payments without logging the alias UID", async () => {
    const client = fakeClient();
    const adapter = createTpayPaymentExecutionAdapter({
      client,
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
      aliasRegistrationOnCodeEnabled: true,
    });

    const result = await adapter.execute({
      ...baseInput,
      providerFlow: "blik_one_time",
      transientProviderInput: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
    });

    expect(client.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      alias: {
        value: `openlup_${baseInput.paymentIntentId}`,
        type: "UID",
        label: "openlup",
      },
    }));
    expect(result.requestPayload).toMatchObject({
      providerFlow: "blik_one_time",
      aliasRegistrationRequested: true,
    });
    expect(JSON.stringify(result)).not.toContain("123456");
    expect(JSON.stringify(result)).not.toContain(`openlup_${baseInput.paymentIntentId}`);
  });

  it("charges BLIK without code through PAYID alias when one-click is enabled", async () => {
    const client = fakeClient();
    const adapter = createTpayPaymentExecutionAdapter({
      client,
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
      oneClickEnabled: true,
    });

    const result = await adapter.execute({
      ...baseInput,
      providerFlow: "blik_one_click",
      transientProviderInput: { provider: "tpay", flow: "blik_one_click" },
      paymentMethodRef: "payid_123",
      paymentMethodAliasType: "PAYID",
    });

    expect(client.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 150,
      blikPaymentType: 2,
      blikToken: undefined,
      alias: { value: "payid_123", type: "PAYID" },
    }));
    expect(result.requestPayload).toMatchObject({
      providerFlow: "blik_one_click",
      methodRefPresent: true,
      methodRefAliasType: "PAYID",
    });
    expect(JSON.stringify(result)).not.toContain("payid_123");
  });

  it("charges BLIK One Click UID aliases without recurring PAYID type marker", async () => {
    const client = fakeClient();
    const adapter = createTpayPaymentExecutionAdapter({
      client,
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
      oneClickEnabled: true,
    });

    const result = await adapter.execute({
      ...baseInput,
      providerFlow: "blik_one_click",
      transientProviderInput: { provider: "tpay", flow: "blik_one_click" },
      paymentMethodRef: `openlup_${baseInput.paymentIntentId}`,
      paymentMethodAliasType: "UID",
    });

    expect(client.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 150,
      blikPaymentType: undefined,
      blikToken: undefined,
      alias: { value: `openlup_${baseInput.paymentIntentId}`, type: "UID" },
    }));
    expect(result.requestPayload).toMatchObject({
      providerFlow: "blik_one_click",
      methodRefPresent: true,
      methodRefAliasType: "UID",
    });
    expect(JSON.stringify(result)).not.toContain(`openlup_${baseInput.paymentIntentId}`);
  });

  it("uses PBL channel id and returns a redirect next action", async () => {
    const client = fakeClient();
    const adapter = createTpayPaymentExecutionAdapter({
      client,
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
    });

    const result = await adapter.execute({
      ...baseInput,
      providerFlow: "pbl_one_time",
      transientProviderInput: { provider: "tpay", flow: "pbl_one_time", channelId: "21" },
    });

    expect(client.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "21",
      groupId: undefined,
    }));
    expect(result.nextActionKind).toBe("redirect");
    expect(result.redirectUrl).toBe("https://secure.tpay.com/tx");
  });

  it("fails closed without transient Tpay input or unsupported currency", async () => {
    const adapter = createTpayPaymentExecutionAdapter({
      client: fakeClient(),
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
    });

    await expect(adapter.execute(baseInput)).rejects.toBeInstanceOf(TpayExecutionInputError);
    await expect(adapter.execute({
      ...baseInput,
      currency: "EUR",
      transientProviderInput: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
    })).rejects.toMatchObject({ message: "tpay_currency_not_supported" });
  });

  it("fails closed on mismatched or unsupported Tpay flows before provider calls", async () => {
    const client = fakeClient();
    const adapter = createTpayPaymentExecutionAdapter({
      client,
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
    });

    await expect(adapter.execute({
      ...baseInput,
      providerFlow: "blik_one_time",
      transientProviderInput: { provider: "tpay", flow: "pbl_one_time", channelId: "21" },
    })).rejects.toMatchObject({ message: "tpay_provider_flow_mismatch" });

    await expect(adapter.execute({
      ...baseInput,
      mode: "subscription_cycle",
      providerFlow: "pbl_one_time",
      transientProviderInput: { provider: "tpay", flow: "pbl_one_time", channelId: "21" },
    })).rejects.toMatchObject({ message: "tpay_pbl_recurring_not_supported" });

    await expect(adapter.execute({
      ...baseInput,
      providerFlow: "blik_one_click",
      transientProviderInput: { provider: "tpay", flow: "blik_one_click" },
      paymentMethodRef: "payid_123",
    })).rejects.toMatchObject({ message: "tpay_blik_one_click_not_enabled" });

    await expect(adapter.execute({
      ...baseInput,
      mode: "subscription_cycle",
      providerFlow: "recurring_charge",
      transientProviderInput: { provider: "tpay", flow: "recurring_charge" },
      paymentMethodAliasType: "UID",
      paymentMethodRef: "uid_123",
    })).rejects.toMatchObject({ message: "tpay_recurring_charge_requires_payid" });

    expect(client.createTransaction).not.toHaveBeenCalled();
  });

  it("creates BLIK recurring activation only for subscription cycles with reusable consent", async () => {
    const client = fakeClient();
    const adapter = createTpayPaymentExecutionAdapter({
      client,
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
      modelOActivationEnabled: true,
    });

    const result = await adapter.execute({
      ...baseInput,
      mode: "subscription_cycle",
      saveForFutureUse: true,
      providerFlow: "blik_recurring_activation",
      transientProviderInput: {
        provider: "tpay",
        flow: "blik_recurring_activation",
        blikToken: "777777",
        recurringModel: "O",
      },
    });

    expect(client.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 150,
      blikToken: "777777",
      refuseNoPayId: true,
      alias: expect.objectContaining({
        value: `openlup_${baseInput.paymentIntentId}`,
        type: "PAYID",
        label: "openlup",
        autopayment: { model: "O" },
        recommendedAuthLevel: "NOCONFREQ",
      }),
    }));
    expect(result.paymentMethodRef).toBe(`openlup_${baseInput.paymentIntentId}`);
    expect(result.requestPayload).toMatchObject({
      providerFlow: "blik_recurring_activation",
      recurringModel: "O",
    });
    expect(JSON.stringify(result)).not.toContain("777777");
  });

  it("rejects BLIK recurring activation outside Model B subscription setup", async () => {
    const client = fakeClient();
    const adapter = createTpayPaymentExecutionAdapter({
      client,
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
      modelOActivationEnabled: true,
    });
    const transientProviderInput = {
      provider: "tpay" as const,
      flow: "blik_recurring_activation" as const,
      blikToken: "777777",
      recurringModel: "O" as const,
    };

    await expect(adapter.execute({
      ...baseInput,
      providerFlow: "blik_recurring_activation",
      transientProviderInput,
    })).rejects.toMatchObject({
      message: "tpay_blik_recurring_activation_requires_subscription_cycle",
    });

    await expect(adapter.execute({
      ...baseInput,
      mode: "subscription_cycle",
      providerFlow: "blik_recurring_activation",
      transientProviderInput,
    })).rejects.toMatchObject({
      message: "tpay_blik_recurring_activation_requires_save_for_future_use",
    });

    expect(client.createTransaction).not.toHaveBeenCalled();
  });

  it("fails closed on BLIK Model O unless explicitly approved", async () => {
    const client = fakeClient();
    const adapter = createTpayPaymentExecutionAdapter({
      client,
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
    });

    await expect(adapter.execute({
      ...baseInput,
      mode: "subscription_cycle",
      saveForFutureUse: true,
      providerFlow: "blik_recurring_activation",
      transientProviderInput: {
        provider: "tpay",
        flow: "blik_recurring_activation",
        blikToken: "777777",
        recurringModel: "O",
      },
    })).rejects.toMatchObject({ message: "tpay_blik_recurring_activation_not_enabled" });

    expect(client.createTransaction).not.toHaveBeenCalled();
  });

  it.each(["M", undefined] as const)(
    "rejects new recurring activation with legacy model %s even when Model O is armed",
    async (recurringModel) => {
      const client = fakeClient();
      const adapter = createTpayPaymentExecutionAdapter({
        client,
        notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
        successUrl: "https://example.test/success",
        errorUrl: "https://example.test/error",
        modelOActivationEnabled: true,
      });

      await expect(adapter.execute({
        ...baseInput,
        mode: "subscription_cycle",
        saveForFutureUse: true,
        providerFlow: "blik_recurring_activation",
        transientProviderInput: {
          provider: "tpay",
          flow: "blik_recurring_activation",
          blikToken: "777777",
          recurringModel,
        },
      })).rejects.toMatchObject({ message: "tpay_blik_model_o_required" });
      expect(client.createTransaction).not.toHaveBeenCalled();
    },
  );

  it("always charges an existing Model O PAYID regardless of the activation switch", async () => {
    const client = fakeClient();
    const adapter = createTpayPaymentExecutionAdapter({
      client,
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
    });

    const result = await adapter.execute({
      ...baseInput,
      mode: "subscription_cycle",
      providerFlow: "recurring_charge",
      paymentMethodRef: "payid_123",
      paymentMethodAliasType: "PAYID",
      paymentMethodRecurringModel: "O",
    });

    expect(client.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 150,
      blikPaymentType: 2,
      blikToken: undefined,
      alias: {
        value: "payid_123",
        type: "PAYID",
        noDelay: true,
        recommendedAuthLevel: "NOCONFREQ",
      },
    }));
    expect(result.requestPayload).toMatchObject({
      providerFlow: "recurring_charge",
      methodRefPresent: true,
      methodRefAliasType: "PAYID",
    });
    expect(JSON.stringify(result)).not.toContain("payid_123");
  });

  it("rejects UID aliases for recurring PAYID charges", async () => {
    const adapter = createTpayPaymentExecutionAdapter({
      client: fakeClient(),
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
    });

    await expect(adapter.execute({
      ...baseInput,
      mode: "subscription_cycle",
      providerFlow: "recurring_charge",
      paymentMethodRef: "uid_alias",
      paymentMethodAliasType: "UID",
    })).rejects.toMatchObject({ message: "tpay_recurring_charge_requires_payid" });
  });

  it.each(["M", undefined] as const)(
    "rejects recurring PAYID charges when the stored mandate model is %s",
    async (paymentMethodRecurringModel) => {
      const client = fakeClient();
      const adapter = createTpayPaymentExecutionAdapter({
        client,
        notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
        successUrl: "https://example.test/success",
        errorUrl: "https://example.test/error",
      });

      await expect(adapter.execute({
        ...baseInput,
        mode: "subscription_cycle",
        providerFlow: "recurring_charge",
        paymentMethodRef: "payid_123",
        paymentMethodAliasType: "PAYID",
        paymentMethodRecurringModel,
      })).rejects.toMatchObject({ message: "tpay_recurring_charge_requires_model_o" });
      expect(client.createTransaction).not.toHaveBeenCalled();
    },
  );

  // Regression guard for the in-account terminal (returnContext). The default
  // (public) path MUST stay byte-identical; "account" swaps only the path while
  // preserving the env/origin-driven host.
  describe("returnContext terminal routing", () => {
    const publicSuccess = "https://example.test/checkout/payment";
    const accountInput = {
      ...baseInput,
      orderId: "22222222-2222-4222-8222-222222222222",
      clientId: "33333333-3333-4333-8333-333333333333",
      subjectId: "44444444-4444-4444-8444-444444444444",
      providerFlow: "blik_one_time" as const,
      transientProviderInput: { provider: "tpay" as const, flow: "blik_one_time" as const, blikToken: "123456" },
    };

    function adapterFor(client: TpayHttpClient) {
      return createTpayPaymentExecutionAdapter({
        client,
        notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
        successUrl: publicSuccess,
        errorUrl: publicSuccess,
      });
    }

    it("keeps the public terminal path when returnContext is omitted (default)", async () => {
      const client = fakeClient();
      await adapterFor(client).execute(accountInput);
      const call = (client.createTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(new URL(call.successUrl).pathname).toBe("/checkout/payment");
      expect(new URL(call.errorUrl).pathname).toBe("/checkout/payment");
      expect(call.simulatorContext?.returnPath).toBeUndefined();
    });

    it("keeps the public terminal path when returnContext is explicitly public", async () => {
      const client = fakeClient();
      await adapterFor(client).execute({ ...accountInput, returnContext: "public" });
      const call = (client.createTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(new URL(call.successUrl).pathname).toBe("/checkout/payment");
    });

    it("routes the Tpay return to the in-account terminal when returnContext is account", async () => {
      const client = fakeClient();
      await adapterFor(client).execute({ ...accountInput, returnContext: "account" });
      const call = (client.createTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const success = new URL(call.successUrl);
      const error = new URL(call.errorUrl);
      // Origin preserved, only the path swapped to the in-shell terminal.
      expect(success.origin).toBe("https://example.test");
      expect(success.pathname).toBe("/account/order/status");
      expect(error.pathname).toBe("/account/order/status");
      // The return params the account terminal polls with are still carried.
      expect(success.searchParams.get("orderId")).toBe(accountInput.orderId);
      expect(success.searchParams.get("paymentIntentId")).toBe(accountInput.paymentIntentId);
      expect(success.searchParams.get("clientId")).toBe(accountInput.clientId);
      expect(success.searchParams.get("subject")).toBe(accountInput.subjectId);
      // The simulator panel is told where to return the buyer.
      expect(call.simulatorContext?.returnPath).toBe("/account/order/status");
    });
  });
});

function fakeClient(): TpayHttpClient {
  return {
    createTransaction: vi.fn(async () => ({
      transactionId: "01HX",
      title: "TR-123",
      status: "pending",
      transactionPaymentUrl: "https://secure.tpay.com/tx",
      requestId: "req-1",
      payIdEligible: null,
      errors: [],
    })),
    getTransaction: vi.fn(),
    listPaymentChannels: vi.fn(),
  };
}

describe("synchronous decline handling", () => {
  const knownMandateRefusal = {
    errorCode: "payment_failed",
    errorMessage: "Bank nie umożliwia rejestracji aliasu dla płatności powtarzalnych",
    fieldName: null,
  };
  const declining = (
    errors = [knownMandateRefusal],
    transactionPaymentUrl: string | null = null,
  ) => ({
    createTransaction: vi.fn(async () => ({
      transactionId: "01HX",
      title: "TR-123",
      status: "pending",
      transactionPaymentUrl,
      requestId: "req-1",
      payIdEligible: null,
      errors,
    })),
    getTransaction: vi.fn(),
    listPaymentChannels: vi.fn(),
  } as unknown as TpayHttpClient);

  const blikInput = {
    idempotencyKey: "k",
    providerIdempotencyKey: "pk",
    providerRequestFingerprint: "fp",
    paymentIntentId: "intent-1",
    amountMinor: 4990,
    currency: "PLN",
    mode: "one_time",
    orderRef: "OPENLUP-1",
    providerFlow: "blik_one_time",
    transientProviderInput: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
    payer: { email: "buyer@example.com", name: "Buyer" },
  } as never;

  const recurringBlikInput = {
    ...(blikInput as object),
    mode: "subscription_cycle",
    providerFlow: "blik_recurring_activation",
    saveForFutureUse: true,
    transientProviderInput: {
      provider: "tpay",
      flow: "blik_recurring_activation",
      blikToken: "123456",
      recurringModel: "O",
    },
  } as never;

  const inputForFlow = (flow: string, transient: object, patch: object = {}) => ({
    ...(blikInput as object),
    providerFlow: flow,
    transientProviderInput: { provider: "tpay", ...transient },
    ...patch,
  }) as never;

  const pblInput = inputForFlow("pbl_one_time", { flow: "pbl_one_time", channelId: "21" });

  const recurringChargeInput = inputForFlow("recurring_charge", { flow: "recurring_charge" }, {
    mode: "subscription_cycle",
    paymentMethodRef: "payid_123",
    paymentMethodAliasType: "PAYID",
    paymentMethodRecurringModel: "O",
  });

  const adapter = (client = declining()) => createTpayPaymentExecutionAdapter({
    client,
    notificationUrl: "https://example.test/hook",
    successUrl: "https://example.test/ok",
    errorUrl: "https://example.test/err",
    modelOActivationEnabled: true,
  });

  it("terminalizes a synchronous one-time BLIK decline without expecting a webhook", async () => {
    const result = await adapter().execute(blikInput);

    expect(result.responsePayload.providerErrorCodes).toEqual(["payment_failed"]);
    expect(result.responsePayload.payIdEligible).toBeNull();
    expect(result.providerDecline).toEqual({
      code: "payment_failed",
      mandateUnsupported: false,
    });
    expect(result.attemptStatus).toBe("processing");
    expect(result.webhookExpected).toBe(false);
  });

  it("suppresses a PBL redirect when the same response contains a synchronous decline", async () => {
    const result = await adapter(
      declining([knownMandateRefusal], "https://payments.example.com/declined-transaction"),
    ).execute(pblInput);

    expect(result.providerDecline).toEqual({
      code: "payment_failed",
      mandateUnsupported: false,
    });
    expect(result.attemptStatus).toBe("processing");
    expect(result.webhookExpected).toBe(false);
    expect(result.nextActionKind).toBeNull();
    expect(result.redirectUrl).toBeNull();
  });

  it.each([
    ["one-time BLIK", blikInput],
    ["stored-mandate recurring charge", recurringChargeInput],
  ])("does not classify code 105 as mandate-dead for %s", async (_label, input) => {
    const code105 = {
      errorCode: "105",
      errorMessage: "Alias PAYID nie jest obsługiwany",
      fieldName: null,
    };

    const result = await adapter(declining([code105])).execute(input);

    expect(result.providerDecline).toEqual({
      code: "105",
      mandateUnsupported: false,
    });
    expect(result.webhookExpected).toBe(false);
  });

  it("terminalizes and classifies a recurring activation decline without another flag", async () => {
    const result = await adapter().execute(recurringBlikInput);

    expect(result.providerDecline).toEqual({
      code: "payment_failed",
      mandateUnsupported: true,
    });
    expect(JSON.stringify(result)).not.toContain(knownMandateRefusal.errorMessage);
  });

  it("does not confuse a generic PAYID alias validation error with missing bank capability", async () => {
    const genericAliasError = {
      errorCode: "payment_failed",
      errorMessage: "Niepoprawny alias PAYID",
      fieldName: null,
    };
    const result = await adapter(declining([genericAliasError])).execute(recurringBlikInput);

    expect(result.providerDecline).toEqual({
      code: "payment_failed",
      mandateUnsupported: false,
    });
    expect(JSON.stringify(result)).not.toContain(genericAliasError.errorMessage);
  });

  it("finds mandate capability evidence in later errors while preserving the first decline code", async () => {
    const firstGenericError = {
      errorCode: "generic_payment_failure",
      errorMessage: "Niepoprawny kod BLIK",
      fieldName: null,
    };
    const result = await adapter(
      declining([firstGenericError, knownMandateRefusal]),
    ).execute(recurringBlikInput);

    expect(result.providerDecline).toEqual({
      code: "generic_payment_failure",
      mandateUnsupported: true,
    });
    expect(result.responsePayload.providerErrorCodes).toEqual([
      "generic_payment_failure",
      "payment_failed",
    ]);
    expect(JSON.stringify(result)).not.toContain(firstGenericError.errorMessage);
    expect(JSON.stringify(result)).not.toContain(knownMandateRefusal.errorMessage);
  });

  it("attaches its own neutral reading of a coded refusal", async () => {
    const codedRefusal = { errorCode: "103", errorMessage: "Brak srodkow", fieldName: null };
    const result = await adapter(declining([codedRefusal])).execute(recurringBlikInput);

    expect(result.providerDecline).toEqual({
      code: "103",
      mandateUnsupported: false,
      neutralReasonHints: ["transient"],
    });
  });

  it("suppresses its terminal-refusal advice when it is already asserting a mandate refusal", async () => {
    // The identity code is only the FIRST error, and the mandate explanation can
    // arrive behind a terminal one. Advice outranks hints in the taxonomy, so
    // letting both through would classify a dead stored reference as a dead
    // instrument and hide the one reading that says a replacement is needed.
    const terminalFirst = { errorCode: "101", errorMessage: "Odrzucone", fieldName: null };
    const result = await adapter(
      declining([terminalFirst, knownMandateRefusal]),
    ).execute(recurringBlikInput);

    expect(result.providerDecline).toEqual({ code: "101", mandateUnsupported: true });
  });

  // The 2026-08-26 incident: the refusal code was in the attempt log from the
  // first minute, and only the reconciliation poll ever looked at it.
  describe("attempt-code decline provenance", () => {
    const genericRefusal = { errorCode: "payment_failed", errorMessage: "Odrzucone", fieldName: null };
    const genericAliasRefusal = {
      errorCode: "payment_failed",
      errorMessage: "Niepoprawny alias PAYID",
      fieldName: null,
    };

    /** A refusal whose attempt log answers `attempts`, or fails the way `attempts` says. */
    const decliningWithAttempts = (
      attempts: unknown,
      errors: { errorCode: string; errorMessage: string; fieldName: null }[] = [genericRefusal],
    ) => ({
      createTransaction: vi.fn(async () => ({
        transactionId: "01HX",
        title: "TR-123",
        status: "pending",
        transactionPaymentUrl: null,
        requestId: "req-1",
        payIdEligible: null,
        errors,
      })),
      getTransaction: vi.fn(async () => {
        if (attempts instanceof Error) throw attempts;
        if (attempts === "never") return await new Promise(() => {});
        return { transactionId: "01HX", payments: { attempts } };
      }),
      listPaymentChannels: vi.fn(),
    } as unknown as TpayHttpClient);

    it("classifies a mandate refusal from the last attempt code, with no message to read", async () => {
      const client = decliningWithAttempts([
        { paymentErrorCode: "100", date: "26.08.2026 09:14" },
        { paymentErrorCode: "105", date: "26.08.2026 09:15" },
      ]);

      const result = await adapter(client).execute(recurringBlikInput);

      expect(client.getTransaction).toHaveBeenCalledWith("01HX");
      expect(result.providerDecline).toEqual({
        code: "payment_failed",
        mandateUnsupported: true,
        neutralReasonHints: ["mandateUnsupported"],
      });
      expect(result.responsePayload.declineEvidence).toBe("attempt_code:105");
      // The message said nothing about a mandate; only the code did.
      expect(JSON.stringify(result)).not.toContain("Odrzucone");
    });

    it("does not claim mandate death from the same code outside registration", async () => {
      const result = await adapter(
        decliningWithAttempts([{ paymentErrorCode: "105" }]),
      ).execute(recurringChargeInput);

      expect(result.providerDecline).toEqual({ code: "payment_failed", mandateUnsupported: false });
      expect(result.responsePayload.declineEvidence).toBe("attempt_code:105");
    });

    it("falls back to the message heuristic when the attempt code is a known-unknown", async () => {
      const result = await adapter(
        decliningWithAttempts([{ paymentErrorCode: "100" }], [knownMandateRefusal]),
      ).execute(recurringBlikInput);

      expect(result.providerDecline).toEqual({ code: "payment_failed", mandateUnsupported: true });
      expect(result.responsePayload.declineEvidence).toBe("prose_regex");
      expect(JSON.stringify(result)).not.toContain(knownMandateRefusal.errorMessage);
    });

    it("still records a code it read but cannot read the meaning of", async () => {
      const result = await adapter(
        decliningWithAttempts([{ paymentErrorCode: "100" }], [genericAliasRefusal]),
      ).execute(recurringBlikInput);

      expect(result.providerDecline).toEqual({ code: "payment_failed", mandateUnsupported: false });
      expect(result.responsePayload.declineEvidence).toBe("attempt_code:100");
    });

    it("names the create-response code when that is the reading which decided", async () => {
      const coded = { errorCode: "103", errorMessage: "Brak srodkow", fieldName: null };
      const result = await adapter(decliningWithAttempts([], [coded])).execute(recurringBlikInput);

      expect(result.providerDecline).toEqual({
        code: "103",
        mandateUnsupported: false,
        neutralReasonHints: ["transient"],
      });
      expect(result.responsePayload.declineEvidence).toBe("error_code:103");
    });

    it.each([
      ["the readback fails", new Error("connection reset")],
      ["the attempt log carries no code", [{ date: "26.08.2026 09:15" }]],
    ])("keeps today's classification when %s", async (_label, attempts) => {
      const mandate = await adapter(
        decliningWithAttempts(attempts, [knownMandateRefusal]),
      ).execute(recurringBlikInput);
      const generic = await adapter(
        decliningWithAttempts(attempts, [genericAliasRefusal]),
      ).execute(recurringBlikInput);

      expect(mandate.providerDecline).toEqual({ code: "payment_failed", mandateUnsupported: true });
      expect(mandate.responsePayload.declineEvidence).toBe("prose_regex");
      expect(generic.providerDecline).toEqual({ code: "payment_failed", mandateUnsupported: false });
      expect(generic.responsePayload.declineEvidence).toBe("none");
    });

    it("keeps today's classification when the readback never answers", async () => {
      vi.useFakeTimers();
      try {
        const pending = adapter(
          decliningWithAttempts("never", [knownMandateRefusal]),
        ).execute(recurringBlikInput);
        await vi.advanceTimersByTimeAsync(3_000);
        const result = await pending;

        expect(result.providerDecline).toEqual({ code: "payment_failed", mandateUnsupported: true });
        expect(result.responsePayload.declineEvidence).toBe("prose_regex");
        expect(result.webhookExpected).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never reads the transaction back when the provider did not refuse", async () => {
      const client = fakeClient();
      const result = await adapter(client).execute(recurringBlikInput);

      expect(client.getTransaction).not.toHaveBeenCalled();
      expect(result.responsePayload.declineEvidence).toBeUndefined();
    });
  });

  /**
   * The characterization this wave exists for. One refusal, one verdict — no
   * matter which of the two rails happened to observe it.
   *
   * The rails see the same event through different windows: the execution path
   * the instant the provider refuses, the reconciliation poll from the
   * transaction readback minutes or hours later. Both reach the same reading
   * table, and until this wave only one of them qualified what it read, so a
   * renewal refused with a capability code classified `indeterminate` or
   * `mandate_dead` depending on which window it arrived through. That is a race,
   * and the retry ladder is not allowed to terminate on one.
   *
   * Written as an equality between the rails rather than as two fixed
   * expectations, so it keeps holding if the shared reading later changes: what
   * is pinned is the agreement, which is the property.
   */
  describe("one verdict per refusal, whichever rail observed it", () => {
    const attemptsRefusedWith = (code: string) => ({
      transactionId: "01HX",
      status: "pending",
      payments: { attempts: [{ date: "26.08.2026 09:15", paymentErrorCode: code }] },
    });

    /** What the poll would conclude about the same transaction, in one shape. */
    const polled = (code: string) => {
      const { rawPayload } = normalizeTpayTransaction(attemptsRefusedWith(code));
      return {
        hints: rawPayload.neutralReasonHints,
        failureClass: rawPayload.failureClass,
      };
    };

    /** What the execution path concludes, reduced to the same shape. */
    const executed = async (code: string, input: never) => {
      const client = {
        createTransaction: vi.fn(async () => ({
          transactionId: "01HX",
          title: "TR-123",
          status: "pending",
          transactionPaymentUrl: null,
          requestId: "req-1",
          payIdEligible: null,
          errors: [{ errorCode: "payment_failed", errorMessage: "Odrzucone", fieldName: null }],
        })),
        getTransaction: vi.fn(async () => attemptsRefusedWith(code)),
        listPaymentChannels: vi.fn(),
      } as unknown as TpayHttpClient;
      const { providerDecline } = await adapter(client).execute(input);
      if (!providerDecline) throw new Error("expected a refusal");
      return {
        hints: providerDecline.neutralReasonHints ?? [],
        // Through the same seam production sends it through. `decidedBy` is
        // deliberately not compared: the two rails persist DIFFERENT reason
        // strings with the attempt, and the seam names the one actually on the
        // row. The class is the verdict; the source is provenance.
        failureClass: classifyDecline(providerDecline).failureClass,
      };
    };

    it.each(["105", "103", "104", "106", "101", "107", "100"])(
      "agrees with the reconciliation poll about code %s on a renewal",
      async (code) => {
        expect(await executed(code, recurringChargeInput)).toEqual(polled(code));
      },
    );

    it("keeps the bank claim where a mandate is actually being registered", async () => {
      // The other half of the fix, and the reason it is not simply "delete the
      // row": on a REGISTRATION the execution path can establish the context the
      // claim needs, so it still states it — and now states strictly more than
      // the poll, which by design cannot.
      const result = await executed("105", recurringBlikInput);

      expect(result).toEqual({ hints: ["mandateUnsupported"], failureClass: "mandate_dead" });
      expect(polled("105").hints).toEqual([]);
    });
  });
});
