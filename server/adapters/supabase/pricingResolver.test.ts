import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_CATALOG_PRICING_REGION } from "../../domains/catalog/catalogPricingJoin.js";
import { digestSubscriptionPricePolicy } from "../../../src/domains/pricing/subscriptionPricePolicy.js";
import { createSupabaseCommercePriceAuthorityPort, createSupabasePricingResolverPort } from "./pricingResolver.js";

interface PriceListRow {
  id: string;
  region_code: string;
  currency: string;
  status: string;
  valid_from: string;
  valid_to: string | null;
}

interface PriceEntryRow {
  id: string;
  price_list_id: string;
  variant_id: string;
  mode: string;
  min_qty: number;
  unit_price_minor: number;
  amount_kind: string;
  active: boolean;
  valid_from: string;
  valid_to: string | null;
}

interface SubscriptionPricePolicyRow {
  id: string;
  revision_no: number;
  price_list_id: string;
  region_code: string;
  currency: string;
  channel: string;
  discount_bps: number;
  rounding_quantum_minor: number;
  rounding_rule: string;
  digest: string;
  effective_from: string;
  effective_to: string | null;
}

const AUTHORITY_LIST_ID = "00000000-0000-4000-8000-000000000001";
const AUTHORITY_POLICY_ID = "00000000-0000-4000-8000-000000000002";
const AUTHORITY_AT = "2026-08-12T00:00:00Z";
const AUTHORITY_REGION = makeListRow().region_code;
const AUTHORITY_CURRENCY = makeListRow().currency;

function makeListRow(overrides: Partial<PriceListRow> = {}): PriceListRow {
  return {
    id: "list-pl",
    region_code: "PL",
    currency: "PLN",
    status: "active",
    valid_from: "2026-06-01T00:00:00Z",
    valid_to: null,
    ...overrides,
  };
}

function readBatch(price_lists: PriceListRow[], price_entries: PriceEntryRow[]) {
  return createSupabasePricingResolverPort({ client: makeClient({ price_lists, price_entries }) });
}
function makeEntryRow(overrides: Partial<PriceEntryRow> = {}): PriceEntryRow {
  return {
    id: "entry-1",
    price_list_id: "list-pl",
    variant_id: "variant-lamb",
    mode: "one_time",
    min_qty: 1,
    unit_price_minor: 1490,
    amount_kind: "gross",
    active: true,
    valid_from: "2026-06-03T00:00:00Z",
    valid_to: null,
    ...overrides,
  };
}

function authorityList(): PriceListRow {
  return makeListRow({ id: AUTHORITY_LIST_ID });
}

function authorityBase(overrides: Partial<PriceEntryRow> = {}): PriceEntryRow {
  return makeEntryRow({ id: "base-entry", price_list_id: AUTHORITY_LIST_ID, ...overrides });
}

async function makePolicyRow(overrides: Partial<SubscriptionPricePolicyRow> = {}): Promise<SubscriptionPricePolicyRow> {
  const canonical = {
    id: AUTHORITY_POLICY_ID,
    revisionNo: 1,
    priceListId: AUTHORITY_LIST_ID,
    regionCode: AUTHORITY_REGION,
    currency: AUTHORITY_CURRENCY,
    channel: "D2C",
    discountBps: 1_000,
    roundingQuantumMinor: 10,
    roundingRule: "FLOOR_TO_QUANTUM" as const,
    // The writer pins this form: catalog-pricing-policy-activation.ts renders
    // to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') and regex-checks `.\d{3}Z`, so a
    // digest is only ever computed over an instant spelled exactly like this.
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    effectiveTo: null,
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
    // ⛔ The column is NOT spelled the way the digest was computed. Deriving both
    // sides from one value is what made the previous fixture self-fulfilling: it
    // could not express a rendering difference, so it proved only that a row this
    // adapter itself rendered verifies. PostgREST hands back Postgres's own
    // rendering, and the adapter has to normalize it back.
    effective_from: postgrestInstant(canonical.effectiveFrom),
    effective_to: canonical.effectiveTo === null ? null : postgrestInstant(canonical.effectiveTo),
    ...overrides,
  };
}

/**
 * How PostgREST renders `timestamptz`: a numeric offset rather than `Z`, and a
 * fractional part that drops trailing zeros (so a whole second carries none).
 */
function postgrestInstant(instant: string): string {
  return instant.replace(
    /(\.\d+)?Z$/u,
    (_match, fraction?: string) => `${fraction && /[1-9]/u.test(fraction) ? fraction : ""}+00:00`,
  );
}

function makeClient(stubs: {
  price_lists: PriceListRow[];
  price_entries: PriceEntryRow[];
  subscription_price_policy_revisions?: SubscriptionPricePolicyRow[];
}, onRead?: (table: string) => void): SupabaseClient {
  const tables = {
    price_lists: [...stubs.price_lists],
    price_entries: [...stubs.price_entries],
    subscription_price_policy_revisions: [...(stubs.subscription_price_policy_revisions ?? [])],
  };

  function makeBuilder(rows: ReadonlyArray<Record<string, unknown>>) {
    let scoped: Record<string, unknown>[] = [...rows];
    const builder = {
      select(_columns: string) {
        return builder;
      },
      eq(column: string, value: unknown) {
        scoped = scoped.filter((row) => row[column] === value);
        return builder;
      },
      in(column: string, values: unknown[]) {
        scoped = scoped.filter((row) => values.includes(row[column]));
        return builder;
      },
      lte(column: string, value: unknown) {
        scoped = scoped.filter((row) => (row[column] as never) <= (value as never));
        return builder;
      },
      order(column: string, opts: { ascending: boolean }) {
        scoped.sort((a, b) => {
          const av = a[column] as never;
          const bv = b[column] as never;
          if (av < bv) return opts.ascending ? -1 : 1;
          if (av > bv) return opts.ascending ? 1 : -1;
          return 0;
        });
        return builder;
      },
      limit(count: number) {
        scoped = scoped.slice(0, count);
        return builder;
      },
      then(onFulfilled: (value: { data: Record<string, unknown>[]; error: null }) => unknown) {
        return Promise.resolve(onFulfilled({ data: scoped, error: null }));
      },
    };
    return builder;
  }

  return {
    from(table: string) {
      onRead?.(table);
      if (table === "price_lists") return makeBuilder(tables.price_lists as unknown as Record<string, unknown>[]);
      if (table === "price_entries") return makeBuilder(tables.price_entries as unknown as Record<string, unknown>[]);
      if (table === "subscription_price_policy_revisions") return makeBuilder(tables.subscription_price_policy_revisions as unknown as Record<string, unknown>[]);
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe("managed pricing resolver adapter", () => {
  it("returns the matching one_time price for qty=1, eligibleCartQty=1", async () => {
    const client = makeClient({
      price_lists: [makeListRow()],
      price_entries: [makeEntryRow()],
    });
    const port = createSupabasePricingResolverPort({ client });

    const resolved = await port.resolvePrice({
      variantId: "variant-lamb",
      mode: "one_time",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "PL",
      currency: "PLN",
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.unitPriceMinor).toBe(1490);
    expect(resolved?.matchedMinQty).toBe(1);
  });

  it("picks the highest matching tier when eligibleCartQty crosses a breakpoint (mix-bundle fix)", async () => {
    const client = makeClient({
      price_lists: [makeListRow()],
      price_entries: [
        makeEntryRow({ id: "entry-base", min_qty: 1, unit_price_minor: 1490 }),
        makeEntryRow({ id: "entry-tier14", min_qty: 14, unit_price_minor: 1290 }),
      ],
    });
    const port = createSupabasePricingResolverPort({ client });

    const resolved = await port.resolvePrice({
      variantId: "variant-lamb",
      mode: "one_time",
      lineQty: 7,
      eligibleCartQty: 14,
      regionCode: "PL",
      currency: "PLN",
    });

    expect(resolved?.unitPriceMinor).toBe(1290);
    expect(resolved?.matchedMinQty).toBe(14);
  });

  it("falls back to mode='any' when no entry exists for the requested mode", async () => {
    const client = makeClient({
      price_lists: [makeListRow()],
      price_entries: [
        makeEntryRow({ id: "entry-any", mode: "any", unit_price_minor: 1490 }),
      ],
    });
    const port = createSupabasePricingResolverPort({ client });

    const resolved = await port.resolvePrice({
      variantId: "variant-lamb",
      mode: "subscription",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "PL",
      currency: "PLN",
    });

    expect(resolved?.mode).toBe("any");
    expect(resolved?.unitPriceMinor).toBe(1490);
  });

  it("returns null when no entry matches and no fallback exists", async () => {
    const client = makeClient({
      price_lists: [makeListRow()],
      price_entries: [],
    });
    const port = createSupabasePricingResolverPort({ client });

    const resolved = await port.resolvePrice({
      variantId: "variant-unknown",
      mode: "one_time",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "PL",
      currency: "PLN",
    });

    expect(resolved).toBeNull();
  });

  it("reads one exact one-time base per catalog SKU and ignores any and tier rows", async () => {
    const client = makeClient({
      price_lists: [makeListRow()],
      price_entries: [
        makeEntryRow({ id: "any-a", variant_id: "variant-a", mode: "any", unit_price_minor: 1900 }),
        makeEntryRow({ id: "direct-a", variant_id: "variant-a", mode: "one_time", unit_price_minor: 2000 }),
        makeEntryRow({ id: "tier-b", variant_id: "variant-b", min_qty: 2, unit_price_minor: 1900 }),
        makeEntryRow({ id: "direct-b", variant_id: "variant-b", mode: "one_time", unit_price_minor: 2100 }),
      ],
    });
    const resolved = await createSupabasePricingResolverPort({ client }).listExactOneTimeBasePrices({
      variantIds: ["variant-a", "variant-b", "variant-a"], ...DEFAULT_CATALOG_PRICING_REGION, atTime: "2026-08-12T00:00:00Z",
    });

    expect([...resolved].map(([variantId, price]) => [variantId, price.mode, price.unitPriceMinor]))
      .toEqual([["variant-a", "one_time", 2000], ["variant-b", "one_time", 2100]]);
  });

  it("refuses absent or ambiguous price LISTS in the strict catalog batch", async () => {
    // Mirrors the Postgres adapter exactly: a list-level fault is a deployment
    // fault and must keep throwing. These two adapters are separately implemented
    // and are pinned to the same expectations so they cannot drift.
    const query = { variantIds: ["variant-lamb"], ...DEFAULT_CATALOG_PRICING_REGION, atTime: AUTHORITY_AT };

    await expect(readBatch([], [makeEntryRow()]).listExactOneTimeBasePrices(query)).rejects
      .toMatchObject({ code: "active_price_list_not_found" });
    await expect(readBatch([makeListRow(), makeListRow({ id: "list-other" })], [makeEntryRow()]).listExactOneTimeBasePrices(query)).rejects
      .toMatchObject({ code: "active_price_list_ambiguous" });
  });

  it("degrades ONLY the offending SKU and prices the rest of the batch", async () => {
    const query = {
      variantIds: ["variant-lamb", "variant-healthy"], ...DEFAULT_CATALOG_PRICING_REGION, atTime: AUTHORITY_AT,
    };
    const healthy = makeEntryRow({
      id: "entry-healthy", variant_id: "variant-healthy", unit_price_minor: 2400,
    });

    for (const [label, entries] of [
      ["base_price_not_found", [healthy]],
      ["base_price_ambiguous", [healthy, makeEntryRow(), makeEntryRow({ id: "entry-duplicate" })]],
      ["base_price_amount_kind_invalid", [healthy, makeEntryRow({ amount_kind: "net" })]],
    ] as const) {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const resolved = await readBatch([makeListRow()], [...entries]).listExactOneTimeBasePrices(query);

        expect([...resolved.keys()], label).toEqual(["variant-healthy"]);
        expect(resolved.get("variant-healthy")?.unitPriceMinor, label).toBe(2400);
        expect(resolved.has("variant-lamb"), label).toBe(false);
        expect(info.mock.calls.map(([line]) => JSON.parse(String(line))), label).toEqual([{
          event: "catalog_list_price_sku_degraded",
          variant_id: "variant-lamb",
          refusal_code: label,
        }]);
      } finally {
        info.mockRestore();
      }
    }
  });

  it("chunks a 5,000-SKU strict catalog price read into bounded 500-SKU managed queries", async () => {
    const reads: string[] = [];
    const client = makeClient({
      price_lists: [makeListRow()],
      price_entries: [],
    }, (table) => reads.push(table));
    const variantIds = Array.from({ length: 5_000 }, (_, index) => `variant-${index}`);

    // Chunking is this test's subject. It used to terminate on the per-SKU throw;
    // an unpriceable batch now degrades every SKU instead, so the read still walks
    // all ten pages and simply resolves nothing.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const resolved = await createSupabasePricingResolverPort({ client }).listExactOneTimeBasePrices({
        variantIds, ...DEFAULT_CATALOG_PRICING_REGION, atTime: "2026-08-12T00:00:00Z",
      });

      expect(resolved.size).toBe(0);
      expect(info).toHaveBeenCalledTimes(5_000);
    } finally {
      info.mockRestore();
    }

    expect(reads.filter((table) => table === "price_lists")).toHaveLength(1);
    expect(reads.filter((table) => table === "price_entries")).toHaveLength(10);
  });

  it("ignores price lists outside their validity window", async () => {
    const client = makeClient({
      price_lists: [makeListRow({ valid_to: "2026-06-03T00:00:00Z" })],
      price_entries: [makeEntryRow()],
    });
    const port = createSupabasePricingResolverPort({ client });

    const resolved = await port.resolvePrice({
      variantId: "variant-lamb",
      mode: "one_time",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "PL",
      currency: "PLN",
      atTime: "2026-06-04T10:00:00Z",
    });

    expect(resolved).toBeNull();
  });

  it("ignores expired entries and picks the newest active entry for the same tier", async () => {
    const client = makeClient({
      price_lists: [makeListRow()],
      price_entries: [
        makeEntryRow({
          id: "entry-expired",
          unit_price_minor: 990,
          valid_from: "2026-06-01T00:00:00Z",
          valid_to: "2026-06-03T00:00:00Z",
        }),
        makeEntryRow({
          id: "entry-old-active",
          unit_price_minor: 1490,
          valid_from: "2026-06-02T00:00:00Z",
        }),
        makeEntryRow({
          id: "entry-new-active",
          unit_price_minor: 1390,
          valid_from: "2026-06-04T00:00:00Z",
        }),
      ],
    });
    const port = createSupabasePricingResolverPort({ client });

    const resolved = await port.resolvePrice({
      variantId: "variant-lamb",
      mode: "one_time",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "PL",
      currency: "PLN",
      atTime: "2026-06-04T10:00:00Z",
    });

    expect(resolved?.priceEntryId).toBe("entry-new-active");
    expect(resolved?.unitPriceMinor).toBe(1390);
  });

  it("reads price_lists once across resolvePrice calls sharing region/currency/atTime", async () => {
    const base = makeClient({
      price_lists: [makeListRow()],
      price_entries: [
        makeEntryRow({ id: "e-lamb", variant_id: "variant-lamb" }),
        makeEntryRow({ id: "e-beef", variant_id: "variant-beef" }),
      ],
    });
    const calls = { price_lists: 0, price_entries: 0 };
    const client = { from(table: string) {
      if (table === "price_lists") calls.price_lists += 1;
      if (table === "price_entries") calls.price_entries += 1;
      return (base as unknown as { from(t: string): unknown }).from(table);
    } } as unknown as SupabaseClient;
    const port = createSupabasePricingResolverPort({ client });
    const q = { lineQty: 1, eligibleCartQty: 1, regionCode: "PL" as const, currency: "PLN" as const, atTime: "2026-06-10T10:00:00Z" };
    for (const variantId of ["variant-lamb", "variant-beef"]) {
      await port.resolvePrice({ ...q, variantId, mode: "one_time" });
      await port.resolvePrice({ ...q, variantId, mode: "subscription" });
    }
    expect(calls.price_lists).toBe(1);
    expect(calls.price_entries).toBeGreaterThan(1);
  });

  it("respects region/currency scoping — different price list never matches", async () => {
    const client = makeClient({
      price_lists: [makeListRow({ region_code: "EU", currency: "EUR" })],
      price_entries: [makeEntryRow()],
    });
    const port = createSupabasePricingResolverPort({ client });

    const resolved = await port.resolvePrice({
      variantId: "variant-lamb",
      mode: "one_time",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "PL",
      currency: "PLN",
    });

    expect(resolved).toBeNull();
  });
});

describe("managed strict commerce price authority", () => {
  const query = {
    variantId: "variant-lamb",
    regionCode: AUTHORITY_REGION,
    currency: AUTHORITY_CURRENCY,
    channel: "D2C",
    atTime: AUTHORITY_AT,
  } as const;

  it("returns the sole exact base anchor for one-time quotes", async () => {
    const port = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()],
      price_entries: [
        authorityBase(),
        authorityBase({ id: "tier-entry", min_qty: 2, unit_price_minor: 1300 }),
        authorityBase({ id: "open-entry", mode: "any" }),
      ],
    }) });

    await expect(port.resolvePrice({ ...query, mode: "one_time" })).resolves.toMatchObject({
      kind: "one_time",
      unitPriceMinor: 1490,
      base: { priceEntryId: "base-entry", matchedMinQty: 1, mode: "one_time" },
    });
  });

  it("derives subscription price only from the sole effective validated policy", async () => {
    const policy = await makePolicyRow();
    const port = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()],
      price_entries: [authorityBase()],
      subscription_price_policy_revisions: [policy],
    }) });

    await expect(port.resolvePrice({ ...query, mode: "subscription" })).resolves.toMatchObject({
      kind: "subscription_policy",
      unitPriceMinor: 1340,
      base: { unitPriceMinor: 1490 },
      policy: { id: AUTHORITY_POLICY_ID, digest: policy.digest },
    });
  });

  it("uses a legacy observation only when matching policy history is empty", async () => {
    const port = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()],
      price_entries: [
        authorityBase(),
        authorityBase({ id: "legacy-subscription", mode: "subscription", unit_price_minor: 1340 }),
      ],
    }) });

    await expect(port.resolvePrice({ ...query, mode: "subscription" })).resolves.toMatchObject({
      kind: "subscription_legacy",
      unitPriceMinor: 1340,
      legacyResolved: { priceEntryId: "legacy-subscription" },
    });
  });

  it.each([
    ["open-mode fallback", authorityBase({ id: "legacy-any", mode: "any" })],
    ["subscription tier", authorityBase({ id: "legacy-tier", mode: "subscription", min_qty: 2 })],
    ["another price list", authorityBase({
      id: "legacy-other-list",
      price_list_id: "00000000-0000-4000-8000-000000000004",
      mode: "subscription",
    })],
  ])("refuses a %s instead of treating it as an exact legacy subscription entry", async (_label, rejected) => {
    const port = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()],
      price_entries: [authorityBase(), rejected],
    }) });

    await expect(port.resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({
      code: "legacy_subscription_price_not_found",
    });
  });

  it("refuses duplicate exact legacy subscription entries", async () => {
    const port = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()],
      price_entries: [
        authorityBase(),
        authorityBase({ id: "legacy-first", mode: "subscription" }),
        authorityBase({ id: "legacy-second", mode: "subscription" }),
      ],
    }) });

    await expect(port.resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({
      code: "legacy_subscription_price_ambiguous",
    });
  });

  it("refuses missing and ambiguous exact base candidates", async () => {
    const missing = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()], price_entries: [],
    }) });
    const ambiguous = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()],
      price_entries: [authorityBase(), authorityBase({ id: "second-base" })],
    }) });

    await expect(missing.resolvePrice({ ...query, mode: "one_time" })).rejects.toMatchObject({ code: "base_price_not_found" });
    await expect(ambiguous.resolvePrice({ ...query, mode: "one_time" })).rejects.toMatchObject({ code: "base_price_ambiguous" });
  });

  it("refuses a sole net base anchor before returning current money", async () => {
    const port = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()],
      price_entries: [authorityBase({ amount_kind: "net" })],
    }) });

    await expect(port.resolvePrice({ ...query, mode: "one_time" })).rejects.toMatchObject({
      code: "base_price_amount_kind_invalid",
    });
  });

  it("refuses zero or multiple active price lists before inspecting base candidates", async () => {
    const noList = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [], price_entries: [authorityBase()],
    }) });
    const multipleLists = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList(), makeListRow({ id: "00000000-0000-4000-8000-000000000004" })],
      price_entries: [authorityBase()],
    }) });

    await expect(noList.resolvePrice({ ...query, mode: "one_time" })).rejects.toMatchObject({
      code: "active_price_list_not_found",
    });
    await expect(multipleLists.resolvePrice({ ...query, mode: "one_time" })).rejects.toMatchObject({
      code: "active_price_list_ambiguous",
    });
  });

  it("refuses policy history with zero or multiple effective revisions instead of using legacy", async () => {
    const future = await makePolicyRow({ effective_from: "2027-01-01T00:00:00Z" });
    const first = await makePolicyRow();
    const second = await makePolicyRow({
      id: "00000000-0000-4000-8000-000000000003",
      revision_no: 2,
    });
    const noEffective = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()],
      price_entries: [authorityBase(), authorityBase({ id: "legacy", mode: "subscription" })],
      subscription_price_policy_revisions: [future],
    }) });
    const multipleEffective = createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()],
      price_entries: [authorityBase(), authorityBase({ id: "legacy", mode: "subscription" })],
      subscription_price_policy_revisions: [first, second],
    }) });

    await expect(noEffective.resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({ code: "subscription_price_policy_not_effective" });
    await expect(multipleEffective.resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({ code: "subscription_price_policy_ambiguous" });
  });

  it("names corrupt and digest-mismatched effective policy revisions", async () => {
    const corrupt = await makePolicyRow({ rounding_rule: "CEIL_TO_QUANTUM" });
    const mismatch = await makePolicyRow({ digest: "a".repeat(64) });
    const withPolicy = (policy: SubscriptionPricePolicyRow) => createSupabaseCommercePriceAuthorityPort({ client: makeClient({
      price_lists: [authorityList()], price_entries: [authorityBase()], subscription_price_policy_revisions: [policy],
    }) });

    await expect(withPolicy(corrupt).resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({ code: "subscription_price_policy_invalid" });
    await expect(withPolicy(mismatch).resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({ code: "subscription_price_policy_digest_mismatch" });
  });
});
