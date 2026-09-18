/** @vitest-environment jsdom -- exercises browser-path behavior (window/storage/DOM). */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePaymentRecoveryTokenFromUrl,
  clearPaymentRecoverySession,
  consumeCustomerReturnTo,
  CUSTOMER_RETURN_TO_STORAGE_KEY,
  PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY,
  PAYMENT_RECOVERY_COOKIE_NAME,
  PAYMENT_RECOVERY_TOKEN_STORAGE_KEY,
  readCustomerReturnTo,
  readPaymentRecoveryToken,
  savePaymentRecoveryToken,
  saveCustomerReturnTo,
} from "./customerRecoverySession";

afterEach(() => {
  vi.restoreAllMocks();
  clearPaymentRecoverySession();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("customer recovery session return-to normalization", () => {
  it("allows Polish and English customer account return targets", () => {
    saveCustomerReturnTo("/account/payment/recover");
    expect(window.sessionStorage.getItem(CUSTOMER_RETURN_TO_STORAGE_KEY)).toBe("/account/payment/recover");
    expect(consumeCustomerReturnTo()).toBe("/account/payment/recover");

    saveCustomerReturnTo("/konto/platnosc/napraw");
    expect(consumeCustomerReturnTo()).toBe("/konto/platnosc/napraw");
  });

  it("preserves query and hash and allows a callback target to override same-tab storage", () => {
    saveCustomerReturnTo("/konto?zamowienie=configurator");
    expect(readCustomerReturnTo()).toBe("/konto?zamowienie=configurator");
    expect(consumeCustomerReturnTo("/konto/zamowienie/status?orderId=abc#payment")).toBe(
      "/konto/zamowienie/status?orderId=abc#payment",
    );
    expect(readCustomerReturnTo()).toBeNull();
  });

  it("rejects non-customer and absolute return targets", () => {
    saveCustomerReturnTo("/admin");
    expect(consumeCustomerReturnTo()).toBeNull();

    saveCustomerReturnTo("https://evil.test/account");
    expect(consumeCustomerReturnTo()).toBeNull();

    saveCustomerReturnTo("/accountant");
    expect(consumeCustomerReturnTo()).toBeNull();

    saveCustomerReturnTo("/konto/../admin");
    expect(consumeCustomerReturnTo()).toBeNull();
  });
});

describe("payment recovery cross-tab continuity", () => {
  it("restores a short-lived recovery token in a new tab", () => {
    savePaymentRecoveryToken("opaque-token");
    window.sessionStorage.removeItem(PAYMENT_RECOVERY_TOKEN_STORAGE_KEY);

    expect(readPaymentRecoveryToken()).toBe("opaque-token");
    expect(window.sessionStorage.getItem(PAYMENT_RECOVERY_TOKEN_STORAGE_KEY)).toBe("opaque-token");
    expect(window.localStorage.getItem(PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY)).toBeNull();
  });

  it("keeps the local token when transfer to session storage fails", () => {
    const crossTabValue = JSON.stringify({
      token: "opaque-token",
      expiresAt: Date.now() + 60_000,
    });
    window.localStorage.setItem(PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY, crossTabValue);
    failSessionStorageWrites();

    expect(readPaymentRecoveryToken()).toBe("opaque-token");
    expect(window.sessionStorage.getItem(PAYMENT_RECOVERY_TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY)).toBe(crossTabValue);
  });

  it("removes the token from the URL when local storage succeeds despite a session failure", () => {
    window.history.replaceState(null, "", "/account/payment/recover?token=opaque-token&source=tpay#payment");
    failSessionStorageWrites();

    expect(capturePaymentRecoveryTokenFromUrl()).toBe(
      "/account/payment/recover?source=tpay#payment",
    );

    expect(window.location.href).toContain("/account/payment/recover?source=tpay#payment");
    expect(window.location.search).not.toContain("token=");
    expect(window.localStorage.getItem(PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY)).not.toBeNull();
  });

  it("uses a path-scoped cookie and strips the URL when both storage writes fail", () => {
    window.history.replaceState(null, "", "/account/payment/recover?token=opaque-token&source=tpay#payment");
    failSessionStorageWrites();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    const returnTo = capturePaymentRecoveryTokenFromUrl();
    expect(returnTo).toBe("/account/payment/recover?source=tpay#payment");
    expect(window.location.href).toContain("/account/payment/recover?source=tpay#payment");
    expect(window.location.search).not.toContain("token=");
    expect(document.cookie).toContain(`${PAYMENT_RECOVERY_COOKIE_NAME}=opaque-token`);
    expect(readPaymentRecoveryToken()).toBe("opaque-token");
    window.history.replaceState(null, "", `/sign-in?returnTo=${encodeURIComponent(returnTo ?? "")}`);
    expect(readCustomerReturnTo()).toBe(returnTo);

    expect(window.sessionStorage.getItem(PAYMENT_RECOVERY_TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY)).toBeNull();
  });

  it("rejects and removes an expired cross-tab token", () => {
    window.localStorage.setItem(PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY, JSON.stringify({
      token: "expired-token",
      expiresAt: Date.now() - 1,
    }));

    expect(readPaymentRecoveryToken()).toBeNull();
    expect(window.localStorage.getItem(PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY)).toBeNull();
  });

  it("clears both same-tab and cross-tab recovery state", () => {
    savePaymentRecoveryToken("opaque-token");
    clearPaymentRecoverySession();

    expect(readPaymentRecoveryToken()).toBeNull();
    expect(window.localStorage.getItem(PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY)).toBeNull();
  });

  it("degrades without throwing when browser storage rejects writes", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(() => savePaymentRecoveryToken("opaque-token")).not.toThrow();
  });
});

function failSessionStorageWrites(): void {
  vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
}
