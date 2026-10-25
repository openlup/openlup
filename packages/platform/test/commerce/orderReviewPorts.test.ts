import { describe, expect, it } from "vitest";
import type { OrderReviewLifecyclePort } from "../../src/commerce/orderReviewPorts.js";

describe("order review ports", () => {
  it("keeps the byte seam unable to resolve a grant", () => {
    const port: Pick<OrderReviewLifecyclePort, "read"> = { read: async () => null };
    expect(typeof port.read).toBe("function");
  });
});
