import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one line that crosses the boundary `src/` may not cross.
 *
 * `src/lib/currency/platformCurrency.ts` cannot name the process environment —
 * it is bundled into the browser and `scripts/check-client-secret-boundary.ts`
 * forbids it — so a server process has to be told what it settles in. These
 * cases assert the three things a composition root depends on: that the
 * environment is actually read, that the default is preserved when nothing is
 * configured, and that a caller may hand in a record instead of the process one.
 *
 * The ambient profile is process state, so each case re-imports the graph.
 */

/** ISO 4217's code reserved for testing: no deployment settles in it. */
const TEST_CURRENCY = "XTS";

describe("bootstrapAmbientSettlementProfile", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads the process environment by default", async () => {
    vi.stubEnv("COMMERCE_SETTLEMENT_CURRENCY", TEST_CURRENCY);
    try {
      const { bootstrapAmbientSettlementProfile } = await import("./settlementProfileBootstrap.js");
      const currency = await import("../../src/lib/currency/platformCurrency.js");

      bootstrapAmbientSettlementProfile();

      expect(currency.ambientSettlementProfile.defaultCurrency).toBe(TEST_CURRENCY);
      // The point of the whole wave: the contract layer's refusal follows.
      expect(currency.platformCurrencySchema.safeParse(TEST_CURRENCY).success).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("accepts an explicit record, for a root that has its own", async () => {
    const { bootstrapAmbientSettlementProfile } = await import("./settlementProfileBootstrap.js");
    const currency = await import("../../src/lib/currency/platformCurrency.js");

    bootstrapAmbientSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: TEST_CURRENCY });

    expect(currency.ambientSettlementProfile.defaultCurrency).toBe(TEST_CURRENCY);
  });

  it("leaves the platform default in place when nothing is configured", async () => {
    const { bootstrapAmbientSettlementProfile } = await import("./settlementProfileBootstrap.js");
    const currency = await import("../../src/lib/currency/platformCurrency.js");

    // What every deployment gets today, so bootstrapping cannot make one of them
    // notice this wave.
    bootstrapAmbientSettlementProfile({});

    expect(currency.ambientSettlementProfile.defaultCurrency)
      .toBe(currency.PLATFORM_DEFAULT_CURRENCY);
  });

  it("refuses a second, different answer rather than letting load order decide", async () => {
    const { bootstrapAmbientSettlementProfile } = await import("./settlementProfileBootstrap.js");
    const currency = await import("../../src/lib/currency/platformCurrency.js");

    bootstrapAmbientSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: TEST_CURRENCY });
    expect(() => bootstrapAmbientSettlementProfile({}))
      .toThrow(currency.ConflictingAmbientSettlementProfileError);
    // Repeating one environment's answer stays a no-op, because two roots in one
    // process legitimately state it twice.
    expect(() => bootstrapAmbientSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: TEST_CURRENCY }))
      .not.toThrow();
  });

  it("refuses a malformed configured currency instead of falling back", async () => {
    const { bootstrapAmbientSettlementProfile } = await import("./settlementProfileBootstrap.js");
    const currency = await import("../../src/lib/currency/platformCurrency.js");

    // The refusal belongs to the reader; asserted here because this is the call
    // a composition root makes, and a root that started on a typo would price in
    // a currency nobody chose.
    expect(() => bootstrapAmbientSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "xts" }))
      .toThrow(currency.InvalidSettlementCurrencyError);
  });
});
