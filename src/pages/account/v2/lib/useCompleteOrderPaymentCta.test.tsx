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

import { useCompleteOrderPaymentCta } from "./useCompleteOrderPaymentCta";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  navigate.mockReset();
  startCheckoutRecovery.mockReset();
});

describe("useCompleteOrderPaymentCta", () => {
  it("deep-links to checkout recovery when the order is recoverable", async () => {
    startCheckoutRecovery.mockResolvedValue({ recoverable: true, token: "raw token/+=" });
    const { result } = renderHook(() => useCompleteOrderPaymentCta("session-token"));

    result.current(ORDER_ID);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(startCheckoutRecovery).toHaveBeenCalledWith("session-token", { orderId: ORDER_ID });
    expect(navigate).toHaveBeenCalledWith(
      `/konto/dokoncz-platnosc?token=${encodeURIComponent("raw token/+=")}`,
    );
  });

  it("routes a dead one-time order CTA to fresh checkout", async () => {
    startCheckoutRecovery.mockResolvedValue({ recoverable: false, fallback: "fresh_checkout" });
    const { result } = renderHook(() => useCompleteOrderPaymentCta("session-token"));

    result.current(ORDER_ID);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(navigate).toHaveBeenCalledWith("/skomponuj-pakiet");
  });

  it("keeps a dead subscription first-cycle order CTA in account", async () => {
    startCheckoutRecovery.mockResolvedValue({ recoverable: false, fallback: "fresh_checkout" });
    const { result } = renderHook(() => useCompleteOrderPaymentCta("session-token"));

    result.current(ORDER_ID, { hasSubscriptionContext: true });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(navigate).toHaveBeenCalledWith("/konto");
  });

  it("keeps subscription context in account when recovery start throws", async () => {
    startCheckoutRecovery.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useCompleteOrderPaymentCta("session-token"));

    result.current(ORDER_ID, { hasSubscriptionContext: true });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(navigate).toHaveBeenCalledWith("/konto");
  });
});
