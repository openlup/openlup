import { describe, expect, it } from "vitest";

import {
  returnApproveSchema,
  returnRejectSchema,
  returnRequestCreateSchema,
} from "./commerceReturnsPort.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("commerce returns contracts", () => {
  it("accepts a bounded request and keeps optional provider-neutral fields", () => {
    expect(returnRequestCreateSchema.parse({
      idempotencyKey: "return-request-1",
      orderId: ID,
      reasonCode: "damaged",
      customerNote: "Outer box was crushed",
      lines: [{ orderItemId: ID, sku: "SKU-1", quantity: 1, restockDisposition: "quarantine" }],
    })).toMatchObject({
      orderId: ID,
      reasonCode: "damaged",
      lines: [{ quantity: 1, restockDisposition: "quarantine" }],
    });
  });

  it("defaults approval to a full refund and rejects unsafe quantities", () => {
    expect(returnApproveSchema.parse({
      idempotencyKey: "return-approve-1",
      returnRequestId: ID,
    }).refundMode).toBe("full");

    expect(() => returnRequestCreateSchema.parse({
      idempotencyKey: "return-request-2",
      orderId: ID,
      reasonCode: "other",
      lines: [{ orderItemId: ID, quantity: 0 }],
    })).toThrow();
  });

  it("keeps rejection free of refund/provider fields", () => {
    expect(returnRejectSchema.parse({
      idempotencyKey: "return-reject-1",
      returnRequestId: ID,
      adminNote: "Outside policy",
    })).toEqual({
      idempotencyKey: "return-reject-1",
      returnRequestId: ID,
      adminNote: "Outside policy",
    });
  });
});
