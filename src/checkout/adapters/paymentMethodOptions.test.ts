import { describe, expect, it } from "vitest";

import {
  isPaymentMethodVisible,
  providerForPaymentMethod,
  visiblePaymentMethods,
} from "./paymentMethodOptions.js";

const STRIPE_ONLY = { stripeEnabled: true, tpayEnabled: false };
const TPAY_ONLY = { stripeEnabled: false, tpayEnabled: true, tpayModelOEnabled: true };
const TPAY_WITH_ONE_CLICK = {
  stripeEnabled: false,
  tpayEnabled: true,
  tpayOneClickAvailable: true,
  tpayModelOEnabled: true,
};
const BOTH = { stripeEnabled: true, tpayEnabled: true, tpayModelOEnabled: true };
const BOTH_WITH_ONE_CLICK = {
  stripeEnabled: true,
  tpayEnabled: true,
  tpayOneClickAvailable: true,
  tpayModelOEnabled: true,
};
const NONE = { stripeEnabled: false, tpayEnabled: false };

describe("paymentMethodOptions", () => {
  it("shows Stripe card only when only Stripe is enabled", () => {
    expect(visiblePaymentMethods("one_time", STRIPE_ONLY).map((o) => o.value)).toEqual(["card"]);
    expect(visiblePaymentMethods("subscription", STRIPE_ONLY).map((o) => o.value)).toEqual(["card"]);
  });

  it("shows Tpay methods only when only Tpay is enabled", () => {
    expect(visiblePaymentMethods("one_time", TPAY_ONLY).map((o) => o.value)).toEqual([
      "blik",
      "transfer",
    ]);
    expect(visiblePaymentMethods("subscription", TPAY_ONLY).map((o) => o.value)).toEqual(["blik"]);
  });

  it("shows BLIK without code only when an active saved Tpay method is available", () => {
    expect(visiblePaymentMethods("one_time", TPAY_WITH_ONE_CLICK).map((o) => o.value)).toEqual([
      "blik_one_click",
      "blik",
      "transfer",
    ]);
    expect(visiblePaymentMethods("subscription", TPAY_WITH_ONE_CLICK).map((o) => o.value)).toEqual([
      "blik_one_click",
      "blik",
    ]);
  });

  it("offers card, blik and pay-by-link for one-time checkout when both are enabled", () => {
    expect(visiblePaymentMethods("one_time", BOTH).map((o) => o.value)).toEqual([
      "card",
      "blik",
      "transfer",
    ]);
    expect(visiblePaymentMethods("one_time", BOTH_WITH_ONE_CLICK).map((o) => o.value)).toEqual([
      "card",
      "blik_one_click",
      "blik",
      "transfer",
    ]);
  });

  it("hides pay-by-link for subscription checkout (Tpay has no recurring PBL)", () => {
    const values = visiblePaymentMethods("subscription", BOTH).map((o) => o.value);
    expect(values).toEqual(["card", "blik"]);
    expect(values).not.toContain("transfer");
    expect(visiblePaymentMethods("subscription", BOTH_WITH_ONE_CLICK).map((o) => o.value)).toEqual([
      "card",
      "blik_one_click",
      "blik",
    ]);
  });

  it("hides only new subscription BLIK while Model O activation is off", () => {
    const modelOOff = { stripeEnabled: true, tpayEnabled: true, tpayModelOEnabled: false };
    expect(visiblePaymentMethods("one_time", modelOOff).map((o) => o.value)).toEqual([
      "card",
      "blik",
      "transfer",
    ]);
    expect(visiblePaymentMethods("subscription", modelOOff).map((o) => o.value)).toEqual([
      "card",
    ]);
  });

  it("shows nothing when no provider is enabled", () => {
    expect(visiblePaymentMethods("one_time", NONE)).toEqual([]);
  });

  it("reflects visibility per mode and provider availability", () => {
    expect(isPaymentMethodVisible("card", "subscription", STRIPE_ONLY)).toBe(true);
    expect(isPaymentMethodVisible("card", "one_time", TPAY_ONLY)).toBe(false);
    expect(isPaymentMethodVisible("blik", "one_time", STRIPE_ONLY)).toBe(false);
    expect(isPaymentMethodVisible("transfer", "one_time", BOTH)).toBe(true);
    expect(isPaymentMethodVisible("transfer", "subscription", BOTH)).toBe(false);
    expect(isPaymentMethodVisible("blik", "subscription", BOTH)).toBe(true);
    expect(isPaymentMethodVisible("blik_one_click", "subscription", BOTH)).toBe(false);
    expect(isPaymentMethodVisible("blik_one_click", "subscription", BOTH_WITH_ONE_CLICK)).toBe(true);
  });

  it("maps each method to its provider", () => {
    expect(providerForPaymentMethod("card")).toBe("stripe");
    expect(providerForPaymentMethod("blik")).toBe("tpay");
    expect(providerForPaymentMethod("blik_one_click")).toBe("tpay");
    expect(providerForPaymentMethod("transfer")).toBe("tpay");
  });
});

import type { CheckoutPaymentRecoveryGuidance } from "@/domains/commerce/paymentRecoveryGuidanceContracts";
import type { PaymentMethodOption } from "./paymentMethodOptions";
import { presentCheckoutRecoveryGuidance } from "../machine/checkoutRecoveryGuidance";

const methods: PaymentMethodOption[] = [{ value: "card", provider: "stripe" }, { value: "blik", provider: "tpay" }];
const base: CheckoutPaymentRecoveryGuidance = {
  version: 1, paymentAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", purchaseContext: "subscription_initial",
  cause: "generic_decline", methodKind: "card", methodKey: "card", operation: "recurring_setup", restriction: null,
  actions: ["change_instrument", "change_method"], consecutiveRefusals: 1, emphasis: "normal",
};
const present = (patch: Partial<CheckoutPaymentRecoveryGuidance> = {}, options = methods) => presentCheckoutRecoveryGuidance({
  guidance: { ...base, ...patch }, methods: options,
});
const key = (id: string) => `checkout:recoveryGuidance.messages.${id}`;

describe("checkout recovery presentation", () => {
  it("offers another eligible method on first refusal and uses only server threshold", () => {
    expect(present()?.messageKey).toBe(key("c01"));
    const second = present({ consecutiveRefusals: 2, emphasis: "recommended" });
    expect(second).toMatchObject({ messageKey: key("c02"), emphasis: "recommended", actions: [{ kind: "change_method" }] });
    expect(present({ consecutiveRefusals: null })?.messageKey).toBe(key("c01"));
  });
  it("never derives a count or diagnosis from missing guidance or unknown identity", () => {
    expect(presentCheckoutRecoveryGuidance({ guidance: null, methods })).toBeNull();
    expect(present({ methodKind: null, methodKey: null })?.messageKey).toBe(key("c12"));
  });
  it("uses the two-action funds sentence only when both actions exist", () => {
    expect(present({ cause: "insufficient_funds" })).toMatchObject({ messageKey: key("c03"), actions: [
      { kind: "change_instrument", method: "card" }, { kind: "change_method" },
    ] });
    expect(present({ cause: "insufficient_funds", methodKind: "blik", methodKey: "blik" })?.messageKey).toBe(key("c03Alternative"));
    expect(present({ cause: "insufficient_funds" }, [])?.messageKey).toBe(key("c12"));
  });
  it("requires proven recurring method failure and an actual card for the agreement sentence", () => {
    const failure = { cause: "recurring_setup_failed" as const, methodKind: "blik", methodKey: "blik" };
    expect(present(failure)).toMatchObject({ messageKey: key("c07"), actions: [{ kind: "change_method", method: "card" }] });
    expect(present({ ...failure, restriction: "method", actions: ["change_method"] })?.messageKey).toBe(key("c07"));
  });
  it("asks for a new code first after a BLIK activation refusal that proves nothing about the bank", () => {
    const refused = { methodKind: "blik", methodKey: "blik" };
    expect(present(refused)).toEqual({ messageKey: key("c18"), emphasis: "normal", actions: [
      { kind: "change_instrument", method: "blik", labelKey: "checkout:recoveryGuidance.actions.enterNewCode" },
      { kind: "change_method", method: "card", labelKey: "checkout:recoveryGuidance.actions.payByCard" }] });
    expect(present(refused, [{ value: "blik", provider: "tpay" }])).toMatchObject({ messageKey: key("c18"),
      actions: [{ kind: "change_instrument", method: "blik" }] });
    expect(present({ ...refused, consecutiveRefusals: 2, emphasis: "recommended" })?.messageKey).toBe(key("c02"));
    expect(present({ ...refused, actions: ["change_method"] })?.messageKey).toBe(key("c01"));
    expect(present({ ...refused, operation: "one_time_payment", purchaseContext: "one_time" })?.messageKey).toBe(key("c01"));
    expect(present({ ...refused, methodKey: "blik_one_click" })?.messageKey).toBe(key("c01"));
    // A persisted mandate decision the server could not fully prove stays generic and method-restricted.
    expect(present({ ...refused, restriction: "method", actions: ["change_method"] })).toEqual({
      messageKey: key("c11a"), emphasis: "normal",
      actions: [{ kind: "change_method", method: "card", labelKey: "checkout:recoveryGuidance.actions.changeMethod" }] });
  });
  it("keeps the agreement sentence for the recurring failure it was written for", () => {
    const failure = { cause: "recurring_setup_failed" as const, methodKind: "blik", methodKey: "blik" };
    expect(present({ ...failure, operation: "one_time_payment", purchaseContext: "one_time" })?.messageKey).toBe(key("c01"));
    expect(present(failure, [{ value: "blik", provider: "tpay" }])?.messageKey).toBe(key("c12"));
    expect(present({ ...failure, methodKind: "card", methodKey: "card" })?.messageKey).toBe(key("c01"));
    // Method semantics select the sentence, including when another adapter supplies the method.
    expect(present(failure, methods.map((method) => ({ ...method, provider: "stripe" })))?.messageKey).toBe(key("c07"));
  });
  it("keeps unavailable and one-time-only alternatives out of subscription advice", () => {
    expect(present({}, [{ value: "transfer", provider: "tpay" }])?.messageKey).toBe(key("c12"));
    expect(present({ purchaseContext: "one_time", operation: "one_time_payment" }, [{ value: "transfer", provider: "tpay" }])?.messageKey).toBe(key("c01"));
    expect(present({}, [])).toMatchObject({ messageKey: key("c12"), actions: [{ kind: "contact_support" }] });
  });
  it("does not invent an instrument replacement for a stored choice or absent card", () => {
    expect(present({ restriction: "instrument", methodKind: "blik", methodKey: "blik_one_click" })?.actions)
      .not.toContainEqual(expect.objectContaining({ kind: "change_instrument" }));
    expect(present({ cause: "expired_card" }, [{ value: "blik", provider: "tpay" }])?.messageKey).toBe(key("c01"));
  });
  it("distinguishes expiry, input correction, operation and restriction scope", () => {
    expect(present({ cause: "expired_card" })?.messageKey).toBe(key("c04"));
    expect(present({ cause: "expired_card", restriction: "instrument" })?.messageKey).toBe(key("c04"));
    expect(present({ cause: "operation_unsupported" })?.messageKey).toBe(key("c06"));
    expect(present({ restriction: "method", actions: ["change_method"] })?.messageKey).toBe(key("c11a"));
    expect(present({ restriction: "instrument" })?.messageKey).toBe(key("c11"));
    expect(presentCheckoutRecoveryGuidance({ guidance: { ...base, cause: "invalid_payment_data", actions: ["correct_data", "change_method"] }, methods,
      canCorrectData: true })?.messageKey).toBe(key("c05"));
    expect(present({ cause: "invalid_payment_data", actions: ["correct_data", "change_method"] })?.messageKey).toBe(key("c01"));
  });
  it("offers authentication only with the current usable authorized action", () => {
    const guidance = { ...base, cause: "authentication_required" as const, actions: ["authenticate" as const, "change_method" as const] };
    const presentAuth = (nextAction: Parameters<typeof presentCheckoutRecoveryGuidance>[0]["nextAction"]) =>
      presentCheckoutRecoveryGuidance({ guidance, methods, nextAction });
    expect(presentAuth({ kind: "redirect", url: "https://payments.example.test/confirm" })?.messageKey).toBe(key("c08"));
    expect(presentAuth({ kind: "provider_embedded", provider: "stripe", clientSecret: "ephemeral" })?.messageKey).toBe(key("c08"));
    for (const nextAction of [null, { kind: "none" } as const, { kind: "redirect", url: "javascript:alert(1)" } as const,
      { kind: "redirect", url: "https://user:password@payments.example.test/confirm" } as const,
      { kind: "blik_code_prompt", provider: "tpay" } as const]) {
      expect(presentAuth(nextAction)?.messageKey).toBe(key("c01"));
    }
    expect(presentAuth(null)?.actions.some(({ kind }) => kind === "authenticate")).toBe(false);
  });
  it("does not promote forbidden semantic actions merely because a tile exists", () => {
    expect(present({ actions: ["contact_support"] })?.messageKey).toBe(key("c12"));
    expect(present({ restriction: "method", actions: ["change_method"] }, [{ value: "card", provider: "stripe" }])?.messageKey).toBe(key("c12"));
  });
});
