// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearReferenceSession,
  createReferenceSubscription,
  loadReferenceItems,
  readReferenceSession,
  requestReferenceSignIn,
  saveReferenceSession,
  takeCallbackAccessToken,
} from "./subscriptionApi";

function response(data: unknown) { return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } }); }

afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState({}, "", "/"); });

describe("subscription reference API", () => {
  it("reads the declared sellable item and posts only the strict neutral subscription command", async () => {
    const catalog = {
      contractVersion: "catalog.sellable.v1",
      profile: { id: "local", brand: "Reference", country: "PL", currency: "PLN", locale: "en", timezone: "UTC" },
      items: [{ sku: "NORTHSTAR-REFILL-001", title: "Refill", unitPrice: { amountMinor: 1490, currency: "PLN" }, permittedPurchaseModes: ["subscription"] }],
    };
    const checkout = { version: "commerce.reference_checkout.v1", orderId: crypto.randomUUID(), clientId: crypto.randomUUID(), paymentIntentId: crypto.randomUUID(), paymentAttemptId: crypto.randomUUID(), paymentStatus: "succeeded", paymentAttemptStatus: "succeeded", replayed: false, total: { amountMinor: 1490, currency: "PLN" } };
    const fetcher = vi.fn().mockResolvedValueOnce(response(catalog)).mockResolvedValueOnce(response(checkout));
    vi.stubGlobal("fetch", fetcher);
    expect((await loadReferenceItems()).items[0]?.sku).toBe("NORTHSTAR-REFILL-001");
    const request = { command: {
      version: "commerce.checkout_command.v1" as const,
      idempotencyKey: "reference:fixed-key-123",
      mode: "subscription" as const,
      lines: [{ sku: "NORTHSTAR-REFILL-001", quantity: 1 }],
      customer: { firstName: "A", lastName: "Buyer", email: "a@example.com", phone: "123456789" },
      shippingAddress: { street: "Example 1", postalCode: "00-001", city: "Warsaw", country: "PL" },
      currency: "PLN", cadenceDays: 28,
    } };
    expect((await createReferenceSubscription(request)).paymentStatus).toBe("succeeded");
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/bff/catalog/items", "/api/bff/commerce/checkouts"]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(request);
    expect(fetcher.mock.calls[1]?.[1]?.headers.get("content-type")).toBe("application/json");
  });

  it("uses the profile's strict email-only magic-link request", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ accepted: true }));
    vi.stubGlobal("fetch", fetcher);
    await requestReferenceSignIn("  Buyer@Example.com ");
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/bff/customers/magic-link");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ email: "buyer@example.com" });
  });

  it("removes the callback token fragment before keeping a tab-scoped session", () => {
    window.history.replaceState({}, "", "/account/auth/callback#access_token=secret-value&type=magiclink");
    const token = takeCallbackAccessToken();
    expect(token).toBe("secret-value");
    expect(window.location.hash).toBe("");
    expect(window.history.state).toEqual({});
    saveReferenceSession({ accessToken: token!, accountId: "buyer-1" });
    expect(readReferenceSession()).toEqual({ accessToken: "secret-value", accountId: "buyer-1" });
    clearReferenceSession();
    expect(readReferenceSession()).toBeNull();
  });
});
