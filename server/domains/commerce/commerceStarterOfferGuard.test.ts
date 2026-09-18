import { describe, expect, it, vi } from "vitest";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import {
  STARTER_OFFER_CAPABILITY,
  starterTermsFromCoverage,
} from "../../../src/domains/commerce/starterOfferPolicy.js";
import {
  resolveStarterOfferGuard,
  withStarterPackContext,
  type StarterOfferGuardInput,
} from "./commerceStarterOfferGuard.js";
import { intent as baseIntent, quoteSnapshot } from "./commerceCheckoutHandler.testFixtures.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";

/**
 * A 14-can basket covering 14 days => 400 g/day => I = 14, steady cadence 28,
 * steady basket 28 cans. Every number in this file is derived from that row of
 * the policy stress table, so a policy change surfaces here as an explicit diff.
 */
function checkoutQuote(options?: {
  coverageDays?: number | null;
  subtotalMinor?: number;
  listAnchorMinor?: number;
}): CreateQuoteResponse {
  const subtotal = options?.subtotalMinor ?? 16_800;
  const snapshot = quoteSnapshot({ amountMinor: subtotal, currency: "PLN" });
  return {
    ...snapshot,
    quote: {
      ...snapshot.quote,
      lines: [{ ...snapshot.quote.lines[0], quantity: 14, unitPriceGross: { amountMinor: 1_200, currency: "PLN" } }],
      pricingComponents: [
        {
          scope: "order",
          componentType: "base_unit",
          amountMinor: options?.listAnchorMinor ?? 21_000,
          reasonCode: "variant_unit_price",
          reasonPayload: {},
        },
      ],
      context: {
        mode: "subscription",
        cadenceDays: 21,
        feedingCoverageDays:
          options?.coverageDays === undefined ? 14 : options.coverageDays,
        promoCodes: [],
      },
    },
  };
}

function steadyQuote(cans = 28): CreateQuoteResponse {
  const snapshot = quoteSnapshot({ amountMinor: 28_000, currency: "PLN" });
  return {
    ...snapshot,
    quote: {
      ...snapshot.quote,
      lines: [
        {
          ...snapshot.quote.lines[0],
          // 2385's plan refine requires the graduation lines to total exactly the
          // promised `sizeConstraint.value`, so a case with a different steady
          // size has to quote that size.
          quantity: cans,
          unitPriceGross: { amountMinor: 1_000, currency: "PLN" },
          lineSubtotalGross: { amountMinor: 28_000, currency: "PLN" },
          pricingComponents: [
            {
              scope: "line",
              componentType: "base_unit",
              amountMinor: 40_000,
              reasonCode: "variant_unit_price",
              reasonPayload: {},
            },
          ],
        },
      ],
    },
  };
}

function starterIntent(overrides?: Partial<ConfiguratorIntent["starterOffer"]>): ConfiguratorIntent {
  return {
    ...baseIntent("subscription"),
    starterOffer: {
      capability: STARTER_OFFER_CAPABILITY,
      intervalDays: 14,
      delivery2DiscountBps: 3_500,
      steady: { cadenceDays: 28, cans: 28 },
      ...overrides,
    },
  };
}

function guardInput(overrides?: Partial<StarterOfferGuardInput>): StarterOfferGuardInput {
  return {
    flagEnabled: true,
    intent: starterIntent(),
    provisioned: { clientId: CLIENT_ID, petId: PET_ID },
    authoritativeQuote: checkoutQuote(),
    quotePort: { createQuote: vi.fn().mockResolvedValue(steadyQuote()) } as unknown as CommerceQuotePort,
    isFirstOrderEligible: () => Promise.resolve(true),
    ...overrides,
  };
}

describe("resolveStarterOfferGuard — the zero-work path", () => {
  it("is absent when no starter offer is declared, flag off", async () => {
    const quotePort = { createQuote: vi.fn() } as unknown as CommerceQuotePort;
    const result = await resolveStarterOfferGuard(
      guardInput({ flagEnabled: false, intent: baseIntent("subscription"), quotePort }),
    );
    expect(result).toEqual({ kind: "absent" });
    expect(quotePort.createQuote).not.toHaveBeenCalled();
  });

  it("is absent when no starter offer is declared, flag on", async () => {
    const quotePort = { createQuote: vi.fn() } as unknown as CommerceQuotePort;
    const result = await resolveStarterOfferGuard(
      guardInput({ intent: baseIntent("subscription"), quotePort }),
    );
    expect(result).toEqual({ kind: "absent" });
    expect(quotePort.createQuote).not.toHaveBeenCalled();
  });
});

describe("resolveStarterOfferGuard — rejections", () => {
  it("rejects a forged offer while the flag is off", async () => {
    await expect(resolveStarterOfferGuard(guardInput({ flagEnabled: false }))).resolves.toEqual({
      kind: "rejected",
      reason: "starter_offer_disabled",
    });
  });

  it("rejects a one-time checkout", async () => {
    const intent = { ...starterIntent(), mode: "one_time" as const, cadenceDays: null };
    await expect(resolveStarterOfferGuard(guardInput({ intent }))).resolves.toEqual({
      kind: "rejected",
      reason: "starter_offer_wrong_mode",
    });
  });

  it("rejects a basket under the 14-can minimum", async () => {
    const intent = starterIntent();
    intent.selectedVariants = [{ ...intent.selectedVariants[0], qty: 10 }];
    await expect(resolveStarterOfferGuard(guardInput({ intent }))).resolves.toEqual({
      kind: "rejected",
      reason: "starter_offer_basket_too_small",
    });
  });

  it("rejects when the server quote could not derive a ration", async () => {
    await expect(
      resolveStarterOfferGuard(guardInput({ authoritativeQuote: checkoutQuote({ coverageDays: null }) })),
    ).resolves.toEqual({ kind: "rejected", reason: "starter_offer_ration_unknown" });
  });

  it.each([
    ["interval", { intervalDays: 21 }],
    ["delivery-2 rate", { delivery2DiscountBps: 5_000 }],
    ["steady cadence", { steady: { cadenceDays: 14 as const, cans: 28 } }],
    ["steady basket size", { steady: { cadenceDays: 28 as const, cans: 14 } }],
  ])("rejects a client that disagrees about the %s", async (_label, override) => {
    await expect(
      resolveStarterOfferGuard(guardInput({ intent: starterIntent(override) })),
    ).resolves.toEqual({ kind: "rejected", reason: "starter_offer_terms_drifted" });
  });

  it("rejects a returning customer", async () => {
    await expect(
      resolveStarterOfferGuard(guardInput({ isFirstOrderEligible: () => Promise.resolve(false) })),
    ).resolves.toEqual({ kind: "rejected", reason: "starter_offer_not_first_order" });
  });

  it("rejects when eligibility cannot be proven at all", async () => {
    const input = guardInput();
    delete input.isFirstOrderEligible;
    await expect(resolveStarterOfferGuard(input)).resolves.toEqual({
      kind: "rejected",
      reason: "starter_offer_not_first_order",
    });
  });

  it("rejects when delivery 2 would leave less than 1 PLN payable", async () => {
    await expect(
      resolveStarterOfferGuard(
        guardInput({
          authoritativeQuote: checkoutQuote({ subtotalMinor: 16_800, listAnchorMinor: 100 }),
        }),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "starter_offer_uncollectable_delivery_2" });
  });

  it("rejects when the steady re-quote fails", async () => {
    const quotePort = {
      createQuote: vi.fn().mockRejectedValue(new Error("catalog unavailable")),
    } as unknown as CommerceQuotePort;
    await expect(resolveStarterOfferGuard(guardInput({ quotePort }))).resolves.toEqual({
      kind: "rejected",
      reason: "starter_offer_steady_quote_failed",
    });
  });
});

describe("resolveStarterOfferGuard — the minted plan", () => {
  it("freezes a plan the wave-1 marker schema accepts", async () => {
    const result = await resolveStarterOfferGuard(guardInput());
    expect(result.kind).toBe("minted");
    if (result.kind !== "minted") return;
    expect(result.plan).toEqual({
      schemaVersion: "1",
      starterIntervalDays: 14,
      basisTemplateVersion: 1,
      delivery2: {
        discountBps: 3_500,
        // Band 16800, list anchor 21000 -> target ceil(21000 * 0.65) = 13650.
        discountMinor: 3_150,
        basisSubtotalMinor: 16_800,
      },
      graduation: {
        cadenceDays: 28,
        sizeConstraint: { kind: "unit_count", value: 28 },
        lines: [
          {
            sku: "opaque:lamb-launch.v1",
            qty: 28,
            sortOrder: 0,
            isAddon: false,
            quoteLine: {
              sku: "opaque:lamb-launch.v1",
              productSlug: "lamb",
              quantity: 28,
              unitPriceGross: { amountMinor: 1_000, currency: "PLN" },
              lineSubtotalGross: { amountMinor: 28_000, currency: "PLN" },
              tax: steadyQuote().quote.lines[0].tax,
            },
          },
        ],
      },
    });
  });

  it("strips pricingComponents from the frozen quote line", async () => {
    const result = await resolveStarterOfferGuard(guardInput());
    if (result.kind !== "minted") throw new Error("expected a minted plan");
    expect("pricingComponents" in result.plan.graduation.lines[0].quoteLine).toBe(false);
  });

  it("re-quotes the steady package at the steady cadence, in subscription mode, promo-free", async () => {
    const createQuote = vi.fn().mockResolvedValue(steadyQuote());
    const intent = starterIntent();
    intent.promoCodes = ["WELCOME10"];
    await resolveStarterOfferGuard(
      guardInput({ intent, quotePort: { createQuote } as unknown as CommerceQuotePort }),
    );
    expect(createQuote).toHaveBeenCalledTimes(1);
    const [request, options] = createQuote.mock.calls[0];
    expect(request.mode).toBe("subscription");
    expect(request.cadenceDays).toBe(28);
    expect(request.promoCodes).toEqual([]);
    expect(request.sizeConstraint).toMatchObject({ kind: "unit_count", value: 28 });
    expect(request.lines.reduce((total: number, line: { quantity: number }) => total + line.quantity, 0)).toBe(28);
    expect(options).toEqual({ clientId: CLIENT_ID });
  });

  it("rescales a multi-flavour mix proportionally and lands exactly on the steady size", async () => {
    const createQuote = vi.fn().mockResolvedValue(steadyQuote());
    const intent = starterIntent();
    intent.selectedFlavorSlugs = ["lamb", "beef", "turkey"];
    intent.selectedVariants = [
      { variantId: "v-lamb", sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 7 },
      { variantId: "v-beef", sku: "opaque:beef-launch.v1", flavorSlug: "beef", qty: 4 },
      { variantId: "v-turkey", sku: "opaque:turkey-launch.v1", flavorSlug: "turkey", qty: 3 },
    ];
    await resolveStarterOfferGuard(
      guardInput({ intent, quotePort: { createQuote } as unknown as CommerceQuotePort }),
    );
    const quantities = createQuote.mock.calls[0][0].lines.map((line: { quantity: number }) => line.quantity);
    expect(quantities).toEqual([14, 8, 6]);
    expect(quantities.reduce((a: number, b: number) => a + b, 0)).toBe(28);
  });

  it("falls back to per-line base_unit components when the quote has no order-scoped anchor", async () => {
    const snapshot = checkoutQuote();
    const withLineAnchor: CreateQuoteResponse = {
      ...snapshot,
      quote: {
        ...snapshot.quote,
        pricingComponents: [],
        lines: [
          {
            ...snapshot.quote.lines[0],
            pricingComponents: [
              {
                scope: "line",
                componentType: "base_unit",
                amountMinor: 21_000,
                reasonCode: "variant_unit_price",
                reasonPayload: {},
              },
            ],
          },
        ],
      },
    };
    const result = await resolveStarterOfferGuard(
      guardInput({ authoritativeQuote: withLineAnchor }),
    );
    if (result.kind !== "minted") throw new Error("expected a minted plan");
    expect(result.plan.delivery2.discountMinor).toBe(3_150);
  });
});

describe("withStarterPackContext", () => {
  it("returns the snapshot unchanged for a null plan", () => {
    const snapshot = checkoutQuote();
    expect(withStarterPackContext(snapshot, null)).toBe(snapshot);
  });

  it("adds starterPack under quote.context without touching anything else", async () => {
    const result = await resolveStarterOfferGuard(guardInput());
    if (result.kind !== "minted") throw new Error("expected a minted plan");
    const snapshot = checkoutQuote();
    const withPlan = withStarterPackContext(snapshot, result.plan);
    expect(withPlan.quote.context?.starterPack).toEqual(result.plan);
    expect({ ...withPlan.quote.context, starterPack: undefined }).toEqual({
      ...snapshot.quote.context,
      starterPack: undefined,
    });
    expect(withPlan.quote.lines).toEqual(snapshot.quote.lines);
  });
});

/**
 * P1-2 regression: a marker that promises `steady.cans = N` must ship graduation
 * lines that sum to N.
 *
 * `selectedVariants` admits up to 50 entries with no SKU-uniqueness constraint,
 * and the rescale owes every ENTRY at least one can. Twenty-nine one-can entries
 * therefore floor to 29 and the trim loop — which only touches entries above one
 * — finds nothing to give back, so the pre-fix guard minted a marker declaring
 * 28 cans alongside 29 cans of lines.
 */
describe("resolveStarterOfferGuard — steady basket size is exact", () => {
  /**
   * A 29-can basket over a 29-day coverage is 400 g/day, which lands on interval
   * 28, steady cadence 28 and a steady basket of exactly 28 cans — one can FEWER
   * than the number of entries, which is precisely the shape that used to
   * mis-mint.
   */
  const COVERAGE_29 = { coverageDays: 29 };
  const DECLARED_29 = { intervalDays: 28, steady: { cadenceDays: 28 as const, cans: 28 } };

  function basketOf(entries: Array<{ sku: string; flavorSlug: string; qty: number }>, declared = {}) {
    const intent = starterIntent(declared);
    intent.selectedFlavorSlugs = [...new Set(entries.map((e) => e.flavorSlug))] as typeof intent.selectedFlavorSlugs;
    intent.selectedVariants = entries.map((entry, index) => ({
      variantId: `variant-${index}`,
      sku: entry.sku,
      flavorSlug: entry.flavorSlug,
      qty: entry.qty,
    })) as typeof intent.selectedVariants;
    return intent;
  }

  it("aggregates 29 duplicate one-can entries into a basket that rescales to exactly 28", async () => {
    const createQuote = vi.fn().mockResolvedValue(steadyQuote());
    const intent = basketOf(
      Array.from({ length: 29 }, () => ({
        sku: "opaque:lamb-launch.v1",
        flavorSlug: "lamb",
        qty: 1,
      })),
      DECLARED_29,
    );

    const result = await resolveStarterOfferGuard(
      guardInput({
        intent,
        authoritativeQuote: checkoutQuote(COVERAGE_29),
        quotePort: { createQuote } as unknown as CommerceQuotePort,
      }),
    );

    // The pre-fix guard sent 29 lines of one can each and minted anyway.
    const quotedLines = createQuote.mock.calls[0][0].lines as Array<{ sku: string; quantity: number }>;
    expect(quotedLines).toHaveLength(1);
    expect(quotedLines[0].quantity).toBe(28);
    expect(result.kind).toBe("minted");
    if (result.kind !== "minted") return;
    const lineCans = result.plan.graduation.lines.reduce((total, line) => total + line.qty, 0);
    expect(lineCans).toBe(28);
    expect(result.plan.graduation.sizeConstraint).toEqual({ kind: "unit_count", value: 28 });
  });

  it("REJECTS a basket of 29 DISTINCT skus that cannot shrink to 28, instead of mis-minting", async () => {
    const createQuote = vi.fn().mockResolvedValue(steadyQuote());
    const intent = basketOf(
      Array.from({ length: 29 }, (_unused, index) => ({
        sku: `opaque:flavour-${index}.v1`,
        flavorSlug: `flavour-${index}`,
        qty: 1,
      })),
      DECLARED_29,
    );

    const result = await resolveStarterOfferGuard(
      guardInput({
        intent,
        authoritativeQuote: checkoutQuote(COVERAGE_29),
        quotePort: { createQuote } as unknown as CommerceQuotePort,
      }),
    );

    expect(result).toEqual({ kind: "rejected", reason: "starter_offer_steady_quote_failed" });
    // Fail-closed BEFORE the quote port is asked to price an impossible basket.
    expect(createQuote).not.toHaveBeenCalled();
  });

  it("still aggregates when duplicates carry different quantities", async () => {
    const createQuote = vi.fn().mockResolvedValue(steadyQuote());
    const intent = basketOf([
      { sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 10 },
      { sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 4 },
    ]);

    await resolveStarterOfferGuard(
      guardInput({ intent, quotePort: { createQuote } as unknown as CommerceQuotePort }),
    );

    const quotedLines = createQuote.mock.calls[0][0].lines as Array<{ quantity: number }>;
    expect(quotedLines).toHaveLength(1);
    expect(quotedLines[0].quantity).toBe(28);
  });
});

/**
 * P1-A cross-boundary regression.
 *
 * The client used to derive the offer's terms from its recommendation snapshot's
 * integer `dailyGrams` while this guard derived them from the quote's 1-decimal
 * `feedingCoverageDays`. At dailyKcal=199 over a 5264-unit basket the two land
 * either side of a .5 boundary — client 26, guard 27 — and `price_changed`
 * recovery re-quotes without changing either operand, so the rejection repeats
 * for ever. Both sides now call `starterTermsFromCoverage` on the same two
 * numbers; these cases drive a real intent through the real guard to prove it.
 */
describe("resolveStarterOfferGuard — client/guard terms agreement", () => {
  const boundaryCoverage = Math.round((5264 / 199) * 10) / 10;

  it("accepts terms the client derived from the same coverage at the .5 boundary", async () => {
    expect(boundaryCoverage).toBe(26.5);
    const terms = starterTermsFromCoverage(14, boundaryCoverage)!;
    // The number the retired snapshot-derived formula produced, which this guard
    // rejected: proof the fixture really is the reachable loop.
    expect(Math.round((14 * 400) / Math.round((199 * 5600) / 5264))).toBe(26);
    expect(terms.intervalDays).toBe(27);

    const result = await resolveStarterOfferGuard(guardInput({
      intent: starterIntent({
        intervalDays: terms.intervalDays,
        steady: { cadenceDays: terms.cadenceDays, cans: terms.steadyCans },
      }),
      authoritativeQuote: checkoutQuote({ coverageDays: boundaryCoverage }),
      quotePort: {
        createQuote: vi.fn().mockResolvedValue(steadyQuote(terms.steadyCans)),
      } as unknown as CommerceQuotePort,
    }));

    expect(result.kind).toBe("minted");
  });

  it("still rejects the retired snapshot-derived interval, so the fix cannot silently regress", async () => {
    const result = await resolveStarterOfferGuard(guardInput({
      intent: starterIntent({ intervalDays: 26, steady: { cadenceDays: 28, cans: 15 } }),
      authoritativeQuote: checkoutQuote({ coverageDays: boundaryCoverage }),
    }));
    expect(result).toEqual({ kind: "rejected", reason: "starter_offer_terms_drifted" });
  });

  it("agrees across the ration sweep", async () => {
    for (const coverageDays of [6.2, 8.4, 11.2, 14, 20.5, 26.5, 28, 33.3, 41.7, 56]) {
      const terms = starterTermsFromCoverage(14, coverageDays);
      if (terms === null) continue;
      const result = await resolveStarterOfferGuard(guardInput({
        intent: starterIntent({
          intervalDays: terms.intervalDays,
          steady: { cadenceDays: terms.cadenceDays, cans: terms.steadyCans },
        }),
        authoritativeQuote: checkoutQuote({ coverageDays }),
        quotePort: {
          createQuote: vi.fn().mockResolvedValue(steadyQuote(terms.steadyCans)),
        } as unknown as CommerceQuotePort,
      }));
      expect(result.kind, `coverage ${coverageDays}`).not.toBe("rejected");
    }
  });
});
