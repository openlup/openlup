import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_CONTRACT_VERSION } from "./checkoutContracts.js";
import { getPaymentRecoveryStatus } from "./paymentRecoveryGuidanceClient.js";
import { PAYMENT_RECOVERY_GUIDANCE_HEADER } from "./paymentRecoveryGuidanceContracts.js";
import { PAYMENT_FAILURE_DISPLAY_HEADER } from "./paymentFailureDisplayContracts.js";

const request = { orderId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
  paymentIntentId: "33333333-3333-4333-8333-333333333333", journeyId: "checkout:55555555-5555-4555-8555-555555555555" };
function payload() {
  return { contractVersion: CHECKOUT_CONTRACT_VERSION, orderId: request.orderId, paymentIntentId: request.paymentIntentId,
    status: "failed", orderStatus: "pending_payment", payment: { intentStatus: "failed", attemptStatus: "failed",
      paymentAttemptId: null, provider: null, providerPaymentId: null, updatedAt: "2026-09-11T08:00:00Z" },
    failureReason: "provider_declined", subscriptionActivation: { status: "not_applicable", subscriptionId: null }, nextAction: null };
}
function fetcherFor(data: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, data }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
}

describe("recovery guidance client transport", () => {
  it("negotiates both independent extensions, keeps credentials and sends opaque token only as bearer", async () => {
    const fetcher = fetcherFor(payload());
    const token = "rcv_synthetic-token";
    const headers = new Headers({ "X-Existing": "preserved", [PAYMENT_RECOVERY_GUIDANCE_HEADER]: "0", [PAYMENT_FAILURE_DISPLAY_HEADER]: "0" });
    await getPaymentRecoveryStatus(request, { fetcher, recoveryToken: token, headers, credentials: "include", method: "POST" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/bff/commerce/payment-status?${new URLSearchParams(request)}`);
    expect(String(url)).not.toContain(token); expect(String(url)).not.toContain("recoveryToken");
    expect(init).toMatchObject({ method: "GET", credentials: "include" });
    expect(init).not.toHaveProperty("recoveryToken");
    const actualHeaders = new Headers(init?.headers);
    expect(actualHeaders.get("Authorization")).toBe(`Bearer ${token}`);
    expect(actualHeaders.get(PAYMENT_RECOVERY_GUIDANCE_HEADER)).toBe("1");
    expect(actualHeaders.get(PAYMENT_FAILURE_DISPLAY_HEADER)).toBe("1");
    expect(actualHeaders.get("X-Existing")).toBe("preserved");
    expect(headers.get(PAYMENT_RECOVERY_GUIDANCE_HEADER)).toBe("0");
    expect(headers.get("Authorization")).toBeNull();
  });

  it("does not create bearer credentials or serialize an undefined journey for inline checkout", async () => {
    const fetcher = fetcherFor(payload());
    await getPaymentRecoveryStatus({ ...request, journeyId: undefined }, { fetcher });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).not.toContain("journeyId");
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
  });

  it.each([undefined, null, { version: 2, message: "private" }])("keeps valid old status readable for missing or malformed guidance %j", async (extension) => {
    const fetcher = fetcherFor({ ...payload(), ...(extension === undefined ? {} : { recoveryGuidance: extension }) });
    const result = await getPaymentRecoveryStatus(request, { fetcher });
    expect(result.status).toBe("failed");
    if (extension === undefined) expect(result).not.toHaveProperty("recoveryGuidance");
    else expect(result.recoveryGuidance).toBeNull();
  });

  it("rejects malformed base rather than treating it as an optional guidance failure", async () => {
    await expect(getPaymentRecoveryStatus(request, { fetcher: fetcherFor({ ...payload(), status: "invented", recoveryGuidance: {} }) }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
