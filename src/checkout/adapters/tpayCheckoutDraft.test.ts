import { describe, expect, it } from "vitest";

import {
  BLIK_BANK_UNSUPPORTED,
  // Aliased so this file names the builder once instead of at every call.
  buildTpayCheckoutRequestPatch as buildPatch,
  emptyTpayCheckoutDraft,
  isTpayPblCheckoutChannel,
  validateTpayCheckoutDraft,
} from "./tpayCheckoutDraft";

describe("Tpay checkout draft", () => {
  const savedMethodId = "22222222-2222-4222-8222-222222222222";

  it("builds transient BLIK execution without requiring persisted form changes", () => {
    expect(buildPatch({
      enabled: true,
      paymentMethod: "blik",
      draft: { blikToken: "123456", blikBankId: "", pblChannelId: "", savedMethodId: "" },
      checkoutMode: "one_time",
    })).toEqual({
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
    });
  });

  it("builds BLIK recurring activation with the selected Model O for subscription checkout", () => {
    expect(buildPatch({
      enabled: true,
      paymentMethod: "blik",
      draft: { blikToken: "123456", blikBankId: "", pblChannelId: "", savedMethodId: "" },
      checkoutMode: "subscription",
    })).toEqual({
      paymentProvider: "tpay",
      paymentExecution: {
        provider: "tpay",
        flow: "blik_recurring_activation",
        blikToken: "123456",
        recurringModel: "O",
      },
    });
  });

  // The declared issuer is what makes a later refusal attributable to a bank.
  // Without it the offered roster can never be corrected from evidence — the
  // gap that made two production refusals on 2026-08-20 unattributable.
  it("reports the declared bank for subscription checkout", () => {
    const patch = buildPatch({
      enabled: true,
      paymentMethod: "blik",
      draft: { blikToken: "123456", blikBankId: "ing", pblChannelId: "", savedMethodId: "" },
      checkoutMode: "subscription",
    });
    // Beside the execution, not inside it: an issuer is a scheme fact, and the
    // acquirer in front of the scheme is replaceable.
    expect(patch?.declaredBankId).toBe("ing");
    expect(patch?.paymentExecution).not.toHaveProperty("declaredBankId");
  });

  // "Not on the list" is an answer about the roster, not an issuer, so it must
  // not be recorded as one — and the contract requires a non-empty value, so an
  // absent field is the only honest shape for "not asked".
  it("omits the declared bank for the not-on-the-list sentinel and for one-time checkout", () => {
    const sentinel = buildPatch({
      enabled: true,
      paymentMethod: "blik",
      draft: { blikToken: "123456", blikBankId: BLIK_BANK_UNSUPPORTED, pblChannelId: "", savedMethodId: "" },
      checkoutMode: "subscription",
    });
    expect(sentinel).not.toHaveProperty("declaredBankId");

    const oneTime = buildPatch({
      enabled: true,
      paymentMethod: "blik",
      draft: { blikToken: "123456", blikBankId: "ing", pblChannelId: "", savedMethodId: "" },
      checkoutMode: "one_time",
    });
    expect(oneTime).not.toHaveProperty("declaredBankId");
  });

  it("builds BLIK without-code one-click execution from a local saved method id", () => {
    expect(buildPatch({
      enabled: true,
      paymentMethod: "blik_one_click",
      draft: { blikToken: "", blikBankId: "", pblChannelId: "", savedMethodId },
      checkoutMode: "one_time",
    })).toEqual({
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_click", savedMethodId },
    });
  });

  it("builds saved BLIK recurring execution for subscription checkout", () => {
    expect(buildPatch({
      enabled: true,
      paymentMethod: "blik_one_click",
      draft: { blikToken: "", blikBankId: "", pblChannelId: "", savedMethodId },
      checkoutMode: "subscription",
    })).toEqual({
      paymentProvider: "tpay",
      paymentExecution: {
        provider: "tpay",
        flow: "blik_recurring_saved",
        savedMethodId,
      },
    });
  });

  it("requires a local saved method id for BLIK without code", () => {
    expect(validateTpayCheckoutDraft({
      enabled: true,
      paymentMethod: "blik_one_click",
      draft: { blikToken: "", blikBankId: "", pblChannelId: "", savedMethodId: "" },
      checkoutMode: "one_time",
    })).toEqual({ savedMethodId: "checkout:step6.savedBlikUnavailableError" });
  });


  it("builds transient PBL execution from a selected channel", () => {
    expect(buildPatch({
      enabled: true,
      paymentMethod: "transfer",
      draft: { blikToken: "", blikBankId: "", pblChannelId: "21", savedMethodId: "" },
      checkoutMode: "one_time",
    })).toEqual({
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "21" },
    });
  });

  it("does not build PBL execution for subscription checkout", () => {
    expect(buildPatch({
      enabled: true,
      paymentMethod: "transfer",
      draft: { blikToken: "", blikBankId: "", pblChannelId: "21", savedMethodId: "" },
      checkoutMode: "subscription",
    })).toBeNull();
  });

  it("returns validation errors for incomplete provider drafts only when scaffolding is enabled", () => {
    expect(validateTpayCheckoutDraft({
      enabled: true,
      paymentMethod: "blik",
      draft: { blikToken: "12", blikBankId: "", pblChannelId: "", savedMethodId: "" },
      checkoutMode: "one_time",
    })).toEqual({ blikToken: "checkout:step6.blikCodeError" });
    expect(validateTpayCheckoutDraft({
      enabled: false,
      paymentMethod: "blik",
      draft: { blikToken: "12", blikBankId: "", pblChannelId: "", savedMethodId: "" },
      checkoutMode: "one_time",
    })).toEqual({});
  });

  it("returns a validation error for subscription PBL instead of falling back", () => {
    expect(validateTpayCheckoutDraft({
      enabled: true,
      paymentMethod: "transfer",
      draft: { blikToken: "", blikBankId: "", pblChannelId: "21", savedMethodId: "" },
      checkoutMode: "subscription",
    })).toEqual({ pblChannelId: "checkout:step6.subscriptionPblUnsupportedError" });
  });

  it("keeps only usable Pay-by-Link channels out of the Tpay channel list", () => {
    expect(isTpayPblCheckoutChannel({
      id: "21",
      name: "PKO",
      fullName: "PKO Bank Polski",
      available: true,
      onlinePayment: true,
      instantRedirection: true,
      groups: [{ id: 108, name: "Bank" }],
    })).toBe(true);
    expect(isTpayPblCheckoutChannel({
      id: "150",
      name: "BLIK",
      fullName: "BLIK",
      available: true,
      onlinePayment: true,
      instantRedirection: true,
      groups: [{ id: 150, name: "BLIK" }],
    })).toBe(false);
    expect(isTpayPblCheckoutChannel({
      id: "offline",
      name: "Offline",
      fullName: "Offline",
      available: true,
      onlinePayment: false,
      instantRedirection: true,
      groups: [{ id: 1, name: "Bank" }],
    })).toBe(false);
    expect(isTpayPblCheckoutChannel({
      id: "delayed",
      name: "Delayed",
      fullName: "Delayed",
      available: true,
      onlinePayment: true,
      instantRedirection: false,
      groups: [{ id: 1, name: "Bank" }],
    })).toBe(false);
  });
});

describe("subscription BLIK bank declaration", () => {
  const base = {
    enabled: true,
    paymentMethod: "blik" as const,
    checkoutMode: "subscription" as const,
    bankPickerEnabled: true,
  };

  it("reports the missing BANK, not the missing code, while the code field is hidden", () => {
    // Reporting `blikToken` here would point at an input the buyer cannot see,
    // leaving the submit button silently inert.
    expect(validateTpayCheckoutDraft({ ...base, draft: emptyTpayCheckoutDraft }))
      .toEqual({ blikBankId: "checkout:step6.blikBankError" });
  });

  it("blocks submission when the buyer says their bank is not on the list", () => {
    expect(validateTpayCheckoutDraft({
      ...base,
      draft: { ...emptyTpayCheckoutDraft, blikBankId: "__other__", blikToken: "123456" },
    })).toEqual({ blikBankId: "checkout:step6.blikBankUnsupportedTitle" });
  });

  it("falls through to normal code validation once a supported bank is named", () => {
    expect(validateTpayCheckoutDraft({
      ...base,
      draft: { ...emptyTpayCheckoutDraft, blikBankId: "ing", blikToken: "123456" },
    })).toEqual({});
  });

  it("never demands a bank for one-off BLIK, which needs no mandate", () => {
    expect(validateTpayCheckoutDraft({
      ...base,
      checkoutMode: "one_time",
      draft: { ...emptyTpayCheckoutDraft, blikToken: "123456" },
    })).toEqual({});
  });

  it("never demands a bank while the picker is flagged off", () => {
    expect(validateTpayCheckoutDraft({
      ...base,
      bankPickerEnabled: false,
      draft: { ...emptyTpayCheckoutDraft, blikToken: "123456" },
    })).toEqual({});
  });
});
