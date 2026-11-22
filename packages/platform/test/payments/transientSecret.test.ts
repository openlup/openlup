import { describe, expect, it } from "vitest";
import {
  brandTransientSecret,
  type PaymentProviderExecutor,
  type PaymentWebhookControlPort,
} from "../../src/payments/index.js";
import type {
  PaymentFormCopy,
  PaymentFormSettlement,
  RecoveryPaymentSetupFormCopy,
  TransientSecret,
} from "../../src/payments/contracts/index.js";

describe("payments public DX exports", () => {
  it("brands non-empty strings with brandTransientSecret and refuses empty or non-string values", () => {
    const branded: TransientSecret = brandTransientSecret("session_token_value");
    expect(branded).toBe("session_token_value");

    expect(() => brandTransientSecret("")).toThrow(TypeError);
    expect(() => brandTransientSecret("" as string)).toThrow("transient_secret_nonempty_string_required");
    expect(() => brandTransientSecret("   ")).toThrow("transient_secret_nonempty_string_required");
    expect(() => brandTransientSecret("\t\n")).toThrow("transient_secret_nonempty_string_required");
    expect(() => brandTransientSecret(null as unknown as string)).toThrow(TypeError);
    expect(() => brandTransientSecret(123 as unknown as string)).toThrow(TypeError);
  });

  it("exposes PaymentWebhookControlPort, PaymentProviderExecutor, and neutral PaymentForm contracts", () => {
    const settlement: PaymentFormSettlement = "unknown";
    const copy: PaymentFormCopy = {
      payButton: "Pay now",
      payingButton: "Paying...",
      errorPrefix: "Payment error",
      loading: "Loading fields",
    };
    const recoveryCopy: RecoveryPaymentSetupFormCopy = {
      submitButton: "Save method",
      submittingButton: "Saving...",
      errorPrefix: "Setup error",
    };
    const executor: PaymentProviderExecutor = {
      async query() {
        return { rows: [] };
      },
    };
    const controlPortKeys: (keyof PaymentWebhookControlPort)[] = [
      "ingestPaymentEvent",
      "applyPaymentResult",
    ];

    expect(settlement).toBe("unknown");
    expect(copy.payButton).toBe("Pay now");
    expect(recoveryCopy.submitButton).toBe("Save method");
    expect(typeof executor.query).toBe("function");
    expect(controlPortKeys).toEqual(["ingestPaymentEvent", "applyPaymentResult"]);
  });
});
