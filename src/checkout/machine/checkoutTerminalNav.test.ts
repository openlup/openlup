/** @vitest-environment jsdom -- exercises browser-path behavior (window/storage/DOM). */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { navigatePollerTerminal } from "./checkoutTerminalNav";
import { CHECKOUT_ATTEMPT_STORAGE_KEY } from "./checkoutAttemptStore";
import {
  CHECKOUT_CONTINUATION_KEY,
  LEGACY_CHECKOUT_CONTINUATION_KEY,
  persistCheckoutContinuation,
} from "./checkoutNavigation";

const PATHS = {
  thankYou: "/skomponuj-pakiet/dziekujemy",
  paymentFailed: "/skomponuj-pakiet/platnosc-nieudana",
  paymentPath: "/skomponuj-pakiet/platnosc",
};
const CTX = {
  orderId: "44444444-4444-4444-8444-444444444444",
  orderRef: "order_44444444-4444-4444-8444-444444444444",
  paymentIntentId: "55555555-5555-4555-8555-555555555555",
  clientId: "11111111-1111-4111-8111-111111111111",
};
const JOURNEY_ID = "checkout:11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  sessionStorage.clear();
});

describe("navigatePollerTerminal", () => {
  it("routes paid to thank-you and clears the attempt key + resume marker", () => {
    sessionStorage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, "x");
    persistCheckoutContinuation({ ...CTX, journeyId: JOURNEY_ID, actionKind: "embedded" });
    // Seeded by hand, because nothing writes this key any more: a terminal must
    // still sweep a marker the previous deploy left in a live browser session.
    sessionStorage.setItem(LEGACY_CHECKOUT_CONTINUATION_KEY, "{}");
    const navigate = vi.fn();

    navigatePollerTerminal("paid", CTX, navigate, PATHS);

    expect(navigate).toHaveBeenCalledWith(
      `/skomponuj-pakiet/dziekujemy?order=${encodeURIComponent(CTX.orderRef)}&orderId=${CTX.orderId}&clientId=${CTX.clientId}`,
    );
    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(CHECKOUT_CONTINUATION_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_CHECKOUT_CONTINUATION_KEY)).toBeNull();
  });

  it("hands a timeout off to the persistent payment-status page (webhook lag, NOT failure)", () => {
    sessionStorage.setItem(
      CHECKOUT_ATTEMPT_STORAGE_KEY,
      JSON.stringify({ fingerprint: "journey", key: "checkout:11111111-1111-4111-8111-111111111111" }),
    );
    const navigate = vi.fn();

    navigatePollerTerminal("timeout", CTX, navigate, PATHS);

    expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/skomponuj-pakiet/platnosc?order="));
    expect(navigate).not.toHaveBeenCalledWith(expect.stringContaining("platnosc-nieudana"));
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "{}").paymentAttempt).toBeUndefined();
  });

  it.each(["failed", "expired"] as const)(
    "routes a %s terminal to the failure page",
    (status) => {
      sessionStorage.setItem(
        CHECKOUT_ATTEMPT_STORAGE_KEY,
        JSON.stringify({ fingerprint: "journey", key: "checkout:11111111-1111-4111-8111-111111111111" }),
      );
      const navigate = vi.fn(() => {
        expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "{}").paymentAttempt).toBe(1);
      });

      navigatePollerTerminal(status, CTX, navigate, PATHS);

      expect(navigate).toHaveBeenCalledWith(expect.stringContaining("/skomponuj-pakiet/platnosc-nieudana"));
      if (status === "expired") {
        expect(navigate).toHaveBeenCalledWith(expect.stringContaining("reason=expired"));
      }
    },
  );
});
