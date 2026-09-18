import { describe, expect, it } from "vitest";
import {
  paymentExecutionBaseContractInput,
  validatePaymentExecutionContractResult,
} from "@openlup/core/testing";

describe("testing standalone", () => {
  it("validates a smoke-only reference adapter without exporting a runner", async () => {
    const exampleAdapter = {
      async execute(input: typeof paymentExecutionBaseContractInput) {
        return {
          provider: "example_pay",
          providerAttemptId: "attempt_example",
          providerSessionId: null,
          attemptStatus: "sent_to_provider",
          nextActionKind: "redirect",
          requestPayload: {
            providerIdempotencyKey: input.providerIdempotencyKey,
            providerRequestFingerprint: input.providerRequestFingerprint,
          },
          responsePayload: {
            providerAttemptId: "attempt_example",
          },
          rawProviderPayload: {
            safe: true,
          },
        } as const;
      },
    };

    const result = await exampleAdapter.execute(paymentExecutionBaseContractInput);
    const validation = validatePaymentExecutionContractResult({
      input: paymentExecutionBaseContractInput,
      expectedProvider: "example_pay",
      allowedNextActionKinds: ["redirect"],
      sensitiveValues: ["example_secret"],
      result,
    });

    expect(validation).toEqual({ ok: true, issues: [] });
  });

  it("validates payment execution contract results without Vitest coupling", () => {
    const validation = validatePaymentExecutionContractResult({
      input: paymentExecutionBaseContractInput,
      expectedProvider: "example_pay",
      allowedNextActionKinds: ["redirect"],
      sensitiveValues: ["example_secret"],
      result: {
        provider: "example_pay",
        providerAttemptId: "attempt_example",
        providerSessionId: null,
        attemptStatus: "sent_to_provider",
        nextActionKind: "redirect",
        requestPayload: {
          providerIdempotencyKey: paymentExecutionBaseContractInput.providerIdempotencyKey,
          providerRequestFingerprint: paymentExecutionBaseContractInput.providerRequestFingerprint,
        },
        responsePayload: {
          providerAttemptId: "attempt_example",
        },
        rawProviderPayload: {
          safe: true,
        },
      },
    });

    expect(validation).toEqual({ ok: true, issues: [] });
  });

  it("reports portable issue codes for failed payment execution checks", () => {
    const validation = validatePaymentExecutionContractResult({
      input: paymentExecutionBaseContractInput,
      expectedProvider: "example_pay",
      sensitiveValues: ["example_secret"],
      result: {
        provider: "other_pay",
        providerAttemptId: null,
        providerSessionId: null,
        attemptStatus: "processing",
        nextActionKind: "redirect",
        requestPayload: {
          providerIdempotencyKey: paymentExecutionBaseContractInput.providerIdempotencyKey,
          providerRequestFingerprint: "wrong",
          note: "example_secret",
        },
        responsePayload: {},
      },
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) {
      throw new Error("Expected payment execution contract validation to fail.");
    }
    expect(validation.issues.map((issue) => issue.code)).toEqual([
      "provider_mismatch",
      "invalid_next_action_kind",
      "missing_provider_request_fingerprint",
      "sensitive_value_leaked",
    ]);
  });
});
