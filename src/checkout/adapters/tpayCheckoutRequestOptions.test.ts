import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/customerAuthPortFactory", () => ({
  getCustomerAuthPort: () => ({ getSession }),
}));

import { checkoutRequestOptionsForTpay } from "./tpayCheckoutRequestOptions";

describe("checkoutRequestOptionsForTpay", () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  it("adds the customer bearer token for saved BLIK Tpay flows", async () => {
    getSession.mockResolvedValue({ accessToken: "access-token-123" });

    const options = await checkoutRequestOptionsForTpay({
      paymentProvider: "tpay",
      paymentExecution: {
        provider: "tpay",
        flow: "blik_one_click",
        savedMethodId: "22222222-2222-4222-8222-222222222222",
      },
    });

    expect((options.headers as Headers).get("Authorization")).toBe("Bearer access-token-123");
  });

  it("does not require auth for code-based Tpay flows", async () => {
    // ⛔ The invariant, and the one this wave must not break: no session, no
    // refusal. Guest checkout carries no token by definition. The assertion used
    // to be `getSession` was never called; that pinned the early return rather
    // than the rule, and the rule is what matters now that a session is looked up
    // for every flow.
    getSession.mockResolvedValue(null);

    await expect(checkoutRequestOptionsForTpay({
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
    })).resolves.toEqual({});
  });

  it("attaches the bearer to any flow when the buyer happens to have a session", async () => {
    // A logged-in buyer paying by card sent no token before this wave, so the
    // persist path could not tell them apart from a stranger who typed their
    // e-mail - and therefore could not let them save their own details.
    getSession.mockResolvedValue({ accessToken: "access-token-456" });

    const options = await checkoutRequestOptionsForTpay({
      paymentProvider: "stripe",
      paymentExecution: { provider: "stripe", flow: "card" },
    } as never);

    expect((options.headers as Headers).get("Authorization")).toBe("Bearer access-token-456");
  });

  it("still refuses a saved-BLIK submit that has no session", async () => {
    getSession.mockResolvedValue(null);

    await expect(checkoutRequestOptionsForTpay({
      paymentProvider: "tpay",
      paymentExecution: {
        provider: "tpay",
        flow: "blik_recurring_saved",
        savedMethodId: "22222222-2222-4222-8222-222222222222",
      },
    })).rejects.toThrow("saved_blik_session_required");
  });
});
