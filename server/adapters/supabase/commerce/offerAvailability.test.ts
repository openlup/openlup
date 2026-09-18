import { describe, expect, it } from "vitest";

import {
  createSupabaseOfferAvailabilityPort,
  type OfferAvailabilitySupabaseClient,
} from "./offerAvailability.js";

describe("createSupabaseOfferAvailabilityPort", () => {
  it("ignores expired inventory lots when deriving sellable availability", async () => {
    const port = createSupabaseOfferAvailabilityPort(
      clientWithTables({
        fulfillment_provider_stock_current: [],
        inventory_reservations: [],
        inventory_balances: [
        balanceRow({
          sku: "opaque:salmon-launch.v1",
          onHand: 20,
          lotStatus: "available",
          lotExpiresAt: "2020-01-01T00:00:00.000Z",
        }),
        balanceRow({
          sku: "opaque:salmon-launch.v1",
          onHand: 6,
          lotStatus: "available",
          lotExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
        ],
      }),
      {
        lowStockThreshold: 5,
        now: () => new Date("2026-06-30T10:00:00.000Z"),
      },
    );

    const [availability] = await port.getAvailability({
      items: [{
        sku: "opaque:salmon-launch.v1",
        productSlug: "salmon",
        variantId: "variant-salmon-400",
        requestedQuantity: 1,
        checkoutMode: "one_time",
      }],
    });

    expect(availability).toMatchObject({
      status: "available",
      sellableNow: 6,
      visibleInConfigurator: true,
    });
  });

  it("uses active reservation leases rather than materialized reserved balance", async () => {
    const port = createSupabaseOfferAvailabilityPort(
      clientWithTables({
        fulfillment_provider_stock_current: [
          providerRow({
            sku: "opaque:salmon-launch.v1",
            providerForSale: 20,
            staleAfter: "2026-06-30T12:00:00.000Z",
          }),
        ],
        inventory_balances: [
          balanceRow({
            sku: "opaque:salmon-launch.v1",
            onHand: 20,
            safetyStock: 2,
            lotStatus: "available",
            lotExpiresAt: "2099-01-01T00:00:00.000Z",
          }),
        ],
        inventory_reservations: [
          reservationRow({
            sku: "opaque:salmon-launch.v1",
            quantity: 5,
            expiresAt: "2026-06-30T09:59:00.000Z",
          }),
          reservationRow({
            sku: "opaque:salmon-launch.v1",
            quantity: 4,
            expiresAt: "2026-06-30T10:30:00.000Z",
          }),
          reservationRow({
            sku: "opaque:salmon-launch.v1",
            quantity: 3,
            expiresAt: null,
          }),
        ],
      }),
      {
        lowStockThreshold: 5,
        now: () => new Date("2026-06-30T10:00:00.000Z"),
      },
    );

    const [availability] = await port.getAvailability({
      items: [item("opaque:salmon-launch.v1")],
    });

    expect(availability).toMatchObject({
      status: "available",
      sellableNow: 11,
      source: "inventory_provider",
      visibleInConfigurator: true,
    });
  });

  it("excludes reservations tied to cancelled orders from sellable stock", async () => {
    const port = createSupabaseOfferAvailabilityPort(
      clientWithTables({
        fulfillment_provider_stock_current: [
          providerRow({
            sku: "opaque:salmon-launch.v1",
            providerForSale: 30,
            staleAfter: "2026-06-30T12:00:00.000Z",
          }),
        ],
        inventory_balances: [],
        inventory_reservations: [
          // Legitimately committed (paid) — still reduces stock.
          reservationRow({
            sku: "opaque:salmon-launch.v1",
            quantity: 6,
            expiresAt: null,
            orderStatus: "paid",
          }),
          // Stranded holds from terminal orders — must NOT reduce stock.
          reservationRow({
            sku: "opaque:salmon-launch.v1",
            quantity: 12,
            expiresAt: null,
            orderStatus: "cancelled",
          }),
          reservationRow({
            sku: "opaque:salmon-launch.v1",
            quantity: 5,
            expiresAt: null,
            orderStatus: "failed",
          }),
        ],
      }),
      { now: () => new Date("2026-06-30T10:00:00.000Z") },
    );

    const [availability] = await port.getAvailability({
      items: [item("opaque:salmon-launch.v1")],
    });

    // 30 for-sale − 6 paid hold − 0 safety = 24 (cancelled 12 + failed 5 ignored).
    expect(availability).toMatchObject({
      status: "available",
      sellableNow: 24,
      source: "inventory_provider",
    });
  });

  it("fails closed when provider stock is stale", async () => {
    const port = createSupabaseOfferAvailabilityPort(
      clientWithTables({
        fulfillment_provider_stock_current: [
          providerRow({
            sku: "opaque:salmon-launch.v1",
            providerForSale: 20,
            staleAfter: "2026-06-30T09:59:00.000Z",
          }),
        ],
        inventory_balances: [],
        inventory_reservations: [],
      }),
      { now: () => new Date("2026-06-30T10:00:00.000Z") },
    );

    const [availability] = await port.getAvailability({
      items: [item("opaque:salmon-launch.v1")],
    });

    expect(availability).toMatchObject({
      status: "out_of_stock",
      visibleInConfigurator: false,
      reasonCode: "provider_stock_stale",
    });
  });
});

function clientWithTables(tables: Record<string, unknown[]>): OfferAvailabilitySupabaseClient {
  return {
    from(table: string) {
      return {
        select() {
          return {
            in: async () => ({ data: tables[table] ?? [], error: null }),
          };
        },
      };
    },
  } as unknown as OfferAvailabilitySupabaseClient;
}

function item(sku: string) {
  return {
    sku,
    productSlug: "salmon" as const,
    variantId: "variant-salmon-400",
    requestedQuantity: 1,
    checkoutMode: "one_time" as const,
  };
}

function balanceRow(input: {
  sku: string;
  onHand: number;
  safetyStock?: number;
  lotStatus: string | null;
  lotExpiresAt: string | null;
}) {
  return {
    on_hand: input.onHand,
    unavailable: 0,
    safety_stock: input.safetyStock ?? 0,
    catalog_skus: { sku: input.sku },
    inventory_locations: { status: "active", fulfillable: true },
    inventory_lots: { status: input.lotStatus, expires_at: input.lotExpiresAt },
  };
}

function providerRow(input: {
  sku: string;
  providerForSale: number;
  staleAfter: string;
}) {
  return {
    sku: input.sku,
    provider_kind: "omnipack",
    provider_for_sale_quantity: input.providerForSale,
    last_synced_at: "2026-06-30T09:00:00.000Z",
    stale_after: input.staleAfter,
  };
}

function reservationRow(input: {
  sku: string;
  quantity: number;
  expiresAt: string | null;
  orderStatus?: string;
}) {
  return {
    quantity: input.quantity,
    status: "reserved",
    expires_at: input.expiresAt,
    catalog_skus: { sku: input.sku },
    // Non-terminal by default so existing cases keep counting the hold.
    commerce_orders: { status: input.orderStatus ?? "pending_payment" },
  };
}
