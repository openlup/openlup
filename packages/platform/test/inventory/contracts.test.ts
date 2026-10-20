import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  adminInventoryStockRequestSchema,
  adminInventoryReservationsRequestSchema,
  adminInventoryStockAdjustmentRequestSchema,
  adminInventorySubscriptionForecastRequestSchema,
  createInventorySubscriptionForecastResponseSchema,
} from "@openlup/platform/inventory";

const forecast = {
  contractVersion: "inventory.v0",
  generatedAt: "2026-01-01T00:00:00Z",
  stockMasterProvider: "source-x",
  horizonDays: 60,
  protectionDays: 45,
  skus: [],
  totals: {
    activeSubscriptionCount: 0,
    excludedSubscriptionCount: 0,
    missingProviderStockSkuCount: 0,
    staleProviderStockSkuCount: 0,
    horizonShortageSkuCount: 0,
    protectionShortageSkuCount: 0,
    shortageSkuCount: 0,
    recommendedProductionQty: 0,
  },
};

describe("inventory entry contracts", () => {
  it("preserves strict request defaults, coercion and forecast-window refusal", () => {
    expect(adminInventoryStockRequestSchema.parse({})).toEqual({ page: 1, pageSize: 25, includeZero: false });
    expect(adminInventoryReservationsRequestSchema.parse({ page: "2" })).toEqual({ page: 2, pageSize: 25 });
    expect(adminInventoryStockRequestSchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(adminInventoryStockRequestSchema.safeParse({ extra: true }).success).toBe(false);
    expect(adminInventoryStockAdjustmentRequestSchema.safeParse({ quantityDelta: 1 }).success).toBe(false);
    expect(adminInventorySubscriptionForecastRequestSchema.parse({})).toEqual({ horizonDays: 60, protectionDays: 45 });
    expect(adminInventorySubscriptionForecastRequestSchema.safeParse({ horizonDays: 30, protectionDays: 45 }).success).toBe(false);
  });

  it("requires injected provider validation and rejects a different provider", () => {
    const schema = createInventorySubscriptionForecastResponseSchema(z.literal("source-x"));
    expect(schema.parse(forecast)).toEqual(forecast);
    expect(schema.safeParse({ ...forecast, stockMasterProvider: "source-y" }).success).toBe(false);
    expect(schema.safeParse({ ...forecast, stockMasterProvider: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...forecast, unknown: true }).success).toBe(false);
    expect(() => Reflect.apply(createInventorySubscriptionForecastResponseSchema, undefined, []).parse(forecast)).toThrow();
    expectTypeOf<typeof createInventorySubscriptionForecastResponseSchema>().parameters.toEqualTypeOf<[providerSchema: z.ZodType<string>]>();
  });
});
