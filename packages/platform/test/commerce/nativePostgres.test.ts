import { expect, it, vi } from "vitest";
import {
  createPostgresCommerceOmsPort,
  createPostgresCommerceOmsControlPlane,
  createPostgresCommerceReturnsPort,
  createPostgresProviderExceptionHealPort,
} from "@openlup/platform/commerce/server/postgres";

it("keeps rich OMS reads as named refusals without querying the executor", () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const port = createPostgresCommerceOmsPort({ query });
  expect(() => port.listOrders({} as never)).toThrow("rich managed projection is unavailable");
  expect(() => port.getOrderDetail({} as never)).toThrow("rich managed projection is unavailable");
  expect(query).not.toHaveBeenCalled();
  expect(createPostgresCommerceOmsControlPlane({ query }).resolveOperator).toBeTypeOf("function");
  expect(createPostgresProviderExceptionHealPort({ query }).releaseDelivered).toBeTypeOf("function");
});

it("serializes return line arrays as JSON before handing them to the executor", async () => {
  const query = vi.fn(async () => ({ rows: [{ value: { returnRequestId: "return-a", status: "requested", replayed: false } }] }));
  const port = createPostgresCommerceReturnsPort({ query });
  await expect(port.createRequest({ idempotencyKey: "request-a", orderId: "order-a", reasonCode: "other",
    lines: [{ orderItemId: "item-a", quantity: 1 }] })).resolves.toEqual({ returnRequestId: "return-a", status: "requested", replayed: false });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("commerce_return_request_create"), [
    "request-a", "order-a", JSON.stringify([{ orderItemId: "item-a", sku: null, quantity: 1, restockDisposition: "restock" }]), "other", null, null,
  ]);
});
