import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  current: undefined as string | undefined,
  previous: undefined as string | undefined,
}));
const createPort = vi.hoisted(() => vi.fn(() => ({ resolve: vi.fn() })));

vi.mock("../../_lib/config/featureFlags.js", () => ({
  promotionAcceptanceHmacSecret: () => state.current,
  promotionAcceptancePreviousHmacSecret: () => state.previous,
}));
vi.mock("../../adapters/supabase/promotionCodeQuote.js", () => ({
  createSupabasePromotionCodeQuotePort: createPort,
}));

import {
  createPromotionCodeQuotePort,
  readPromotionAcceptanceKeyring,
} from "./promotionCodeQuoteComposition.js";

describe("promotion code quote composition", () => {
  beforeEach(() => {
    state.current = undefined;
    state.previous = undefined;
    createPort.mockClear();
  });

  it("always constructs the promotion-code quote port", () => {
    // The ISSUE/HONOR rollout flags were retired in PR 2243. There is no longer
    // any environment in which this factory returns undefined, so a promotion
    // code can never be silently dropped by configuration.
    const port = createPromotionCodeQuotePort({});

    expect(port).toBeDefined();
    expect(createPort).toHaveBeenCalledTimes(1);
  });

  it("does not consult the environment when constructing the port", () => {
    // Guards the retirement: reintroducing an env gate here would make this fail
    // because the port must be built identically with a hostile env.
    const previousEnv = { ...process.env };
    delete process.env.COMMERCE_PROMOTION_CODES_CHECKOUT_V2_ENABLED;
    delete process.env.COMMERCE_PROMOTION_CODES_CHECKOUT_V2_HONOR_ENABLED;
    try {
      expect(createPromotionCodeQuotePort({})).toBeDefined();
    } finally {
      process.env = previousEnv;
    }
  });

  it("requires a 32-byte current key and exposes the previous rotation slot", () => {
    state.current = "too-short";
    expect(readPromotionAcceptanceKeyring()).toBeNull();
    state.current = "current-promotion-key-000000000000";
    state.previous = "previous-promotion-key-00000000000";
    expect(readPromotionAcceptanceKeyring()).toEqual({
      current: state.current,
      previous: state.previous,
    });
  });
});
