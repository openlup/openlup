import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

vi.mock("@/lib/i18nRoutes", () => ({
  useLocalizedPath: () => (key: string) =>
    key === "checkoutRecovery"
      ? "/konto/dokoncz-platnosc"
      : key === "customerDashboard"
        ? "/konto"
        : "/skomponuj-pakiet",
}));

const startCheckoutRecovery = vi.fn();
vi.mock("@/domains/commerce/checkoutRecoveryClient", () => ({
  startCheckoutRecovery: (...args: unknown[]) => startCheckoutRecovery(...args),
}));

import { useCheckoutRecoveryCta } from "./useCheckoutRecoveryCta";

const SUBSCRIPTION_ID = "55555555-5555-4555-8555-555555555555";

afterEach(() => {
  navigate.mockReset();
  startCheckoutRecovery.mockReset();
});

describe("useCheckoutRecoveryCta (W5)", () => {
  it("does nothing without a subscriptionId", () => {
    const { result } = renderHook(() => useCheckoutRecoveryCta("token", undefined));
    result.current();
    expect(startCheckoutRecovery).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("deep-links into the W4 pay-page with the minted token on success", async () => {
    startCheckoutRecovery.mockResolvedValue({ recoverable: true, token: "raw token/+=" });
    const { result } = renderHook(() => useCheckoutRecoveryCta("session-token", SUBSCRIPTION_ID));

    result.current();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(startCheckoutRecovery).toHaveBeenCalledWith("session-token", {
      subscriptionId: SUBSCRIPTION_ID,
    });
    // Token is URL-encoded into the deep-link query.
    expect(navigate).toHaveBeenCalledWith(
      `/konto/dokoncz-platnosc?token=${encodeURIComponent("raw token/+=")}`,
    );
  });

  it("keeps subscription customers in account when nothing is recoverable", async () => {
    startCheckoutRecovery.mockResolvedValue({ recoverable: false, fallback: "fresh_checkout" });
    const { result } = renderHook(() => useCheckoutRecoveryCta("session-token", SUBSCRIPTION_ID));

    result.current();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(navigate).toHaveBeenCalledWith("/konto");
  });

  it("keeps subscription customers in account when the mint call throws (flag off / network)", async () => {
    startCheckoutRecovery.mockRejectedValue(new Error("UPSTREAM_UNAVAILABLE"));
    const { result } = renderHook(() => useCheckoutRecoveryCta("session-token", SUBSCRIPTION_ID));

    result.current();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(navigate).toHaveBeenCalledWith("/konto");
  });
});
