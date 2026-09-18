import { describe, expect, it } from "vitest";

import { paymentStatusContinuationRequestSchema } from "./paymentContinuationContracts.js";

const BASE_REQUEST = {
  orderId: "11111111-1111-4111-8111-111111111111",
  paymentIntentId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
};

describe("payment continuation query contract", () => {
  it("accepts ordinary status reads and an optional exact checkout journey", () => {
    expect(paymentStatusContinuationRequestSchema.safeParse(BASE_REQUEST).success).toBe(true);
    expect(paymentStatusContinuationRequestSchema.safeParse({
      ...BASE_REQUEST,
      journeyId: "checkout:44444444-4444-4444-8444-444444444444",
    }).success).toBe(true);
  });

  it.each(["copied", "checkout:not-a-uuid", "checkout:44444444-4444-4444-4444-444444444444:extra"])(
    "rejects a malformed journey query: %s",
    (journeyId) => {
      expect(paymentStatusContinuationRequestSchema.safeParse({
        ...BASE_REQUEST,
        journeyId,
      }).success).toBe(false);
    },
  );
});
