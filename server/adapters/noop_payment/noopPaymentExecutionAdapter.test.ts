import { describe, expect, it } from "vitest";
import {
  describePaymentExecutionPortContract,
  paymentExecutionContractInput,
} from "../paymentExecutionPortContract.testFixtures.js";
import { PAYMENT_NEXT_ACTION_KINDS } from "../../../src/domains/payment/types.js";
import { createNoopPaymentExecutionAdapter } from "./noopPaymentExecutionAdapter.js";

describePaymentExecutionPortContract({
  name: "noop payment execution",
  createSubject: () => createNoopPaymentExecutionAdapter("noop_payment"),
  scenarios: [{
    allowedNextActionKinds: PAYMENT_NEXT_ACTION_KINDS,
    expectedProvider: "noop_payment",
    input: paymentExecutionContractInput,
    name: "normalizes no-op execution",
  }],
});

describe("noop payment execution adapter", () => {
  it("makes no provider call and returns deterministic hidden execution facts", async () => {
    const result = await createNoopPaymentExecutionAdapter("hidden_rehearsal").execute(paymentExecutionContractInput);

    expect(result).toMatchObject({
      provider: "hidden_rehearsal",
      providerAttemptId: null,
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      responsePayload: { providerCall: false },
    });
  });
});
