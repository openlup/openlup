import { describe, expect, it } from "vitest";

import { buildCreateTransactionInput, resolveRecurringModel } from "../../../src/payments/tpay/tpayCreateTransactionInput.js";
import type { PaymentExecutionInput, TpayTransientProviderInput } from "../../../src/payments/tpay/donorContracts.js";

function args(
  transient: TpayTransientProviderInput,
  overrides: { modelOActivationEnabled?: boolean; input?: Partial<PaymentExecutionInput> } = {},
) {
  return {
    input: {
      idempotencyKey: "key",
      providerIdempotencyKey: "provider-key",
      providerRequestFingerprint: "fingerprint",
      paymentIntentId: "intent-1",
      amountMinor: 1490,
      currency: "PLN",
      mode: "subscription_cycle",
      orderRef: "OPENLUP-TEST",
      saveForFutureUse: true,
      ...overrides.input,
    } as PaymentExecutionInput,
    transient,
    payer: { email: "buyer@example.com", name: "Buyer" },
    notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
    successUrl: "https://example.test/ok",
    errorUrl: "https://example.test/err",
    aliasRegistrationOnCodeEnabled: false,
    modelOActivationEnabled: overrides.modelOActivationEnabled ?? false,
  };
}

/** The one model O mandate charge both the alias proof and the whole-request golden read. */
const modelOChargeArgs = () => args({ provider: "tpay", flow: "recurring_charge" }, {
  modelOActivationEnabled: true,
  input: {
    paymentMethodRef: "openlup_intent-1",
    paymentMethodAliasType: "PAYID",
    paymentMethodRecurringModel: "O",
  },
});

const activation: TpayTransientProviderInput = {
  provider: "tpay",
  flow: "blik_recurring_activation",
  blikToken: "123456",
};

describe("resolveRecurringModel", () => {
  it("upgrades to O once approved, whatever the client asked for", () => {
    // The client hardcodes "M"; approval is the server-side switch, so the
    // decision cannot be left to whatever the browser happened to send.
    expect(resolveRecurringModel("M", true)).toBe("O");
    expect(resolveRecurringModel(undefined, true)).toBe("O");
  });

  it("stays on M while unapproved", () => {
    expect(resolveRecurringModel(undefined, false)).toBe("M");
    expect(resolveRecurringModel("M", false)).toBe("M");
  });
});

describe("buildCreateTransactionInput", () => {
  it("emits the model O mandate exactly as verified in production", () => {
    const request = buildCreateTransactionInput(args(activation, { modelOActivationEnabled: true }));

    expect(request.alias).toMatchObject({
      type: "PAYID",
      recommendedAuthLevel: "NOCONFREQ",
      autopayment: { model: "O" },
    });
    // Without this the payer is charged and never shown the mandate invitation —
    // the exact failure that stranded a paying customer on 2026-07-19.
    expect(request.refuseNoPayId).toBe(true);
  });

  it("keeps the pre-model-O payload byte-identical while unapproved", () => {
    const request = buildCreateTransactionInput(args(activation));

    expect(request.alias).toMatchObject({ type: "PAYID", autopayment: { model: "M" } });
    expect(request.alias).not.toHaveProperty("recommendedAuthLevel");
    // refuseNoPayId only makes sense alongside model O; setting it under M would
    // change behaviour for buyers the flag was never meant to touch.
    expect(request.refuseNoPayId).toBeUndefined();
  });

  it("adds noDelay and NOCONFREQ to a charge on a model O mandate", () => {
    // Verified 2026-07-20: a charge missing these does not fail loudly — it
    // emails the payer an approval link, i.e. silently reverts to model M.
    const request = buildCreateTransactionInput(modelOChargeArgs());

    expect(request.alias).toMatchObject({
      value: "openlup_intent-1",
      type: "PAYID",
      noDelay: true,
      recommendedAuthLevel: "NOCONFREQ",
    });
  });

  // The de-branching safety net: the WHOLE recurring-charge request, not just
  // its alias. Capability-driven dispatch must leave every byte of this
  // identical, and `toEqual` on the built request is what proves it in seconds.
  it("pins the exact recurring-charge request the renewal path sends", () => {
    const chargeArgs = modelOChargeArgs();
    const order = chargeArgs.input.orderRef;

    expect(buildCreateTransactionInput(chargeArgs)).toEqual({
      amount: 14.9,
      currency: "PLN",
      description: order,
      hiddenDescription: "intent-1",
      payer: chargeArgs.payer,
      notificationUrl: chargeArgs.notificationUrl,
      successUrl: `${chargeArgs.successUrl}?paymentIntentId=intent-1&order=${order}`,
      errorUrl: `${chargeArgs.errorUrl}?paymentIntentId=intent-1&order=${order}`,
      groupId: 150,
      channelId: undefined,
      // BLIK PAYID charge, and the two autopayment fields without which the
      // provider emails the payer for approval instead of collecting.
      blikPaymentType: 2,
      blikToken: undefined,
      refuseNoPayId: undefined,
      alias: {
        value: chargeArgs.input.paymentMethodRef,
        type: "PAYID",
        noDelay: true,
        recommendedAuthLevel: "NOCONFREQ",
      },
      simulatorContext: {
        orderId: undefined,
        paymentIntentId: "intent-1",
        clientId: undefined,
        providerAttemptKey: "provider-key",
      },
    });
  });

  it("charges a model M mandate as model M even when the merchant flag says O", () => {
    // Production can hold mandates registered before approval. Charging those as
    // model O contradicts the agreement the payer actually gave, so the mandate
    // decides — not the flag.
    const request = buildCreateTransactionInput(
      args({ provider: "tpay", flow: "recurring_charge" }, {
        modelOActivationEnabled: true,
        input: {
          paymentMethodRef: "openlup_old-m",
          paymentMethodAliasType: "PAYID",
          paymentMethodRecurringModel: "M",
        },
      }),
    );

    expect(request.alias).toEqual({ value: "openlup_old-m", type: "PAYID" });
  });

  it("fails closed when the mandate's model cannot be established", () => {
    // Mandates registered before the model was recorded have no answer. Guessing
    // "O" would charge an unknown agreement under no-confirmation terms.
    const request = buildCreateTransactionInput(
      args({ provider: "tpay", flow: "recurring_charge" }, {
        modelOActivationEnabled: true,
        input: { paymentMethodRef: "openlup_legacy", paymentMethodAliasType: "PAYID" },
      }),
    );

    expect(request.alias).toEqual({ value: "openlup_legacy", type: "PAYID" });
  });

  it("never marks a plain one-off BLIK with refuseNoPayId", () => {
    const request = buildCreateTransactionInput(
      args({ provider: "tpay", flow: "blik_one_time", blikToken: "123456" }, {
        modelOActivationEnabled: true,
        input: { mode: "one_time" },
      }),
    );

    // A one-off needs no mandate, so rejecting an "incapable" bank would refuse
    // a payment that would have worked perfectly.
    expect(request.refuseNoPayId).toBeUndefined();
    expect(request.alias).toBeNull();
  });
});

describe("one-off and one-click payments stay untouched by model O", () => {
  // These two flows are live on production today. Model O approval must not
  // reach them: neither carries an autopayment agreement, so autopayment-only
  // fields would be rejected by Tpay for payments that work right now.
  it("keeps a plain one-off BLIK payload identical whether or not model O is approved", () => {
    const oneOff = { provider: "tpay", flow: "blik_one_time", blikToken: "123456" } as const;
    const off = buildCreateTransactionInput(args(oneOff, { input: { mode: "one_time" } }));
    const on = buildCreateTransactionInput(args(oneOff, { modelOActivationEnabled: true, input: { mode: "one_time" } }));

    expect(on).toEqual(off);
  });

  it("never attaches autopayment fields to a UID one-click alias", () => {
    const request = buildCreateTransactionInput(
      args({ provider: "tpay", flow: "blik_one_click" }, {
        modelOActivationEnabled: true,
        input: { mode: "one_time", paymentMethodRef: "openlup_uid-1", paymentMethodAliasType: "UID" },
      }),
    );

    expect(request.alias).toEqual({ value: "openlup_uid-1", type: "UID" });
    expect(request.alias).not.toHaveProperty("noDelay");
    expect(request.alias).not.toHaveProperty("recommendedAuthLevel");
  });

  it("keeps a pay-by-link payload free of BLIK fields under model O", () => {
    const request = buildCreateTransactionInput(
      args({ provider: "tpay", flow: "pbl_one_time", channelId: "13" }, {
        modelOActivationEnabled: true,
        input: { mode: "one_time" },
      }),
    );

    expect(request.alias).toBeNull();
    expect(request.refuseNoPayId).toBeUndefined();
    expect(request.channelId).toBe("13");
  });
});
