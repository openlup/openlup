import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPromotionQuoteAcceptance } from "../../src/promotions/index.js";
import { verifySelectedPromotionQuoteAcceptance } from "../../src/promotions/promotionQuoteAcceptanceEnvelope.js";
import { acceptanceRequest, quoteSnapshot } from "./acceptanceFixtures.js";
import {
  issuePromotionQuoteAcceptance,
  PROMOTION_ACCEPTANCE_MAX_TTL_MS,
  verifyPromotionQuoteAcceptance,
  verifyPromotionQuoteAcceptanceWithOutcome,
} from "./bindingsFixtures.js";

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
  it("binds explicit offer review without commercial adjustments and separates token purposes", () => {
    const review = createPromotionQuoteAcceptance({
      purpose: "offer-review",
      projectRequest: (request: { promoCodes: string[]; revision: string; journey: string; delivery: string }) =>
        ({ revision: request.revision, journey: request.journey, delivery: request.delivery }),
    });
    const ordinary = createPromotionQuoteAcceptance({ projectRequest: () => ({ revision: "a", journey: "j", delivery: "d" }) });
    const adjusted = fixture().quote;
    const quote = { ...adjusted, discounts: [], discountTotalGross: { ...adjusted.discountTotalGross, amountMinor: 0 } };
    const request = { promoCodes: [], revision: "a", journey: "j", delivery: "d" };
    const input = { request, quote, expectedTotal: quote.totalGross, keyring: { current: OLD_SECRET }, now: NOW };
    const token = review.issuePromotionQuoteAcceptance(input)!;
    expect(token).toBeTypeOf("string");
    expect(ordinary.issuePromotionQuoteAcceptance(input)).toBeNull();
    expect(review.verifyPromotionQuoteAcceptance({ ...input, token })).toBe(true);
    for (const changed of [{ revision: "b" }, { journey: "other" }, { delivery: "other" }]) {
      expect(review.verifyPromotionQuoteAcceptance({ ...input, token, request: { ...request, ...changed } })).toBe(false);
    }
    expect(review.verifyPromotionQuoteAcceptance({
      ...input, token, quote: { ...quote, lines: quote.lines.map((line) => ({ ...line, sku: "different-item" })) },
    })).toBe(false);
    expect(ordinary.verifyPromotionQuoteAcceptanceWithOutcome({ ...input, token }).reason).toBe("signature_invalid");
    const withPromotion = { ...input, quote: adjusted };
    const promoToken = ordinary.issuePromotionQuoteAcceptance(withPromotion)!;
    expect(promoToken).toBeTypeOf("string");
    expect(review.verifyPromotionQuoteAcceptanceWithOutcome({ ...withPromotion, token: promoToken }).reason).toBe("signature_invalid");
  });

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
      token: token.replace(/(?<=\.)./, char => char === "A" ? "B" : "A"), request, quote, expectedTotal: quote.totalGross,
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
    expect(payload).not.toContain("subject-a@example.com");
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

describe("compatible v1 envelopes", () => {
  const projectedRequest = { actor: "demo-buyer", selection: "demo-offer" };
  const ownerQuoteDigest = "a".repeat(64);
  const purpose = "offer-review" as const;
  const request = { promoCodes: ["save80"] };
  const instances = [OLD_SECRET, NEW_SECRET].map((current, i) => ({
    keyring: i ? { current, previous: OLD_SECRET } : { current },
    reader: createPromotionQuoteAcceptance({ purpose, projectRequest: () => projectedRequest }),
  }));
  const { quote } = fixture();
  const getInput = (keyring = instances[0]!.keyring) => ({
    request, quote, expectedTotal: quote.totalGross, keyring, now: NOW,
  });
  const oldPayload = () => JSON.parse(Buffer.from(instances[0]!.reader.issuePromotionQuoteAcceptance(getInput())!.split(".")[0]!, "base64url").toString());
  const seal = (data: unknown) => signed(Buffer.from(JSON.stringify(data)));
  const signed = (bytes: Buffer) => {
    const encoded = bytes.toString("base64url");
    return `${encoded}.${createHmac("sha256", OLD_SECRET).update("openlup.offer-review.v1." + encoded).digest("base64url")}`;
  };
  const selectedInput = () => ({ ...getInput(), projectedRequest, promoCodes: ["  SAVE80 "], purpose, expectedOwnerQuoteDigest: ownerQuoteDigest });
  const neutral = (reason: string) => ({ accepted: false, reason, keySlot: "none", expiryBucket: "none" });

  it("preserves the exact issued legacy bytes and four factory methods", () => {
    const token = issuePromotionQuoteAcceptance({ ...fixture(), keyring: { current: OLD_SECRET }, now: NOW })!;
    expect(createHash("sha256").update(token).digest("hex")).toBe("e8af86e556af16c9440c13d423ca66c3c3a1b90f4a887ea507255306bc16c928");
    expect(Object.keys(instances[0]!.reader)).toEqual([
      "issuePromotionQuoteAcceptance", "issuePromotionQuoteAcceptanceWithOutcome",
      "verifyPromotionQuoteAcceptance", "verifyPromotionQuoteAcceptanceWithOutcome",
    ]);
  });

  it("reads independently signed v1 shapes across current and previous keys", () => {
    const { sectionBindings: _sections, ...payload } = oldPayload();
    const old = seal(payload), selected = seal({ ...payload, ownerQuoteDigest });
    for (const [{ keyring, reader }, keySlot] of instances.map((item, i) => [item, i ? "previous" : "current"] as const)) {
      const accepted = { accepted: true, reason: "accepted", keySlot, expiryBucket: "24_72h" };
      expect(reader.verifyPromotionQuoteAcceptanceWithOutcome({ ...getInput(keyring), token: old })).toEqual(accepted);
      expect(reader.verifyPromotionQuoteAcceptanceWithOutcome({ ...getInput(keyring), token: selected })).toEqual(neutral("malformed"));
      expect(verifySelectedPromotionQuoteAcceptance({ ...selectedInput(), keyring, token: selected })).toEqual(accepted);
      expect(verifySelectedPromotionQuoteAcceptance({ ...selectedInput(), keyring, token: old })).toEqual({ ...accepted, accepted: false, reason: "quote_mismatch" });
    }
  });

  it("authenticates purpose and scope before selected expiry, digest and money", () => {
    const payload = { ...oldPayload(), ownerQuoteDigest };
    const token = seal(payload);
    const expired = { ...selectedInput(), token, now: new Date(payload.exp) };
    const authorized = { keySlot: "current", expiryBucket: "24_72h", accepted: false };
    expect(verifySelectedPromotionQuoteAcceptance({ ...expired, purpose: undefined })).toEqual(neutral("signature_invalid"));
    expect(verifySelectedPromotionQuoteAcceptance({ ...expired, keyring: { current: NEW_SECRET } })).toEqual(neutral("unknown_key"));
    for (const changed of [{ ...projectedRequest, actor: "other-buyer" }, { ...projectedRequest, selection: "other-offer" }]) {
      expect(verifySelectedPromotionQuoteAcceptance({ ...expired, projectedRequest: changed })).toEqual(neutral("request_mismatch"));
    }
    expect(verifySelectedPromotionQuoteAcceptance({ ...expired, token: seal(oldPayload()), projectedRequest: {} })).toEqual(neutral("request_mismatch"));
    expect(verifySelectedPromotionQuoteAcceptance({ ...expired, promoCodes: ["DIFFERENT"] })).toEqual(neutral("code_mismatch"));
    expect(verifySelectedPromotionQuoteAcceptance(expired)).toEqual({ ...authorized, reason: "expired", expiryBucket: "expired" });
    expect(verifySelectedPromotionQuoteAcceptance({ ...selectedInput(), token, expectedOwnerQuoteDigest: "b".repeat(64) })).toEqual({ ...authorized, reason: "quote_mismatch" });
    const wrongMoney = { ...quote, totalGross: { ...quote.totalGross, amountMinor: quote.totalGross.amountMinor + 1 } };
    expect(verifySelectedPromotionQuoteAcceptance({ ...selectedInput(), token, quote: wrongMoney })).toEqual({ ...authorized, reason: "quote_mismatch", mismatchField: "totals" });
    expect(verifySelectedPromotionQuoteAcceptance({ ...selectedInput(), token, expectedTotal: wrongMoney.totalGross })).toEqual({ ...authorized, reason: "total_mismatch" });
    expect(verifySelectedPromotionQuoteAcceptance({ ...selectedInput(), token, expectedTotal: { ...quote.totalGross, currency: "XTS" } })).toEqual({ ...authorized, reason: "currency_mismatch" });
    const altered = seal({ ...payload, ownerQuoteDigest: "b".repeat(64) }).split(".")[0] + "." + token.split(".")[1];
    expect(verifySelectedPromotionQuoteAcceptance({ ...expired, token: altered })).toEqual(neutral("signature_invalid"));
  });

  it("rejects malformed envelopes in both readers without metadata", () => {
    const payload = { ...oldPayload(), ownerQuoteDigest };
    const token = seal(payload);
    const invalidUtf8 = Buffer.from(JSON.stringify(payload).replace('"XXX"', '"ÿXX"'), "latin1");
    const [encoded, signature] = token.split(".") as [string, string];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const noncanonicalSignature = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.slice(-1)) + 1];
    for (const malformed of ["", token + ".", token + "..anything", encoded + "=." + signature, encoded + "." + noncanonicalSignature,
      "a".repeat(8_301), "a".repeat(8_193) + "." + signature, token + "é", signed(invalidUtf8), signed(Buffer.from(JSON.stringify(payload) + "{}")),
      seal({ ...payload, ownerQuoteDigest: "A".repeat(64) }), seal({ ...payload, unexpected: true })]) {
      expect(verifySelectedPromotionQuoteAcceptance({ ...selectedInput(), token: malformed })).toEqual(neutral("malformed"));
      expect(instances[0]!.reader.verifyPromotionQuoteAcceptanceWithOutcome({ ...getInput(), token: malformed })).toEqual(neutral("malformed"));
    }
  });
});

function fixture(validTo = "2026-07-20T00:00:00.000Z") {
  const request = acceptanceRequest();
  const base = quoteSnapshot({ amountMinor: 2_000, currency: "XXX" }).quote;
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
