import { describe, expect, it } from "vitest";

import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";

import { isCheckoutableRecommendation } from "./recommendationGate";

const OFFER = { offerVersion: "offer.v2", minimumUnits: 12 };

function snapshot(
  quantities: number[],
  offer: { offerVersion?: string; minimumUnits?: number } = {},
): CommerceRecommendationSnapshot {
  return {
    status: "ready_to_buy",
    dailyKcal: 500,
    lines: quantities.map((qty, index) => ({
      variantId: `variant-${index}`,
      sku: `opaque:item-${index}.v1`,
      slug: `item-${index}`,
      qty,
    })),
    ...offer,
  } as unknown as CommerceRecommendationSnapshot;
}

describe("isCheckoutableRecommendation", () => {
  it("admits 12 units when the snapshot carries a minimum of 12", () => {
    expect(isCheckoutableRecommendation(snapshot([6, 6], OFFER))).toBe(true);
  });

  it("refuses the same 12 units without a carried minimum", () => {
    expect(isCheckoutableRecommendation(snapshot([6, 6]))).toBe(false);
  });

  it("keeps the core minimum of 14 when no minimum is carried", () => {
    expect(isCheckoutableRecommendation(snapshot([7, 7]))).toBe(true);
    expect(isCheckoutableRecommendation(snapshot([7, 6]))).toBe(false);
  });

  it("refuses 21 units under a carried minimum of 24", () => {
    const larger = { offerVersion: "offer.v2", minimumUnits: 24 };

    expect(isCheckoutableRecommendation(snapshot([10, 11], larger))).toBe(false);
    expect(isCheckoutableRecommendation(snapshot([12, 12], larger))).toBe(true);
  });

  it("still refuses a held snapshot whatever minimum it carries", () => {
    const held = { ...snapshot([6, 6], OFFER), status: "manual_review" } as CommerceRecommendationSnapshot;

    expect(isCheckoutableRecommendation(held)).toBe(false);
  });
});
