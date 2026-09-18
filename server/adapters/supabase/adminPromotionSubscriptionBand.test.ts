import { describe, expect, it, vi } from "vitest";

import { digestSubscriptionPricePolicy } from "../../../src/domains/pricing/subscriptionPricePolicy.js";
import { readSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";

import { listSubscriptionBandEntries } from "./adminPromotionSubscriptionBand.js";
import type { AdminPromotionsSupabaseClient } from "./adminPromotions.js";

const SETTLEMENT = readSettlementProfile({});
const LIST_ID = "00000000-0000-4000-8000-000000000001";
const POLICY_ID = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-09-09T10:00:00.000Z";

type Row = Record<string, unknown>;

describe("admin subscription band", () => {
  it("derives the subscription price from the effective policy when every stored subscription row is closed", async () => {
    // The live settlement shape on 2026-09-09: one_time 1490 active, a policy
    // revision effective 2026-09-07T16:02Z, every `mode='subscription'` row closed.
    const client = clientFor({
      price_lists: [priceList()],
      price_entries: [oneTime()],
      subscription_price_policy_revisions: [await policyRow()],
    });

    await expect(listSubscriptionBandEntries(client, SETTLEMENT, { now: () => NOW })).resolves.toEqual([{
      variantId: "variant-alpha",
      sku: "SKU-ALPHA-400G",
      oneTimeMinor: 1_490,
      subscriptionMinor: 1_340,
      percent: 10,
    }]);
  });

  it("returns the stored subscription price for a list that has no policy history at all", async () => {
    const client = clientFor({
      price_lists: [priceList()],
      price_entries: [oneTime(), storedSubscription(1_400)],
      subscription_price_policy_revisions: [],
    });

    await expect(listSubscriptionBandEntries(client, SETTLEMENT, { now: () => NOW }))
      .resolves.toEqual([expect.objectContaining({ subscriptionMinor: 1_400, percent: 6 })]);
  });

  it.each(["future", "gap"])("refuses a %s policy even with a stored subscription row", async (shape) => {
    const future = await policyRow({ effective_from: "2026-12-01T00:00:00.000Z" });
    const history = shape === "future" ? [future] : [
      await policyRow({ effective_to: NOW }), future,
    ];
    const client = clientFor({
      price_lists: [priceList()],
      price_entries: [oneTime(), storedSubscription(1_400)],
      subscription_price_policy_revisions: history,
    });
    await expect(listSubscriptionBandEntries(client, SETTLEMENT, { now: () => NOW })).resolves.toEqual([]);
  });

  it.each([
    ["future", { valid_from: "2026-12-01T00:00:00.000Z" }],
    ["expired", { valid_to: NOW }],
  ])("ignores a newer %s list and uses the effective list's variants", async (_name, dates) => {
    const client = clientFor({
      price_lists: [priceList(), priceList({
        id: "other-list", created_at: NOW, ...dates,
      })],
      price_entries: [oneTime(), storedSubscription(1_400), oneTime({
        price_list_id: "other-list", variant_id: "other-variant", sku: "OTHER-SKU",
      })],
    });
    await expect(listSubscriptionBandEntries(client, SETTLEMENT, { now: () => NOW }))
      .resolves.toEqual([expect.objectContaining({ variantId: "variant-alpha", subscriptionMinor: 1_400 })]);
  });

  it.each([
    ["future only", [priceList({ valid_from: "2026-12-01T00:00:00.000Z" })]],
    ["expired only", [priceList({ valid_to: NOW })]],
    ["ambiguous", [priceList(), priceList({ id: "other-list" })]],
  ])("returns no entries for %s lists", async (_name, lists) => {
    const client = clientFor({
      price_lists: lists,
      price_entries: [oneTime(), storedSubscription(1_400)],
    });
    await expect(listSubscriptionBandEntries(client, SETTLEMENT, { now: () => NOW })).resolves.toEqual([]);
  });

  it("uses one captured instant at the list and policy start boundaries", async () => {
    const now = vi.fn().mockReturnValueOnce(NOW).mockReturnValue("2026-12-01T00:00:00.000Z");
    const client = clientFor({
      price_lists: [priceList({ valid_from: NOW, valid_to: "2026-10-01T00:00:00.000Z" })],
      price_entries: [oneTime()],
      subscription_price_policy_revisions: [await policyRow({ effective_from: NOW })],
    });
    await expect(listSubscriptionBandEntries(client, SETTLEMENT, { now }))
      .resolves.toEqual([expect.objectContaining({ subscriptionMinor: 1_340 })]);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it.each(["price_lists", "price_entries", "subscription_price_policy_revisions"])(
    "propagates a provider failure reading %s", async (table) => {
      const client = clientFor({
        price_lists: [priceList()], price_entries: [oneTime()],
      }, table);
      await expect(listSubscriptionBandEntries(client, SETTLEMENT, { now: () => NOW }))
        .rejects.toThrow("read unavailable");
    },
  );

  it("skips only the variant the authority refuses and orders the rest by sku", async () => {
    // `variant-charlie` carries two active exact base entries, so the strict
    // authority refuses it (base_price_ambiguous). One unpriceable SKU must not
    // blank the band and with it the Code Center's whole preview context.
    const client = clientFor({
      price_lists: [priceList()],
      price_entries: [
        oneTime({ id: "entry-bravo", variant_id: "variant-bravo", sku: "SKU-BRAVO-400G" }),
        oneTime({ id: "entry-charlie-a", variant_id: "variant-charlie", sku: "SKU-CHARLIE-400G" }),
        oneTime({ id: "entry-charlie-b", variant_id: "variant-charlie", sku: "SKU-CHARLIE-400G", unit_price_minor: 1_590 }),
        oneTime(),
      ],
      subscription_price_policy_revisions: [await policyRow()],
    });

    await expect(listSubscriptionBandEntries(client, SETTLEMENT, { now: () => NOW }))
      .resolves.toEqual([
        expect.objectContaining({ sku: "SKU-ALPHA-400G", subscriptionMinor: 1_340 }),
        expect.objectContaining({ sku: "SKU-BRAVO-400G", subscriptionMinor: 1_340 }),
      ]);
  });

  it("returns an empty band when this market has no active price list", async () => {
    const client = clientFor({ price_lists: [], price_entries: [oneTime()] });
    await expect(listSubscriptionBandEntries(client, SETTLEMENT, { now: () => NOW })).resolves.toEqual([]);
  });
});

function priceList(overrides: Row = {}): Row {
  return {
    id: LIST_ID,
    region_code: SETTLEMENT.regionCode,
    currency: SETTLEMENT.defaultCurrency,
    status: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    valid_from: "2026-06-01T00:00:00.000Z",
    valid_to: null,
    ...overrides,
  };
}

function oneTime(overrides: Row = {}): Row {
  return priceEntry({ id: "entry-alpha", mode: "one_time", unit_price_minor: 1_490, ...overrides });
}

function storedSubscription(unitPriceMinor: number, overrides: Row = {}): Row {
  return priceEntry({ id: "entry-alpha-sub", mode: "subscription", unit_price_minor: unitPriceMinor, ...overrides });
}

function priceEntry(overrides: Row & { sku?: string }): Row {
  const { sku = "SKU-ALPHA-400G", ...rest } = overrides;
  return {
    price_list_id: LIST_ID,
    variant_id: "variant-alpha",
    min_qty: 1,
    amount_kind: "gross",
    active: true,
    valid_from: "2026-06-03T00:00:00.000Z",
    valid_to: null,
    catalog_skus: { sku },
    ...rest,
  };
}

async function policyRow(overrides: Row = {}): Promise<Row> {
  const effectiveFrom = typeof overrides.effective_from === "string"
    ? overrides.effective_from
    : "2026-09-07T16:02:00.000Z";
  const canonical = {
    id: POLICY_ID,
    revisionNo: 1,
    priceListId: LIST_ID,
    regionCode: SETTLEMENT.regionCode,
    currency: SETTLEMENT.defaultCurrency,
    channel: "D2C",
    discountBps: 1_000,
    roundingQuantumMinor: 10,
    roundingRule: "FLOOR_TO_QUANTUM" as const,
    effectiveFrom,
    effectiveTo: typeof overrides.effective_to === "string" ? overrides.effective_to : null,
  };
  return {
    id: canonical.id,
    revision_no: canonical.revisionNo,
    price_list_id: canonical.priceListId,
    region_code: canonical.regionCode,
    currency: canonical.currency,
    channel: canonical.channel,
    discount_bps: canonical.discountBps,
    rounding_quantum_minor: canonical.roundingQuantumMinor,
    rounding_rule: canonical.roundingRule,
    digest: await digestSubscriptionPricePolicy(canonical),
    effective_from: effectiveFrom,
    effective_to: canonical.effectiveTo,
    ...overrides,
  };
}

/**
 * Filters the way PostgREST does, because both the band's own read and the strict
 * authority's three reads hit this one client: a fake that ignored `.eq("mode")`
 * would hand the authority a base and a subscription row for the same variant and
 * prove nothing about which query returned which.
 */
function clientFor(tables: Record<string, Row[]>, failingTable?: string): AdminPromotionsSupabaseClient {
  function builder(rows: Row[], error: Error | null) {
    let scoped = [...rows];
    const query = {
      select: (_columns: string) => query,
      eq(column: string, value: unknown) {
        scoped = scoped.filter((row) => row[column] === value);
        return query;
      },
      in(column: string, values: unknown[]) {
        scoped = scoped.filter((row) => values.includes(row[column]));
        return query;
      },
      order(column: string, options?: { ascending?: boolean }) {
        const direction = options?.ascending === false ? -1 : 1;
        scoped.sort((left, right) => direction * String(left[column]).localeCompare(String(right[column])));
        return query;
      },
      limit(count: number) {
        scoped = scoped.slice(0, count);
        return query;
      },
      update: (_values: Row) => query,
      insert: (_values: Row) => query,
      then: <TResult>(onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult) | null) =>
        Promise.resolve({ data: scoped, error }).then(onfulfilled),
    };
    return query;
  }
  return {
    from: (table: string) => builder(tables[table] ?? [], table === failingTable ? new Error("read unavailable") : null),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as AdminPromotionsSupabaseClient;
}
