import { afterEach, describe, expect, it, vi } from "vitest";
import { requestBff } from "@/lib/bff/client";
import {
  verifyCommercePaymentNow,
  verifyCommercePaymentNowBounded,
} from "./paymentVerifyClient";

vi.mock("@/lib/bff/client", () => ({
  requestBff: vi.fn(),
}));

const REQUEST = {
  orderId: "11111111-1111-4111-8111-111111111111",
  paymentIntentId: "44444444-4444-4444-8444-444444444444",
  clientId: "22222222-2222-4222-8222-222222222222",
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("verifyCommercePaymentNow", () => {
  it("POSTs the identity triple to the payment-verify route", async () => {
    vi.mocked(requestBff).mockResolvedValueOnce({ status: "failed", verified: true, applied: true });

    const result = await verifyCommercePaymentNow(REQUEST);

    expect(result).toEqual({ status: "failed", verified: true, applied: true });
    expect(requestBff).toHaveBeenCalledWith(
      "/api/bff/commerce/payment-verify",
      expect.anything(),
      expect.objectContaining({ method: "POST", body: REQUEST }),
    );
  });
});

describe("verifyCommercePaymentNowBounded", () => {
  it("resolves null when the request fails (navigation must not block)", async () => {
    vi.mocked(requestBff).mockRejectedValueOnce(new Error("network"));
    await expect(verifyCommercePaymentNowBounded(REQUEST)).resolves.toBeNull();
  });

  it("resolves null after the timeout when the request hangs", async () => {
    vi.useFakeTimers();
    vi.mocked(requestBff).mockReturnValueOnce(new Promise(() => {}));

    const pending = verifyCommercePaymentNowBounded(REQUEST, 1000);
    await vi.advanceTimersByTimeAsync(1001);

    await expect(pending).resolves.toBeNull();
  });

  it("passes through a fast response", async () => {
    vi.mocked(requestBff).mockResolvedValueOnce({ status: "pending", verified: true, applied: false });
    await expect(verifyCommercePaymentNowBounded(REQUEST)).resolves.toEqual({
      status: "pending",
      verified: true,
      applied: false,
    });
  });
});
