import { describe, expect, it, vi } from "vitest";
import { createPostgresCommerceReturnsPort } from "./returnsControl.js";

describe("Postgres commerce returns port", () => {
  it("maps a request into the public function and parses replay", async () => {
    const query = vi.fn(async () => ({ rows: [{ value: {
      returnRequestId: "11111111-1111-4111-8111-111111111111",
      status: "requested",
      replayed: true,
    } }] }));
    const port = createPostgresCommerceReturnsPort({ query });
    await expect(port.createRequest({
      idempotencyKey: "return-idem-1",
      orderId: "22222222-2222-4222-8222-222222222222",
      reasonCode: "damaged",
      lines: [{ orderItemId: "33333333-3333-4333-8333-333333333333", quantity: 1 }],
    })).resolves.toMatchObject({ status: "requested", replayed: true });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("commerce_return_request_create"),
      expect.arrayContaining(["return-idem-1"]),
    );
  });
});
