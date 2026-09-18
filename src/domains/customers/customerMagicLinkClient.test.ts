import { describe, expect, it, vi } from "vitest";
import { requestCustomerMagicLink } from "./customerMagicLinkClient";

describe("requestCustomerMagicLink", () => {
  it("POSTs to the customer magic-link BFF endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { accepted: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      requestCustomerMagicLink("buyer@example.com", "en", { fetcher }),
    ).resolves.toEqual({ accepted: true });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/customers/magic-link",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "buyer@example.com", locale: "en" }),
      }),
    );
  });

  it("passes a safe return target to the magic-link BFF", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { accepted: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await requestCustomerMagicLink("buyer@example.com", "pl", {
      fetcher,
      returnTo: "/konto/zamowienie/status?orderId=abc#payment",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/customers/magic-link",
      expect.objectContaining({
        body: JSON.stringify({
          email: "buyer@example.com",
          locale: "pl",
          returnTo: "/konto/zamowienie/status?orderId=abc#payment",
        }),
      }),
    );
  });
});
