import { CommerceRuntimePersistenceError } from "@openlup/platform/commerce";
import { createCheckoutStartRuntimeFailure } from "@openlup/platform/commerce/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  InventoryPersistenceError, createPostgresPurchaseReservationPort,
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

it.each([
  { code: "55P03", message: "inventory_admission_busy", mappedMessage: "Inventory admission temporarily unavailable", details: { code: "55P03", reason: "inventory_admission_busy" } },
  { code: "55P03", message: "canceling statement due to lock timeout", mappedMessage: "Inventory admission temporarily unavailable", details: { code: "55P03", reason: "inventory_lock_unavailable" } },
  { code: "22023", message: "inventory_admission_isolation_unsupported", mappedMessage: "Inventory reservation RPC failed", details: { code: "22023" } },
])("preserves the checkout caller outcome for $message with inventory-owned errors", async ({ code, message, mappedMessage, details }) => {
  const inventory = createPostgresPurchaseReservationPort({ query: async () => { throw Object.assign(new Error(message), { code }); } });
  const error: unknown = await inventory.expireReservations({ now: "2026-11-03T12:00:00.123456Z" }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(InventoryPersistenceError);
  expect(error).toMatchObject({ name: "InventoryPersistenceError", message: mappedMessage, details });
  expect((error as InventoryPersistenceError).details).toEqual(details);
  const caller = createCheckoutStartRuntimeFailure({ checkoutProviderAttemptFailure: () => null, prepareConflictReason: "prepared" });
  const actual = caller.mapStartRuntimeFailure(error, "synthetic-draft");
  const reference = caller.mapStartRuntimeFailure(new CommerceRuntimePersistenceError(mappedMessage, details), "synthetic-draft");
  expect({ name: actual.name, message: actual.message, orderIdForCompensation: actual.orderIdForCompensation, reason: actual.reason })
    .toEqual({ name: reference.name, message: reference.message, orderIdForCompensation: reference.orderIdForCompensation, reason: reference.reason });
  expect(actual.orderIdForCompensation).toBe(code === "55P03" ? null : "synthetic-draft");
  expect(actual.reason).toBe(code === "55P03" ? "inventory_admission_busy" : null);
});
