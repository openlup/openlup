import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as promotions from "../../src/promotions/index.js";
import { commerceQuoteV2Schema } from "../../src/pricing/index.js";
import type { CommerceQuoteV2 } from "../../src/pricing/index.js";
import { currency, digest, minor, moneyRef, ref, uuid } from "../../src/pricing/quoteMoneyValidationV2.js";
import { bucket, expiresAt, fee, id, moneyGolden, sealQuote, taxDate } from "../pricing/quoteMoneyV2Fixtures.js";
import { acceptanceRequest, quoteSnapshot } from "./acceptanceFixtures.js";

const { issueQuoteAcceptanceTokenV2: issue, verifyQuoteAcceptanceTokenV2: verify } = promotions;
const key = "synthetic-quote-key-for-tests-only";
const nextKey = "synthetic-next-key-for-tests-only";
const purpose = "commerce.quote-acceptance.v2";
const nowMs = Date.parse(taxDate);
const cap = Date.parse(expiresAt);
const otherDigest = "c".repeat(64);
const owner = {
  installationRef: "installation:one", principalKind: "customer", principalRef: id(5), customerOrSessionRef: id(5),
} as const;
const money = {
  ...moneyGolden(), feeLines: [
    { ...fee("service-b", 2), scope: { kind: "order" as const } },
    { ...fee("service-a", 1), scope: { kind: "order" as const } },
  ], feeTotal: 3, payableMinor: 8,
};
const quote = sealQuote(money);
const scope = { owner, requestDigest: "b".repeat(64), quote, keyring: { current: key }, nowMs };
const accept = { ...scope, acceptanceRef: "acceptance:one" };
const show = (q: CommerceQuoteV2) => ({
  quoteDigest: q.quoteDigest, mandatoryFeeKeys: q.feeLines.map(line => line.feeKey),
  payable: { currency: q.currency, amountMinor: q.payableMinor },
});
const presentation = show(quote);
const mismatch = {
  kind: "refused", code: "quote_acceptance_mismatch", field: "/acceptanceToken",
  remedy: "Re-obtain valid acceptance from the authorized presentation path.",
};
const display = {
  kind: "refused", code: "mandatory_fee_requires_all_in_display", field: "/presentationRef",
  remedy: "Present the full payable and applicable fees and obtain fresh acceptance.",
};
const expired = {
  kind: "refused", code: "quote_acceptance_expired", field: "/acceptanceToken",
  remedy: "Obtain a fresh final presentation and acceptance.",
};
const goldenPresentation = "ba689fa625a12af4916b475311099d5e50723368b732af0eb2989f00158ff501";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function exact(actual: object, expected: object): void {
  expect(Reflect.ownKeys(actual).filter(key => key !== "stack")).toEqual(Reflect.ownKeys(expected).filter(key => key !== "stack"));
  expect(Object.getPrototypeOf(actual)).toBe(Object.getPrototypeOf(expected));
  expect(actual).toStrictEqual(expected);
  expect(Reflect.get(actual, "message")).toBe(Reflect.get(expected, "message"));
}

function throwsFixed(run: () => unknown, message: string): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(TypeError);
  exact(failure as TypeError, new TypeError(message));
}

function issued(input: Parameters<typeof issue>[0] = { ...accept, presentation }) {
  const result = issue(input);
  if (result.kind !== "issued") throw new Error(result.code);
  return result;
}

function body(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      const entries = Object.entries(item).sort(([left], [right]) => left < right ? -1 : Number(left > right));
      return Object.fromEntries(entries.map(([key, value]) => [key, sort(value)]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

function signSegment(encoded: string, prefix = purpose + "."): string {
  return encoded + "." + createHmac("sha256", key).update(prefix + encoded, "ascii").digest("base64url");
}
const signedText = (text: string) => signSegment(Buffer.from(text).toString("base64url"));
const signed = (payload: object) => signedText(canonical(payload));

afterEach(() => vi.restoreAllMocks());

it("pins the v2 wire and releases all signed claims only after authentication", () => {
  const fresh = issued();
  expect(fresh.presentationRef).toBe(goldenPresentation);
  expect(fresh.token).toHaveLength(1026);
  expect(sha(fresh.token)).toBe("0bb192640491d0e9db1ecc1eb8f226a4e40bda286aeb67aba98054e7a844fed2");
  const claims = {
    acceptanceRef: accept.acceptanceRef, exp: cap, kid: "be3086f53aa2aaf2", moneyDigest: quote.moneyDigest,
    moneyVersion: "commerce.order-money.v2", owner, presentationRef: goldenPresentation, purpose,
    quoteDigest: quote.quoteDigest, quoteId: quote.quoteId, requestDigest: scope.requestDigest, v: 2,
  };
  expect(body(fresh.token)).toStrictEqual(claims);
  expect(verify({ ...scope, ...fresh })).toStrictEqual({ kind: "verified", ...claims });

  const [encoded, signature] = fresh.token.split(".");
  const forged = encoded + "." + (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  exact(verify({ ...scope, ...fresh, token: forged }), mismatch);
});

it("keeps both v1 purposes separate from v2 in both directions", () => {
  const { token, presentationRef } = issued();
  const oldQuote = quoteSnapshot({ amountMinor: 2000, currency: "XXX" }).quote;
  const request = acceptanceRequest();
  const legacyInput = {
    request, keyring: scope.keyring, now: new Date(nowMs), expectedTotal: oldQuote.totalGross,
    quote: { ...oldQuote, discounts: [{
      promotionId: id(9), code: "SAVE80", appliesTo: "order_total" as const, amountOffMinor: 100,
      reasonCode: "promotion_code_v2", promotionEngineVersion: "promotion-engine.v2" as const,
    }] },
  };
  for (const legacyPurpose of [undefined, "offer-review"] as const) {
    const legacy = promotions.createPromotionQuoteAcceptance({ projectRequest: () => ["example"], purpose: legacyPurpose });
    const old = legacy.issuePromotionQuoteAcceptance(legacyInput);
    expect(old).toBeTypeOf("string");
    expect(legacy.verifyPromotionQuoteAcceptance({ ...legacyInput, token: old! })).toBe(true);
    expect(legacy.verifyPromotionQuoteAcceptanceWithOutcome({ ...legacyInput, token }))
      .toStrictEqual({ accepted: false, reason: "malformed", keySlot: "none", expiryBucket: "none" });
    exact(verify({ ...scope, token: old, presentationRef }), mismatch);
    const prefix = legacyPurpose ? "openlup.offer-review.v1." : "";
    exact(verify({ ...scope, token: signSegment(token.split(".")[0], prefix), presentationRef }), mismatch);
  }
});

it("enforces the exact exclusive cutoff after integrity and presentation", () => {
  const fresh = issued();
  expect(verify({ ...scope, ...fresh, nowMs: cap - 1 }).kind).toBe("verified");
  expect(issue({ ...accept, presentation, nowMs: cap - 1 }).kind).toBe("issued");
  for (const nowMs of [cap, cap + 1]) {
    exact(issue({ ...accept, presentation, nowMs }), expired);
    exact(verify({ ...scope, ...fresh, nowMs }), expired);
    exact(verify({ ...scope, ...fresh, nowMs, token: signed({ ...body(fresh.token), exp: cap - 1 }) }), mismatch);
    exact(verify({ ...scope, ...fresh, nowMs, token: fresh.token.slice(0, -1) }), mismatch);
    exact(verify({ ...scope, ...fresh, nowMs, presentationRef: otherDigest }), display);
    exact(issue({ ...accept, nowMs }), display);
  }
  const max = promotions.PROMOTION_ACCEPTANCE_MAX_TTL_MS;
  for (const ttl of [max, max + 1]) {
    const quote = sealQuote({ ...money, taxEvidence: { ...money.taxEvidence, expiresAt: new Date(nowMs + ttl).toISOString() } });
    const result = issue({ ...accept, quote, presentation: show(quote) });
    if (ttl === max) expect(result.kind).toBe("issued");
    else exact(result, expired);
  }
});

it.each([
  ["installationRef", "installation:two"], ["principalRef", id(6)], ["customerOrSessionRef", id(7)],
])("binds the owner coordinate %s", (field, value) => {
  const fresh = issued();
  const otherOwner = { ...owner, [field]: value };
  exact(verify({ ...scope, ...fresh, owner: otherOwner }), mismatch);
  exact(verify({ ...scope, ...fresh, token: signed({ ...body(fresh.token), owner: otherOwner }) }), mismatch);
});

it.each([
  ["purpose", "commerce.quote-acceptance.v1"], ["v", 1], ["kid", "f".repeat(16)], ["kid", undefined],
  ["requestDigest", otherDigest], ["quoteId", id(8)], ["quoteDigest", otherDigest],
  ["moneyVersion", "commerce.order-money.v1"], ["moneyDigest", otherDigest], ["acceptanceRef", ""],
  ["owner", { ...owner, principalKind: "checkout_session" }],
])("rejects independently changed signed %s (%j)", (field, value) => {
  const fresh = issued();
  const token = signed({ ...body(fresh.token), [field]: value });
  exact(verify({ ...scope, ...fresh, token }), mismatch);
});

it("binds checkout scope through the request digest and returns the issuer's acceptance reference", () => {
  const requestDigest = (scopeRef: string) => sha(canonical([owner, scopeRef, quote.quoteId]));
  const requestScope = { ...scope, requestDigest: requestDigest(id(10)) };
  const fresh = issued({ ...requestScope, acceptanceRef: "acceptance:two", presentation });
  expect(verify({ ...requestScope, ...fresh })).toMatchObject({ kind: "verified", acceptanceRef: "acceptance:two" });
  exact(verify({ ...requestScope, ...fresh, requestDigest: requestDigest(id(11)) }), mismatch);
  exact(verify({ ...requestScope, ...fresh, token: fresh.token.replace(/^[^.]/, "e") + "A" }), mismatch);
  exact(verify({ ...requestScope, ...fresh, token: signed({ ...body(fresh.token), acceptanceRef: undefined }) }), mismatch);
});

it("binds recurring references in both directions and survives current-to-previous rotation", () => {
  const recurringAcceptanceRef = "recurring:one";
  const fresh = issued({ ...accept, presentation, recurringAcceptanceRef });
  const plain = issued();
  expect(verify({ ...scope, ...fresh, recurringAcceptanceRef })).toMatchObject({ kind: "verified", recurringAcceptanceRef });
  exact(verify({ ...scope, ...fresh }), mismatch);
  exact(verify({ ...scope, ...fresh, recurringAcceptanceRef: "recurring:two" }), mismatch);
  exact(verify({ ...scope, ...plain, recurringAcceptanceRef }), mismatch);
  exact(verify({ ...scope, ...fresh, recurringAcceptanceRef, token: signed({ ...body(fresh.token), recurringAcceptanceRef: "recurring:other" }) }), mismatch);
  const keyring = { current: nextKey, previous: key };
  expect(verify({ ...scope, ...plain, keyring }).kind).toBe("verified");
  expect(verify({ ...scope, ...plain, keyring: { current: "", previous: key } }).kind).toBe("verified");
  expect(body(issued({ ...accept, presentation, keyring }).token).kid).toBe(sha(nextKey).slice(0, 16));
  exact(verify({ ...scope, ...plain, keyring: { current: nextKey } }), mismatch);
});

it("rejects freshly sealed destination and allocation changes with equal payable, and rejects estimates", () => {
  const fresh = issued();
  const [line, ...rest] = money.lines;
  const [share] = line.discountAllocations;
  for (const changed of [
    sealQuote({ ...money, destination: { ...money.destination, snapshotRef: id(8) } }),
    sealQuote({ ...money, lines: [{ ...line, discountAllocations: [{ ...share, allocationId: id(7) }] }, ...rest] }),
  ]) {
    expect(commerceQuoteV2Schema.safeParse(changed).success).toBe(true);
    expect(changed.payableMinor).toBe(quote.payableMinor);
    exact(verify({ ...scope, ...fresh, quote: changed }), mismatch);
  }
  const estimate = sealQuote(money, "estimate");
  expect(commerceQuoteV2Schema.safeParse(estimate).success).toBe(true);
  exact(issue({ ...accept, quote: estimate, presentation: show(estimate) }), mismatch);
  exact(verify({ ...scope, ...fresh, quote: estimate, token: signed({ ...body(fresh.token), quoteDigest: estimate.quoteDigest }) }), mismatch);
});

it.each([
  undefined, null, [], { ...presentation, extra: true },
  { ...presentation, quoteDigest: otherDigest }, { ...presentation, quoteDigest: "A".repeat(64) },
  { ...presentation, mandatoryFeeKeys: ["service-a"] },
  { ...presentation, mandatoryFeeKeys: ["service-a", "service-a"] },
  { ...presentation, mandatoryFeeKeys: ["service-a", "other"] },
  { ...presentation, mandatoryFeeKeys: ["service-a", "service-b", "other"] },
  { ...presentation, mandatoryFeeKeys: Array.from({ length: 257 }, () => "x") },
  { ...presentation, payable: { ...presentation.payable, extra: true } },
  { ...presentation, payable: { ...presentation.payable, amountMinor: 7 } },
  { ...presentation, payable: { ...presentation.payable, amountMinor: 8.5 } },
  { ...presentation, payable: { ...presentation.payable, amountMinor: Number.MAX_SAFE_INTEGER + 1 } },
  { ...presentation, payable: { ...presentation.payable, currency: "XTS" } },
])("refuses missing, unsupported or changed presentations (%j)", (value) => {
  exact(issue({ ...accept, presentation: value as typeof presentation }), display);
});

it("checks both presentation references and treats fee keys as a set", () => {
  expect(issue({ ...accept, presentation }).kind).toBe("issued");
  const fresh = issued();
  expect(issued({ ...accept, presentation: { ...presentation, mandatoryFeeKeys: ["service-a", "service-b"] } })).toStrictEqual(fresh);
  for (const presentationRef of [undefined, otherDigest]) {
    exact(verify({ ...scope, ...fresh, presentationRef }), display);
    exact(verify({ ...scope, ...fresh, token: signed({ ...body(fresh.token), presentationRef }) }), display);
  }
});

it("checks the full payable for a fee-free quote and a payable fee on free shipping", () => {
  const base = moneyGolden();
  const { amountMinor: _amountMinor, ...shipping } = bucket("shipping", 0);
  const freeShipping = sealQuote({
    ...base, deliveryBuckets: [{
      ...shipping, parts: [{ preDiscountMinor: 0, effectiveMinor: 0, discountAllocations: [], taxPositions: [],
        netMinor: 0, taxMinor: 0, lineTotalMinor: 0 }],
    }],
    feeLines: [fee("free-delivery-fee", 2)], feeTotal: 2, payableMinor: 7,
  });
  for (const quote of [sealQuote(base), freeShipping]) {
    const presentation = show(quote);
    const fresh = issued({ ...accept, quote, presentation });
    expect(verify({ ...scope, ...fresh, quote }).kind).toBe("verified");
    exact(issue({ ...accept, quote, presentation: { ...presentation,
      payable: { ...presentation.payable, amountMinor: quote.payableMinor - 1 },
    } }), display);
  }
  exact(issue({ ...accept, quote: freeShipping, presentation: { ...show(freeShipping), mandatoryFeeKeys: [] } }), display);
});

it.each([
  "", "a", "a".repeat(256), "a".repeat(257), "𐀀".repeat(128), "𐀀".repeat(129),
  "ref\u0000", "\uD800", "\uDC00", "line\nbreak",
])("pins token-only refs against landed pricing ref (%s)", value => {
  const expected = ref.safeParse(value).success;
  for (const input of [
    { ...accept, acceptanceRef: value }, { ...accept, recurringAcceptanceRef: value },
    { ...accept, owner: { ...owner, installationRef: value } },
  ]) {
    if (expected) expect(issue({ ...input, presentation }).kind).toBe("issued");
    else expect(() => issue({ ...input, presentation })).toThrowError(new TypeError("Supply a valid quote acceptance scope."));
  }
  const fresh = issued();
  if (expected) {
    const issuance = issued({ ...accept, presentation, acceptanceRef: value });
    expect(verify({ ...scope, ...issuance })).toMatchObject({ acceptanceRef: value });
  }
  if (!expected) exact(verify({ ...scope, ...fresh, token: signed({ ...body(fresh.token), acceptanceRef: value }) }), mismatch);
});

it("probes the landed quote money and identity validator boundaries", () => {
  const probe = (schema: { safeParse(value: unknown): { success: boolean } }, good: unknown[], bad: unknown[]) => {
    expect(good.map(value => schema.safeParse(value).success)).toEqual(good.map(() => true));
    expect(bad.map(value => schema.safeParse(value).success)).toEqual(bad.map(() => false));
  };
  probe(moneyRef, ["k", "x".repeat(128)], ["", "x".repeat(129), "\uD800"]);
  probe(minor, [0, Number.MAX_SAFE_INTEGER], [-0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]);
  probe(currency, ["XXX"], ["XX", "XXXX", "xxx", "XX\n"]);
  probe(uuid, [id(10)], ["", id(10).slice(1), id(10).replace("1234", "ABCD")]);
  probe(digest, ["a".repeat(64)], ["a".repeat(63), "A".repeat(64), "a".repeat(65)]);
});

it.each([
  ["issue clock", () => issue({ ...accept, presentation, nowMs: -1 }), "Supply a valid server clock."],
  ["verify clock", () => verify({ ...scope, ...issued(), nowMs: Number.MAX_SAFE_INTEGER + 1 }), "Supply a valid server clock."],
  ["key", () => issue({ ...accept, presentation, keyring: { current: key.slice(0, 31) } }), "Configure a valid current quote acceptance signing key."],
  ["issue scope", () => issue({ ...accept, presentation, requestDigest: "b".repeat(63) }), "Supply a valid quote acceptance scope."],
  ["issue owner", () => issue({ ...accept, presentation, owner: { ...owner, principalRef: "INVALID" } }), "Supply a valid quote acceptance scope."],
  ["issue principal kind", () => issue({ ...accept, presentation, owner: { ...owner, principalKind: "checkout_session" as never } }), "Supply a valid quote acceptance scope."],
  ["verify scope", () => verify({ ...scope, ...issued(), recurringAcceptanceRef: "a".repeat(257) }), "Supply a valid quote acceptance scope."],
  ["verify owner", () => verify({ ...scope, ...issued(), owner: { ...owner, customerOrSessionRef: "INVALID" } }), "Supply a valid quote acceptance scope."],
  ["issue quote", () => issue({ ...accept, presentation, quote: { ...quote, payableMinor: 99 } }), "Supply a sealed final quote from its owner."],
  ["verify quote", () => verify({ ...scope, ...issued(), quote: { ...quote, payableMinor: 99 } }), "Supply a sealed final quote from its owner."],
] as const)("throws a fixed programming error for invalid %s", (_label, run, message) => throwsFixed(run, message));

it("enforces wire bounds before reading quote, keyring or decoding", () => {
  const touches = (label: string) => { throw new Error(label); };
  const guarded = {
    ...scope, get quote(): never { return touches("quote"); },
    get keyring(): never { return touches("keyring"); },
  };
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  const split = vi.spyOn(String.prototype, "split");
  const oversized = "A".repeat(8193) + "." + "A".repeat(43);
  for (const token of [42, null, oversized, "A".repeat(8237), "A".repeat(8193) + ".A"]) {
    const input = Object.create(null, { ...Object.getOwnPropertyDescriptors(guarded), token: { value: token } });
    exact(verify(input), mismatch);
  }
  expect(decode).not.toHaveBeenCalled();
  expect(split.mock.contexts).not.toContain(oversized);
  const input = Object.create(null, { ...Object.getOwnPropertyDescriptors(guarded),
    token: { value: "A".repeat(8192) + "." + "A".repeat(43) },
  });
  exact(verify(input), mismatch);
  expect(decode).toHaveBeenCalledOnce();
});

it("refuses malformed, noncanonical and unknown wire fields even with a test-key MAC", () => {
  const fresh = issued();
  const [encoded, mac] = fresh.token.split(".");
  const claims = body(fresh.token);
  const text = canonical(claims);
  for (const token of [
    "", true, ".", "." + mac, encoded + "=." + mac, encoded + "." + mac + "=", encoded + "." + mac + ".",
    encoded + "." + mac.slice(0, -1), encoded + "." + mac + "A", encoded + "." + mac + "\n",
    encoded + "." + mac.slice(0, -1) + "B", "A." + mac, signedText(text + "\n"),
    signSegment(Buffer.from([0xff]).toString("base64url")), signedText("\uFEFF" + text),
    signedText(text.replace('"v":2', '"v":2,"v":2')),
    signedText(text.replace('"principalKind":"customer"', '"principalKind":"customer","principalKind":"customer"')),
    signed({ ...claims, extra: "unknown" }), signed({ ...claims, owner: { ...owner, extra: "unknown" } }),
  ]) exact(verify({ ...scope, ...fresh, token }), mismatch);
});

it("executes the server guide recipe through the promotions entry", () => {
  const guide = readFileSync(new URL("../../../core/docs/guide/how-to/build/quote-prices.md", import.meta.url), "utf8");
  const recipe = guide.split("## Accept a final v2 quote")[1]?.split(/\n## /u)[0]?.match(/```ts\n([\s\S]*?)\n```/u)?.[1];
  if (!recipe) throw new Error("Quote acceptance recipe missing");
  const { outputText } = ts.transpileModule(recipe, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = Object.create(null);
  const load = (id: string) => {
    expect(id).toBe("@openlup/platform/promotions");
    return promotions;
  };
  new Function("exports", "require", outputText)(exports, load);
  const result = exports.issuePresentedQuote(scope, accept.acceptanceRef, presentation);
  expect(result.kind).toBe("issued");
  expect(exports.verifyPresentedQuote(scope, result.token, result.presentationRef)).toMatchObject({
    kind: "verified", acceptanceRef: accept.acceptanceRef,
  });
  exact(exports.verifyPresentedQuote(scope, result.token, otherDigest), display);
});
