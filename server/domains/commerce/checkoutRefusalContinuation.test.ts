import { describe, expect, it, vi } from "vitest";
import { mintCheckoutRefusalContinuation } from "./checkoutRefusalContinuation.js";
import { createCheckoutPaymentContinuationCodec } from "./checkoutPaymentContinuationCredential.js";

const ids = { journeyId: "checkout:55555555-5555-4555-8555-555555555555", clientId: "22222222-2222-4222-8222-222222222222",
  orderId: "11111111-1111-4111-8111-111111111111", paymentIntentId: "33333333-3333-4333-8333-333333333333",
  paymentAttemptId: "44444444-4444-4444-8444-444444444444" };
function fixture() {
  return { journeyId: ids.journeyId, clientId: ids.clientId, requestRail: "stripe", res: { setHeader: vi.fn() }, mint: vi.fn(),
    response: { status: "failed" }, result: { ...ids, executionRail: "stripe", continuationActionOrigin: "fresh_execution" as const,
      status: "started", runtimePaymentStatus: "failed", paymentAttemptStatus: "failed" } };
}

describe("fresh refusal continuation", () => {
  it.each(["stripe", "tpay"] as const)("mints a verifiable bounded credential for fresh %s refusal", (rail) => {
    const codec = createCheckoutPaymentContinuationCodec("synthetic-test-root-at-least-32-bytes")!;
    const input = fixture();
    input.requestRail = rail; input.result.executionRail = rail;
    input.mint.mockImplementation((res, value) => res.setHeader("Set-Cookie", codec.issue(value).setCookie));
    mintCheckoutRefusalContinuation(input);
    expect(input.mint).toHaveBeenCalledTimes(1);
    const cookie = input.res.setHeader.mock.calls[0]![1];
    expect(codec.verifyCookieHeader(cookie)).toMatchObject({ ...ids, executionRail: rail });
    expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict");
  });

  it("allows the explicit none action as a settled refusal", () => {
    const input = fixture();
    mintCheckoutRefusalContinuation({ ...input, response: { status: "failed", clientAction: { kind: "none" } } });
    expect(input.mint).toHaveBeenCalledTimes(1);
  });

  it.each([
    { continuationActionOrigin: null }, // replay and trusted-no-dispatch pre-transaction failures
    { runtimePaymentStatus: "pending" }, { runtimePaymentStatus: undefined },
    { paymentAttemptStatus: "created" }, { paymentAttemptStatus: "blocked_preflight" },
    { paymentAttemptStatus: "succeeded" }, { paymentAttemptStatus: undefined },
    { paymentAttemptId: null }, { paymentAttemptId: "" }, { paymentIntentId: "" }, { orderId: "" },
    { executionRail: "tpay" }, { executionRail: "unknown" },
  ])("does not mint for unproven or incompatible failure %j", (override) => {
    const input = fixture();
    mintCheckoutRefusalContinuation({ ...input, result: { ...input.result, ...override } });
    expect(input.mint).not.toHaveBeenCalled(); expect(input.res.setHeader).not.toHaveBeenCalled();
  });

  it.each(["pending", "succeeded", "price_changed"])("does not mint for public response %s", (status) => {
    const input = fixture();
    mintCheckoutRefusalContinuation({ ...input, response: { status } });
    expect(input.mint).not.toHaveBeenCalled();
  });

  it("leaves actionable continuation to its existing path", () => {
    const input = fixture();
    mintCheckoutRefusalContinuation({ ...input, response: { status: "failed", clientAction: { kind: "redirect", url: "https://example.test/pay" } } });
    expect(input.mint).not.toHaveBeenCalled();
  });

  it("keeps a settled refusal usable if optional signing is absent or fails", () => {
    const input = fixture();
    expect(() => mintCheckoutRefusalContinuation({ ...input, mint: undefined })).not.toThrow();
    input.mint.mockImplementation(() => { throw new Error("signing unavailable"); });
    expect(() => mintCheckoutRefusalContinuation(input)).not.toThrow();
    expect(input.res.setHeader).not.toHaveBeenCalled();
  });
});
