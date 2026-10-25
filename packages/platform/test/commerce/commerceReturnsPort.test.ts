import { describe, expect, it } from "vitest";

import {
  createCommerceReturnsSchemas,
  returnApproveSchema,
  returnRejectSchema,
  returnRequestCreateSchema,
} from "../../src/commerce/commerceReturnsPort.js";

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

// Neutral package defaults are the approved core set; reference policy is bound separately.
it("publishes only the neutral default request reason set", () => {
  expect(returnRequestCreateSchema.shape.reasonCode.options).toEqual([
    "damaged", "wrong_item", "not_as_described", "changed_mind", "other",
  ]);
});

it("binds a host reason set without widening accepted codes or changing field projection", () => {
  const { returnRequestCreateSchema: bound } = createCommerceReturnsSchemas(["damaged", "custom_reason"]);
  const input = { idempotencyKey: "return-request-1", orderId: ID, reasonCode: "custom_reason",
    lines: [{ orderItemId: ID, quantity: 1 }], customerNote: "  Example  ", extra: true };
  expect(bound.parse(input)).toStrictEqual({ idempotencyKey: "return-request-1", orderId: ID,
    reasonCode: "custom_reason", lines: [{ orderItemId: ID, quantity: 1 }], customerNote: "Example" });
  expect(bound.safeParse({ ...input, reasonCode: "unknown_reason" }).error?.issues).toStrictEqual([{
    code: "invalid_value", values: ["damaged", "custom_reason"], path: ["reasonCode"],
    message: 'Invalid option: expected one of "damaged"|"custom_reason"',
  }]);
  expect(returnRequestCreateSchema.safeParse(input).success).toBe(false);
});
