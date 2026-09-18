import { describe, expect, it, vi } from "vitest";

import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import {
  PLATFORM_DEFAULT_CURRENCY, PLATFORM_DEFAULT_REGION,
} from "../../../src/lib/currency/platformCurrency.js";
import {
  createSupabaseAdminPromotionsDataPort,
  type AdminPromotionsSupabaseClient,
} from "./adminPromotions.js";

describe("supabase admin promotions data port", () => {
  it("maps a linked v2 target benefit into a read-only semantic value and catalog target", async () => {
    const client = clientFor({
      promotions: [
        promotion("legacy", "promotion-engine.v1"),
        mirror("mirror", "legacy", 5_000),
      ],
      price_lists: priceLists(),
      price_entries: priceEntries(),
    });

    await expect(createSupabaseAdminPromotionsDataPort(client).listPromotions())
      .resolves.toEqual([expect.objectContaining({
        id: "legacy",
        systemManaged: true,
        readOnly: true,
        v2Mirror: { id: "mirror", status: "active" },
        semanticBenefit: {
          kind: "target_percentage",
          valueBps: 5_000,
          reference: "catalog_list_price",
          unitTargets: [{
            variantId: "variant-1",
            sku: "OPENLUP-DOG-BEEF-CAN-400G",
            referenceMinor: 1_490,
            targetMinor: 745,
            currency: "PLN",
          }],
        },
      })]);
  });

  it("fails closed for a linked mirror whose semantic metadata is malformed", async () => {
    const malformed = {
      ...mirror("mirror", "legacy", 5_000),
      benefit_value_bps: 10_000,
    };
    const client = clientFor({ promotions: [promotion("legacy", "promotion-engine.v1"), malformed] });

    await expect(createSupabaseAdminPromotionsDataPort(client).listPromotions())
      .resolves.toEqual([expect.objectContaining({
        id: "legacy",
        systemManaged: true,
        readOnly: true,
        semanticBenefit: {
          kind: "unavailable",
          reason: "system_managed_metadata_incomplete",
        },
      })]);
  });

  it("never exposes or edits the technical legacy percentage when its mirror is missing", async () => {
    const technical = promotion("legacy", "promotion-engine.v1");
    const listClient = clientFor({ promotions: [technical] });

    await expect(createSupabaseAdminPromotionsDataPort(listClient).listPromotions())
      .resolves.toEqual([expect.objectContaining({
        systemManaged: true,
        readOnly: true,
        semanticBenefit: {
          kind: "unavailable",
          reason: "system_managed_metadata_incomplete",
        },
      })]);

    const linked = chain({ data: [], error: null });
    const current = chain({ data: [technical], error: null });
    const updateClient = {
      from: vi.fn()
        .mockReturnValueOnce(linked)
        .mockReturnValueOnce(current),
      rpc: vi.fn(),
    } as unknown as AdminPromotionsSupabaseClient;

    await expect(createSupabaseAdminPromotionsDataPort(updateClient)
      .updatePromotion("legacy", { discountValue: 80 }))
      .rejects.toEqual(new DomainRpcError("P0001", "system_managed_promotion_read_only"));
  });

  it("keeps ordinary unlinked legacy promotions editable with a semantic percentage", async () => {
    const ordinary = {
      ...promotion("legacy", "promotion-engine.v1"),
      name: "Bundle 5%",
      discount_value: 5,
      eligibility: { checkout_mode: "one_time" },
    };
    const client = clientFor({ promotions: [ordinary] });

    await expect(createSupabaseAdminPromotionsDataPort(client).listPromotions())
      .resolves.toEqual([expect.objectContaining({
        id: "legacy",
        systemManaged: false,
        readOnly: false,
        semanticBenefit: { kind: "percentage", valuePercent: 5 },
      })]);
  });

  it("rejects direct updates when any v2 mirror owns the legacy row", async () => {
    const guard = chain({ data: [{ id: "mirror" }], error: null });
    const client = {
      from: vi.fn(() => guard),
      rpc: vi.fn(),
    } as unknown as AdminPromotionsSupabaseClient;

    const update = createSupabaseAdminPromotionsDataPort(client)
      .updatePromotion("legacy", { discountValue: 80 });

    await expect(update).rejects.toEqual(
      new DomainRpcError("P0001", "system_managed_promotion_read_only"),
    );
    expect(guard.update).not.toHaveBeenCalled();
  });

  it("allows the deliberate status flip on the v2 mirror row itself", async () => {
    const mirrorRow = mirror("mirror", "legacy", 5_000);
    const linked = chain({ data: [], error: null });
    const current = chain({ data: [mirrorRow], error: null });
    const update = chain({ data: null, error: null });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(linked)
        .mockReturnValueOnce(current)
        .mockReturnValueOnce(update),
      rpc: vi.fn(),
    } as unknown as AdminPromotionsSupabaseClient;

    await expect(createSupabaseAdminPromotionsDataPort(client)
      .updatePromotion("mirror", { status: "active" })).resolves.toBeUndefined();
    expect(update.update).toHaveBeenCalledWith({ status: "active" });
  });

  it("rejects any non-status edit of the v2 mirror row at the data boundary", async () => {
    const mirrorRow = mirror("mirror", "legacy", 5_000);
    const linked = chain({ data: [], error: null });
    const current = chain({ data: [mirrorRow], error: null });
    const update = chain({ data: null, error: null });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(linked)
        .mockReturnValueOnce(current)
        .mockReturnValueOnce(update),
      rpc: vi.fn(),
    } as unknown as AdminPromotionsSupabaseClient;

    await expect(createSupabaseAdminPromotionsDataPort(client)
      .updatePromotion("mirror", { status: "active", name: "renamed mirror" }))
      .rejects.toEqual(new DomainRpcError("P0001", "system_managed_mirror_status_only"));
    expect(update.update).not.toHaveBeenCalled();
  });

  it("still updates an ordinary legacy promotion after both ownership checks pass", async () => {
    const ordinary = {
      ...promotion("coupon", "promotion-engine.v1"),
      trigger_type: "coupon_code",
      discount_value: 10,
      eligibility: {},
    };
    const linked = chain({ data: [], error: null });
    const current = chain({ data: [ordinary], error: null });
    const update = chain({ data: null, error: null });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(linked)
        .mockReturnValueOnce(current)
        .mockReturnValueOnce(update),
      rpc: vi.fn(),
    } as unknown as AdminPromotionsSupabaseClient;

    await expect(createSupabaseAdminPromotionsDataPort(client)
      .updatePromotion("coupon", { discountValue: 15 })).resolves.toBeUndefined();
    expect(update.update).toHaveBeenCalledWith({ discount_value: 15 });
  });
});

function promotion(id: string, engine: string) {
  return {
    id,
    code: null,
    name: "First Subscription 50%",
    trigger_type: "automatic",
    discount_type: "percentage",
    discount_value: 44.404,
    applies_to_kind: "order_total",
    stacking_rule: "exclusive",
    eligibility: { first_subscription_purchase: true },
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    status: "active",
    region_availability: ["PL"],
    redemption_limit_global: null,
    redemption_limit_per_customer: 1,
    promotion_engine_version: engine,
  };
}

function mirror(id: string, legacyId: string, valueBps: number) {
  return {
    ...promotion(id, "promotion-engine.v2"),
    v2_mirror_of: legacyId,
    benefit_lane: "product",
    benefit_kind: "target_percentage",
    benefit_value_bps: valueBps,
  };
}

// The band resolves through the strict price authority (see
// `adminPromotionSubscriptionBand.ts`), so these rows carry what that authority
// reads: the active list, the exact `gross` base anchor and the effective
// interval. With no policy revision for this list the authority answers
// `subscription_legacy`, which is the stored 1340 below.
function priceEntries() {
  const shared = {
    price_list_id: "list-1",
    variant_id: "variant-1",
    min_qty: 1,
    amount_kind: "gross",
    active: true,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    catalog_skus: { sku: "OPENLUP-DOG-BEEF-CAN-400G" },
  };
  return [
    { ...shared, id: "entry-one-time", mode: "one_time", unit_price_minor: 1_490 },
    { ...shared, id: "entry-subscription", mode: "subscription", unit_price_minor: 1_340 },
  ];
}

function priceLists() {
  return [{
    id: "list-1", region_code: PLATFORM_DEFAULT_REGION, currency: PLATFORM_DEFAULT_CURRENCY, status: "active",
    created_at: "2026-01-01T00:00:00.000Z", valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
  }];
}

/** Filters like PostgREST: the band's price-authority reads separate the base row
 *  from the subscription row by `mode`, so a filter-blind fake would hand both to
 *  a query that asked for one and refuse the whole band as ambiguous. */
function clientFor(results: Record<string, unknown[]>): AdminPromotionsSupabaseClient {
  return {
    from: (table: string) => filteringChain((results[table] ?? []) as Record<string, unknown>[]),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as AdminPromotionsSupabaseClient;
}

function filteringChain(rows: Record<string, unknown>[]) {
  let scoped = [...rows];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      scoped = scoped.filter((row) => row[column] === value);
      return query;
    }),
    in: vi.fn((column: string, values: unknown[]) => {
      scoped = scoped.filter((row) => values.includes(row[column]));
      return query;
    }),
    order: vi.fn(() => query),
    limit: vi.fn((count: number) => {
      scoped = scoped.slice(0, count);
      return query;
    }),
    update: vi.fn(() => query),
    insert: vi.fn(() => query),
    then: <TResult>(onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult) | null) =>
      Promise.resolve({ data: scoped, error: null }).then(onfulfilled),
  };
  return query;
}

function chain(result: { data: unknown; error: unknown }) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    update: vi.fn(() => query),
    insert: vi.fn(() => query),
    then: <TResult1 = typeof result, TResult2 = never>(
      onfulfilled?: ((value: typeof result) => TResult1 | PromiseLike<TResult1>) | null,
      _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(result).then(onfulfilled),
  };
  return query;
}
