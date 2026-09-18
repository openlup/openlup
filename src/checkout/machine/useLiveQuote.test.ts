/** @vitest-environment jsdom -- exercises browser-path behavior (window/storage/DOM). */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCommerceQuote } from "@/domains/commerce/commerceClient";
import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";

import { clearAllRequestCaches } from "./commerceRequestCache";
import {
  buildQuoteRequest,
  isInvalidPromoResult,
  quoteModeDiscountPercent,
  quotePerUnitAnchorMinor,
  quoteProductSavingsMinor,
  quoteProductPayableMinor,
  useLiveQuote,
  type CommerceQuote,
  type LiveQuoteInput,
} from "./useLiveQuote";

vi.mock("@/domains/commerce/commerceClient", () => ({
  createCommerceQuote: vi.fn(),
}));

const mockedCreateQuote = vi.mocked(createCommerceQuote);

afterEach(() => {
  clearAllRequestCaches();
  vi.clearAllMocks();
  vi.useRealTimers();
  delete globalThis.__openlup_TEST_OFFER_POLICY_V2_CAPABILITY__;
});

function snapshot(
  over: Partial<CommerceRecommendationSnapshot> = {},
): CommerceRecommendationSnapshot {
  return {
    status: "ready_to_buy",
    dailyKcal: 500,
    lines: [
      { sku: "opaque:lamb.v1", qty: 21, variantId: "var-lamb", slug: "lamb" },
    ],
    ...over,
  } as unknown as CommerceRecommendationSnapshot;
}

type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function quote(over: DeepPartial<CommerceQuote> = {}): CommerceQuote {
  return {
    discounts: [],
    subtotalGross: { currency: "PLN", amountMinor: 1000 },
    discountTotalGross: { currency: "PLN", amountMinor: 0 },
    totalGross: { currency: "PLN", amountMinor: 1000 },
    pricingComponents: [
      { scope: "line", componentType: "base_unit", amountMinor: 1200, reasonCode: "base" },
    ],
    lines: [],
    ...over,
  } as unknown as CommerceQuote;
}

const baseInput: LiveQuoteInput = {
  snapshot: snapshot(),
  subscription: true,
  lengthDays: 21,
  promoCodes: [],
};

describe("buildQuoteRequest", () => {
  it("maps the recommendation snapshot into a quote request", () => {
    const request = buildQuoteRequest({ ...baseInput, promoCodes: ["WELCOME10"] });

    expect(request).toMatchObject({
      mode: "subscription",
      cadenceDays: 21,
      sizeConstraint: { kind: "unit_count", value: 21 },
      petProfileContext: { dailyKcalOverride: 500 },
      promoCodes: ["WELCOME10"],
      lines: [
        {
          sku: "opaque:lamb.v1",
          quantity: 21,
          variantId: "var-lamb",
          modeAtLine: "subscription",
        },
      ],
    });
    // openlup_vid is a best-effort device id (string when storage is available; the guard
    // simply does not apply when undefined).
    expect(["string", "undefined"]).toContain(typeof request?.visitorId);
  });

  it("uses one_time mode with null cadence when not subscribed", () => {
    const request = buildQuoteRequest({ ...baseInput, subscription: false });
    expect(request).toMatchObject({ mode: "one_time", cadenceDays: null });
    expect(request?.lines[0].modeAtLine).toBe("one_time");
  });

  it("uses the selected cadence even when package coverage is much longer", () => {
    const request = buildQuoteRequest({
      ...baseInput,
      lengthDays: 14,
      snapshot: snapshot({ feedingDays: 121 }),
    });
    expect(request?.cadenceDays).toBe(14);
    expect(request?.sizeConstraint).toEqual({ kind: "unit_count", value: 21 });
    expect(request?.petProfileContext).toEqual({ dailyKcalOverride: 500 });
  });

  it("includes customer eligibility context only for syntactically valid email", () => {
    expect(
      buildQuoteRequest({ ...baseInput, customerEmail: " Anna+promo@Example.COM " }),
    ).toMatchObject({
      customerEligibilityContext: { email: "anna+promo@example.com" },
    });

    expect(
      buildQuoteRequest({ ...baseInput, customerEmail: "not-yet-an-email" }),
    ).not.toHaveProperty("customerEligibilityContext");
  });

  it("reuses a bound policy token even when new capability assignment is off", () => {
    globalThis.__openlup_TEST_OFFER_POLICY_V2_CAPABILITY__ = false;
    const token = "pp1.persisted-visitor-bound-policy-token.signature-value";

    expect(buildQuoteRequest({ ...baseInput, pricingPolicyToken: token }))
      .toMatchObject({
        pricingPolicy: {
          capability: "commerce.offer-policy.v2",
          token,
        },
      });

    delete globalThis.__openlup_TEST_OFFER_POLICY_V2_CAPABILITY__;
  });

  it("returns null for a non-checkoutable snapshot", () => {
    expect(buildQuoteRequest({ ...baseInput, snapshot: null })).toBeNull();
    expect(
      buildQuoteRequest({ ...baseInput, snapshot: snapshot({ status: "manual_review" }) }),
    ).toBeNull();
  });
});

describe("useLiveQuote", () => {
  it("debounces, fetches, and surfaces the discounted quote", async () => {
    vi.useFakeTimers();
    const resolved = quote({
      discounts: [
        {
          promotionId: "promo_welcome",
          code: "WELCOME10",
          appliesTo: "order_total",
          amountOffMinor: 200,
          reasonCode: "promo_code",
        },
      ],
      totalGross: { currency: "PLN", amountMinor: 1000 },
    });
    mockedCreateQuote.mockResolvedValue({ quote: resolved } as never);

    const { result } = renderHook(() =>
      useLiveQuote({ ...baseInput, promoCodes: ["WELCOME10"] }),
    );

    expect(result.current.loading).toBe(true);
    expect(mockedCreateQuote).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockedCreateQuote).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.quote?.discounts).toHaveLength(1);
    expect(isInvalidPromoResult(result.current.quote, ["WELCOME10"])).toBe(false);
  });

  it("reuses a settled quote for identical inputs", async () => {
    vi.useFakeTimers();
    mockedCreateQuote.mockResolvedValue({ quote: quote() } as never);

    const first = renderHook(() => useLiveQuote(baseInput));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockedCreateQuote).toHaveBeenCalledTimes(1);
    expect(first.result.current.quote).not.toBeNull();

    const second = renderHook(() => useLiveQuote(baseInput));

    expect(second.result.current.quote).not.toBeNull();
    expect(mockedCreateQuote).toHaveBeenCalledTimes(1);
  });

  it("aborts the stale quote request when its key changes", async () => {
    vi.useFakeTimers();
    mockedCreateQuote.mockImplementation(() => new Promise(() => {}) as never);
    const { rerender } = renderHook((input: LiveQuoteInput) => useLiveQuote(input), {
      initialProps: baseInput,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const firstSignal = mockedCreateQuote.mock.calls[0][1]?.signal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);

    rerender({ ...baseInput, subscription: false });

    expect(firstSignal?.aborted).toBe(true);
  });

  it("flags an invalid code when the server resolves no discounts", async () => {
    vi.useFakeTimers();
    mockedCreateQuote.mockResolvedValue({ quote: quote({ discounts: [] }) } as never);

    const { result } = renderHook(() =>
      useLiveQuote({ ...baseInput, promoCodes: ["BADCODE"] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.quote?.discounts).toHaveLength(0);
    expect(isInvalidPromoResult(result.current.quote, ["BADCODE"])).toBe(true);
  });

  it("sends and retains the same acceptance token during a reload drain", async () => {
    vi.useFakeTimers();
    const token = "opaque.signed-token";
    const resolved = quote({
      discounts: [{
        promotionId: "promo_v2",
        code: "SAVE80",
        appliesTo: "order_total",
        amountOffMinor: 800,
        reasonCode: "promotion_code_v2",
        promotionEngineVersion: "promotion-engine.v2",
      }],
    });
    mockedCreateQuote.mockResolvedValue({
      quote: resolved,
      promotionAcceptanceToken: token,
    } as never);

    const { result } = renderHook(() => useLiveQuote({
      ...baseInput,
      promoCodes: ["SAVE80"],
      promotionAcceptanceToken: token,
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockedCreateQuote).toHaveBeenCalledWith(
      expect.objectContaining({ promotionAcceptanceToken: token }),
      expect.any(Object),
    );
    expect(result.current.error).toBeNull();
    expect(result.current.quote?.promotionAcceptanceToken).toBe(token);
  });

  it("does not satisfy an HONOR request from a cached legacy quote", async () => {
    vi.useFakeTimers();
    const token = "opaque.signed-token";
    const legacy = quote();
    const honored = quote({
      discounts: [{
        promotionId: "promo_v2",
        code: "SAVE80",
        appliesTo: "order_total",
        amountOffMinor: 800,
        reasonCode: "promotion_code_v2",
        promotionEngineVersion: "promotion-engine.v2",
      }],
    });
    mockedCreateQuote
      .mockResolvedValueOnce({ quote: legacy } as never)
      .mockResolvedValueOnce({ quote: honored, promotionAcceptanceToken: token } as never);

    const { result, rerender } = renderHook(
      ({ acceptanceToken }: { acceptanceToken: string | null }) => useLiveQuote({
        ...baseInput,
        promoCodes: ["SAVE80"],
        promotionAcceptanceToken: acceptanceToken,
      }),
      { initialProps: { acceptanceToken: null as string | null } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.quote?.promotionAcceptanceToken).toBeUndefined();

    rerender({ acceptanceToken: token });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mockedCreateQuote).toHaveBeenCalledTimes(2);
    expect(mockedCreateQuote).toHaveBeenLastCalledWith(
      expect.objectContaining({ promotionAcceptanceToken: token }),
      expect.any(Object),
    );
    expect(result.current.quote?.promotionAcceptanceToken).toBe(token);
  });

  it("surfaces an error when the quote request fails", async () => {
    vi.useFakeTimers();
    mockedCreateQuote.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useLiveQuote(baseInput));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.error).toBe("checkout:step5.liveQuoteError");
    expect(result.current.quote).toBeNull();
  });

  it("retries one failed semantic request exactly once", async () => {
    vi.useFakeTimers();
    const resolved = quote({ totalGross: { currency: "PLN", amountMinor: 2_000 } });
    mockedCreateQuote
      .mockRejectedValueOnce(new Error("temporary quote failure"))
      .mockResolvedValueOnce({ quote: resolved } as never);
    const { result } = renderHook(() => useLiveQuote(baseInput));

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const retry = result.current.retry;
    expect(result.current.error).toBe("checkout:step5.liveQuoteError");

    act(() => { retry(); retry(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(mockedCreateQuote).toHaveBeenCalledTimes(2);
    expect(mockedCreateQuote.mock.calls[1][0]).toEqual(mockedCreateQuote.mock.calls[0][0]);
    expect(result.current.retry).toBe(retry);
    expect(result.current.quote?.totalGross.amountMinor).toBe(2_000);
  });

  it("discards a retry response after a semantic edit", async () => {
    vi.useFakeTimers();
    let resolveStale: ((value: { quote: CommerceQuote }) => void) | undefined;
    const fresh = quote({ totalGross: { currency: "PLN", amountMinor: 3_000 } });
    mockedCreateQuote
      .mockRejectedValueOnce(new Error("temporary quote failure"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }) as never)
      .mockResolvedValueOnce({ quote: fresh } as never);
    const { result, rerender } = renderHook((input: LiveQuoteInput) => useLiveQuote(input), {
      initialProps: baseInput,
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => result.current.retry());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const staleSignal = mockedCreateQuote.mock.calls[1][1]?.signal;

    rerender({ ...baseInput, subscription: false });
    expect(staleSignal?.aborted).toBe(true);
    await act(async () => { resolveStale?.({ quote: quote({ totalGross: { currency: "PLN", amountMinor: 9_000 } }) }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(result.current.quote?.totalGross.amountMinor).toBe(3_000);
  });

  it("clears the previous quote immediately while a changed request is loading", async () => {
    vi.useFakeTimers();
    const first = quote({ totalGross: { currency: "PLN", amountMinor: 1000 } });
    const second = quote({ totalGross: { currency: "PLN", amountMinor: 2000 } });
    mockedCreateQuote
      .mockResolvedValueOnce({ quote: first } as never)
      .mockResolvedValueOnce({ quote: second } as never);

    const { result, rerender } = renderHook((input: LiveQuoteInput) => useLiveQuote(input), {
      initialProps: baseInput,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.quote?.totalGross.amountMinor).toBe(1000);

    rerender({ ...baseInput, subscription: false });

    expect(result.current.loading).toBe(true);
    expect(result.current.quote).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.quote?.totalGross.amountMinor).toBe(2000);
  });

  it("keeps the server assignment on a rollback-era input change", async () => {
    vi.useFakeTimers();
    const token = "pp1.persisted-visitor-bound-policy-token.signature-value";
    mockedCreateQuote.mockResolvedValue({ quote: quote() } as never);

    const { rerender } = renderHook(
      (input: LiveQuoteInput) => useLiveQuote(input),
      { initialProps: { ...baseInput, pricingPolicyToken: token } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    rerender({ ...baseInput, subscription: false, pricingPolicyToken: token });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(mockedCreateQuote).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "one_time",
        pricingPolicy: expect.objectContaining({ token }),
      }),
      expect.any(Object),
    );
  });

  it("does not fetch when the snapshot is not checkoutable", async () => {
    const { result } = renderHook(() => useLiveQuote({ ...baseInput, snapshot: null }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedCreateQuote).not.toHaveBeenCalled();
    expect(result.current.quote).toBeNull();
  });

  it("stays idle and never fetches when disabled (production flag off)", async () => {
    const { result } = renderHook(() => useLiveQuote({ ...baseInput, enabled: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedCreateQuote).not.toHaveBeenCalled();
    expect(result.current.quote).toBeNull();
  });
});

describe("quote display helpers", () => {
  it("derives the per-unit anchor from base_unit components", () => {
    const q = quote({ totalGross: { currency: "PLN", amountMinor: 1000 } });
    expect(quotePerUnitAnchorMinor(q)).toBe(1200);
    expect(quoteProductPayableMinor(q)).toBe(1000);
    expect(quoteProductSavingsMinor(q)).toBe(200);
  });

  it("keeps a free-delivery benefit out of the product saving", () => {
    const q = quote({
      discounts: [
        {
          promotionId: "promo_first_subscription",
          code: null,
          appliesTo: "order_total",
          amountOffMinor: 17_850,
          reasonCode: "first_subscription",
        },
        {
          promotionId: "promo_free_shipping",
          code: null,
          appliesTo: "shipping",
          amountOffMinor: 1_500,
          reasonCode: "subscription_free_shipping",
        },
      ],
      pricingComponents: [
        {
          scope: "order",
          componentType: "base_unit",
          amountMinor: 44_700,
          reasonCode: "base",
        },
      ],
      subtotalGross: { currency: "PLN", amountMinor: 40_200 },
      discountTotalGross: { currency: "PLN", amountMinor: 17_850 },
      shippingGross: { currency: "PLN", amountMinor: 1_500 },
      shippingDiscountGross: { currency: "PLN", amountMinor: 1_500 },
      totalGross: { currency: "PLN", amountMinor: 22_350 },
    });

    expect(quotePerUnitAnchorMinor(q)).toBe(44_700);
    expect(quoteProductPayableMinor(q)).toBe(22_350);
    expect(quoteProductSavingsMinor(q)).toBe(22_350);
  });

  it("falls back to per-line base_unit components when none are order-scoped", () => {
    const q = quote({
      pricingComponents: [],
      lines: [
        {
          pricingComponents: [
            { scope: "line", componentType: "base_unit", amountMinor: 700, reasonCode: "base" },
            { scope: "line", componentType: "promo", amountMinor: -100, reasonCode: "promo" },
          ],
        },
      ],
      totalGross: { currency: "PLN", amountMinor: 700 },
    } as unknown as Partial<CommerceQuote>);
    expect(quotePerUnitAnchorMinor(q)).toBe(700);
    expect(quoteProductSavingsMinor(q)).toBe(0);
  });

  it("keeps the product saving identical for paid and free shipping", () => {
    const productMoney = {
      discounts: [
        {
          promotionId: "promo_product",
          code: null,
          appliesTo: "order_total",
          amountOffMinor: 300,
          reasonCode: "promo_code",
        },
      ],
      pricingComponents: [
        {
          scope: "order",
          componentType: "base_unit",
          amountMinor: 2000,
          reasonCode: "base",
          reasonPayload: {},
        },
      ],
      subtotalGross: { currency: "PLN", amountMinor: 1800 },
      discountTotalGross: { currency: "PLN", amountMinor: 300 },
      shippingGross: { currency: "PLN", amountMinor: 1000 },
    } satisfies Partial<CommerceQuote>;
    const paidShipping = quote({
      ...productMoney,
      shippingDiscountGross: { currency: "PLN", amountMinor: 0 },
      totalGross: { currency: "PLN", amountMinor: 2500 },
    });
    const freeShipping = quote({
      ...productMoney,
      shippingDiscountGross: { currency: "PLN", amountMinor: 1000 },
      totalGross: { currency: "PLN", amountMinor: 1500 },
    });

    expect(quoteProductPayableMinor(paidShipping)).toBe(1500);
    expect(quoteProductPayableMinor(freeShipping)).toBe(1500);
    expect(quoteProductSavingsMinor(paidShipping)).toBe(500);
    expect(quoteProductSavingsMinor(freeShipping)).toBe(500);
  });

  it("shows the first-subscription product saving without free delivery", () => {
    const q = quote({
      discounts: [
        {
          promotionId: "promo_first_subscription",
          code: null,
          appliesTo: "order_total",
          amountOffMinor: 8330,
          reasonCode: "promo:first_subscription_50",
        },
        {
          promotionId: "promo_free_shipping",
          code: null,
          appliesTo: "shipping",
          amountOffMinor: 1500,
          reasonCode: "promo:subscription_free_shipping",
        },
      ],
      pricingComponents: [
        { scope: "order", componentType: "base_unit", amountMinor: 20_860, reasonCode: "base" },
        { scope: "order", componentType: "mode_discount", amountMinor: -2100, reasonCode: "subscription_band" },
      ],
      shippingGross: { currency: "PLN", amountMinor: 1500 },
      shippingDiscountGross: { currency: "PLN", amountMinor: 1500 },
      totalGross: { currency: "PLN", amountMinor: 10_430 },
    });

    expect(quoteProductPayableMinor(q)).toBe(10_430);
    expect(quoteProductSavingsMinor(q)).toBe(10_430);
  });

  it("uses the canonical production equation: 268,20 zł → 107,28 zł = 160,92 zł", () => {
    const q = quote({
      pricingComponents: [
        { scope: "order", componentType: "base_unit", amountMinor: 26_820, reasonCode: "base" },
      ],
      totalGross: { currency: "PLN", amountMinor: 10_728 },
    });

    expect(quoteProductSavingsMinor(q)).toBe(16_092);
  });

  it("uses 134,10 zł, not 149,10 zł, for the first subscription product saving", () => {
    const q = quote({
      pricingComponents: [
        { scope: "order", componentType: "base_unit", amountMinor: 26_820, reasonCode: "base" },
      ],
      shippingGross: { currency: "PLN", amountMinor: 1_500 },
      shippingDiscountGross: { currency: "PLN", amountMinor: 1_500 },
      totalGross: { currency: "PLN", amountMinor: 13_410 },
    });

    expect(quoteProductSavingsMinor(q)).toBe(13_410);
    expect(quoteProductSavingsMinor(q)).not.toBe(14_910);
  });

  it("falls back to the server product discount total when a legacy quote has no anchor", () => {
    const q = quote({
      pricingComponents: [],
      lines: [],
      discountTotalGross: { currency: "PLN", amountMinor: 4_235 },
      totalGross: { currency: "PLN", amountMinor: 10_728 },
    });

    expect(quotePerUnitAnchorMinor(q)).toBe(0);
    expect(quoteProductSavingsMinor(q)).toBe(4_235);
  });

  it("derives the subscription band percent from the mode_discount component", () => {
    // 14 cans: base_unit 20860 (1490×14), mode_discount −2100 (150×14) → 10%.
    const q = quote({
      pricingComponents: [
        { scope: "line", componentType: "base_unit", amountMinor: 20860, reasonCode: "base" },
        { scope: "line", componentType: "mode_discount", amountMinor: -2100, reasonCode: "subscription_band" },
      ],
      totalGross: { currency: "PLN", amountMinor: 18760 },
    });
    expect(quoteModeDiscountPercent(q)).toBe(10);
  });

  it("returns null when there is no subscription band (one-time / static resolver)", () => {
    const q = quote({
      pricingComponents: [
        { scope: "line", componentType: "base_unit", amountMinor: 20860, reasonCode: "base" },
      ],
      totalGross: { currency: "PLN", amountMinor: 20860 },
    });
    expect(quoteModeDiscountPercent(q)).toBeNull();
  });

  it("reads mode_discount from per-line components when none are order-scoped", () => {
    const q = quote({
      pricingComponents: [],
      lines: [
        {
          pricingComponents: [
            { scope: "line", componentType: "base_unit", amountMinor: 1000, reasonCode: "base" },
            { scope: "line", componentType: "mode_discount", amountMinor: -100, reasonCode: "subscription_band" },
          ],
        },
      ],
      totalGross: { currency: "PLN", amountMinor: 900 },
    } as unknown as Partial<CommerceQuote>);
    expect(quoteModeDiscountPercent(q)).toBe(10);
  });
});
