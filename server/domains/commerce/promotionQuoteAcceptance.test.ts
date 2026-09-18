import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQuoteRequest } from "./commerceCheckoutOrchestrationHelpers.js";
import { intent, quoteSnapshot } from "./commerceCheckoutHandler.testFixtures.js";
import {
  issuePromotionQuoteAcceptance,
  PROMOTION_ACCEPTANCE_MAX_TTL_MS,
  verifyPromotionQuoteAcceptance,
  verifyPromotionQuoteAcceptanceWithOutcome,
} from "./promotionQuoteAcceptance.js";

const OLD_SECRET = "old-promotion-acceptance-secret-0000000001";
const NEW_SECRET = "new-promotion-acceptance-secret-0000000002";
const NOW = new Date("2026-07-14T10:00:00.000Z");
type Fixture = ReturnType<typeof fixture>;
type MutationInput = Fixture & { token: string };
const MUTATIONS: Array<[string, (input: MutationInput) => unknown]> = [
  ["signature", ({ token }) => `${token.slice(0, -1)}x`],
  ["email", ({ request }) => ({ ...request, customerEligibilityContext: { email: "other@example.com" } })],
  ["promo", ({ request }) => ({ ...request, promoCodes: ["OTHER80"] })],
  ["quantity", ({ request }) => ({
    ...request,
    lines: request.lines.map((line) => ({ ...line, quantity: line.quantity + 1 })),
  })],
  ["quote", ({ quote }) => ({
    ...quote,
    totalGross: { ...quote.totalGross, amountMinor: quote.totalGross.amountMinor + 1 },
  })],
];

afterEach(() => vi.restoreAllMocks());

describe("promotion quote acceptance", () => {
  it("honors a signed quote through the 72h drain boundary but not at expiry", () => {
    const { request, quote } = fixture();
    const token = issuePromotionQuoteAcceptance({ request, quote, keyring: { current: OLD_SECRET }, now: NOW });
    expect(token).toBeTruthy();
    expect(verify(token!, request, quote, new Date(NOW.getTime() + PROMOTION_ACCEPTANCE_MAX_TTL_MS - 1))).toBe(true);
    expect(verify(token!, request, quote, new Date(NOW.getTime() + PROMOTION_ACCEPTANCE_MAX_TTL_MS))).toBe(false);
  });

  it("caps drain expiry at promotion code valid_to", () => {
    const { request, quote } = fixture("2026-07-14T11:00:00.000Z");
    const token = issuePromotionQuoteAcceptance({ request, quote, keyring: { current: OLD_SECRET }, now: NOW })!;
    const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
    expect(payload.exp).toBe(Date.parse("2026-07-14T11:00:00.000Z"));
    expect(verify(token, request, quote, new Date("2026-07-14T10:59:59.999Z"))).toBe(true);
    expect(verify(token, request, quote, new Date("2026-07-14T11:00:00.000Z"))).toBe(false);
  });

  it("accepts the previous signing key during rotation", () => {
    const { request, quote } = fixture();
    const token = issuePromotionQuoteAcceptance({ request, quote, keyring: { current: OLD_SECRET }, now: NOW })!;
    expect(verifyPromotionQuoteAcceptance({
      token, request, quote, expectedTotal: quote.totalGross,
      keyring: { current: NEW_SECRET, previous: OLD_SECRET }, now: NOW,
    })).toBe(true);
    expect(verifyPromotionQuoteAcceptanceWithOutcome({
      token, request, quote, expectedTotal: quote.totalGross,
      keyring: { current: NEW_SECRET, previous: OLD_SECRET }, now: NOW,
    })).toMatchObject({
      accepted: true,
      reason: "accepted",
      keySlot: "previous",
      expiryBucket: "24_72h",
    });
  });

  it("classifies expiry only after a valid signature and never exposes a key slot for tampering", () => {
    const { request, quote } = fixture("2026-07-14T11:00:00.000Z");
    const token = issuePromotionQuoteAcceptance({ request, quote, keyring: { current: OLD_SECRET }, now: NOW })!;
    expect(verifyPromotionQuoteAcceptanceWithOutcome({
      token, request, quote, expectedTotal: quote.totalGross,
      keyring: { current: OLD_SECRET }, now: new Date("2026-07-14T11:00:00.000Z"),
    })).toEqual({ accepted: false, reason: "expired", keySlot: "current", expiryBucket: "expired" });
    expect(verifyPromotionQuoteAcceptanceWithOutcome({
      token: `${token.slice(0, -1)}x`, request, quote, expectedTotal: quote.totalGross,
      keyring: { current: OLD_SECRET }, now: NOW,
    })).toEqual({ accepted: false, reason: "signature_invalid", keySlot: "none", expiryBucket: "none" });
  });

  it("allows at most 60 seconds of issuer clock skew", () => {
    const { request, quote } = fixture();
    const token = issuePromotionQuoteAcceptance({
      request, quote, keyring: { current: OLD_SECRET }, now: NOW,
    })!;
    expect(verify(token, request, quote, new Date(NOW.getTime() - 60_000))).toBe(true);
    expect(verify(token, request, quote, new Date(NOW.getTime() - 60_001))).toBe(false);
  });

  it.each(MUTATIONS)("rejects tampered %s binding", (_kind, mutate) => {
    const fixtureValue = fixture();
    const token = issuePromotionQuoteAcceptance({
      ...fixtureValue, keyring: { current: OLD_SECRET }, now: NOW,
    })!;
    const changed = mutate({ ...fixtureValue, token }) as unknown;
    const request = _kind === "email" || _kind === "promo" || _kind === "quantity"
      ? changed as typeof fixtureValue.request : fixtureValue.request;
    const quote = _kind === "quote" ? changed as typeof fixtureValue.quote : fixtureValue.quote;
    const changedToken = _kind === "signature" ? changed as string : token;
    expect(verify(changedToken, request, quote, NOW)).toBe(false);
  });

  it("keeps raw code, customer email, secrets and token out of logs and payload", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { request, quote } = fixture();
    const token = issuePromotionQuoteAcceptance({ request, quote, keyring: { current: OLD_SECRET }, now: NOW })!;
    verify(token, request, quote, NOW);
    const payload = Buffer.from(token.split(".")[0]!, "base64url").toString("utf8");
    expect(payload).not.toContain("SAVE80");
    expect(payload).not.toContain("anna@example.com");
    expect(payload).not.toContain(OLD_SECRET);
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls])).not.toContain(token);
  });

  it("excludes presentation-only rejection details from signed checkout binding", () => {
    const { request, quote } = fixture();
    const withDetails = {
      ...quote,
      codeRejectionDetails: [{
        code: "SCOPE80",
        reason: "scope_not_applicable" as const,
        allowedScopes: ["one_time" as const],
      }],
    };
    const token = issuePromotionQuoteAcceptance({ request, quote, keyring: { current: OLD_SECRET }, now: NOW })!;

    expect(issuePromotionQuoteAcceptance({
      request, quote: withDetails, keyring: { current: OLD_SECRET }, now: NOW,
    })).toBe(token);
    expect(verify(token, request, withDetails, NOW)).toBe(true);
  });
});

function fixture(validTo = "2026-07-20T00:00:00.000Z") {
  const checkoutIntent = { ...intent(), promoCodes: ["SAVE80"], visitorId: "visitor-1" };
  const request = buildQuoteRequest(checkoutIntent, { petId: "22222222-2222-4222-8222-222222222222" });
  const base = quoteSnapshot({ amountMinor: 2_000, currency: "PLN" }).quote;
  const quote = {
    ...base,
    discounts: [{
      promotionId: "33333333-3333-4333-8333-333333333333",
      code: "SAVE80",
      appliesTo: "order_total" as const,
      amountOffMinor: 8_000,
      reasonCode: "promotion_code_v2",
      promotionEngineVersion: "promotion-engine.v2" as const,
      promotionCodeId: "44444444-4444-4444-8444-444444444444",
      promotionCodeRevision: 3,
      promotionDefinitionFingerprint: "a".repeat(64),
      promotionCodeScopes: ["one_time" as const],
      promotionMinimumReferenceMinor: 0,
      promotionCodeValidTo: validTo,
      promotionBenefitKind: "target_percentage" as const,
      promotionBenefitValueBps: 8_000,
      floorApplied: false,
    }],
  };
  return { request, quote };
}

function verify(token: string, request: ReturnType<typeof fixture>["request"], quote: ReturnType<typeof fixture>["quote"], now: Date) {
  return verifyPromotionQuoteAcceptance({
    token, request, quote, expectedTotal: quote.totalGross,
    keyring: { current: OLD_SECRET }, now,
  });
}
