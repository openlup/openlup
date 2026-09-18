import { describe, expect, it } from "vitest";
import { makePaymentPort } from "./commerceRuntimeService.fixtures.js";

describe("commerce runtime service fixtures", () => {
  it("provides durable prepared-attempt mocks for real-provider runtime tests", async () => {
    const paymentPort = makePaymentPort();

    await expect(paymentPort.prepareProviderAttempt()).resolves.toMatchObject({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      status: "created",
      replayed: false,
    });
    await expect(paymentPort.finalizeProviderAttempt({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      attemptStatus: "requires_action",
      providerAttemptId: "pi_real_1",
      providerSessionId: "pi_real_1",
      nextActionKind: "3ds_challenge",
    })).resolves.toMatchObject({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      status: "requires_action",
      providerAttemptId: "pi_real_1",
      providerSessionId: "pi_real_1",
      nextActionKind: "3ds_challenge",
    });
  });
});
