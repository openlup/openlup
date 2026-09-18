import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG_PRICING_REGION } from "../../domains/catalog/catalogPricingJoin.js";
import { digestSubscriptionPricePolicy } from "../../../src/domains/pricing/subscriptionPricePolicy.js";
import { createPostgresCommercePriceAuthorityPort, createPostgresPricingResolverPort } from "./pricingResolver.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const LIST_ID = "00000000-0000-4000-8000-000000000001";
const POLICY_ID = "00000000-0000-4000-8000-000000000002";
const AT = "2026-08-12T00:00:00Z";
const AUTHORITY_REGION = DEFAULT_CATALOG_PRICING_REGION.regionCode;
const AUTHORITY_CURRENCY = DEFAULT_CATALOG_PRICING_REGION.currency;

function list() {
  return { id: LIST_ID, valid_from: "2026-01-01T00:00:00Z", valid_to: null };
}

function withRows(lists: Record<string, unknown>[], entries: Record<string, unknown>[]) {
  return createPostgresPricingResolverPort({
    async query(text) {
      if (text.includes("price_lists")) return { rows: lists };
      return { rows: entries };
    },
  });
}
function base(overrides: Record<string, unknown> = {}) {
  return {
    id: "base-entry", price_list_id: LIST_ID, variant_id: "variant-1", mode: "one_time", min_qty: 1,
    unit_price_minor: 1490, amount_kind: "gross", valid_from: "2026-01-01T00:00:00Z", valid_to: null,
    ...overrides,
  };
}

async function policy(overrides: Record<string, unknown> = {}) {
  const canonical = {
    id: POLICY_ID, revisionNo: 1, priceListId: LIST_ID, regionCode: AUTHORITY_REGION, currency: AUTHORITY_CURRENCY, channel: "D2C",
    discountBps: 1_000, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM" as const,
    // The writer pins this spelling; see catalog-pricing-policy-activation.ts.
    effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null,
  };
  return {
    id: canonical.id, revision_no: canonical.revisionNo, price_list_id: canonical.priceListId,
    region_code: canonical.regionCode, currency: canonical.currency, channel: canonical.channel,
    discount_bps: canonical.discountBps, rounding_quantum_minor: canonical.roundingQuantumMinor,
    rounding_rule: canonical.roundingRule, digest: await digestSubscriptionPricePolicy(canonical),
    // node-postgres returns `timestamptz` as a Date, so the column is a Date here
    // rather than the string the digest was computed over. That is what makes the
    // adapter's `iso()` load-bearing on this path; the previous fixture passed the
    // canonical string straight through and so never exercised it.
    effective_from: new Date(canonical.effectiveFrom),
    effective_to: canonical.effectiveTo === null ? null : new Date(canonical.effectiveTo),
    ...overrides,
  };
}

function authorityExecutor(stubs: {
  entries: Record<string, unknown>[];
  policies?: Record<string, unknown>[];
  lists?: Record<string, unknown>[];
}): PgQueryExecutor {
  return {
    async query(text, values = []) {
      if (text.includes("subscription_price_policy_revisions")) return { rows: stubs.policies ?? [] };
      if (text.includes("price_lists")) return { rows: stubs.lists ?? [list()] };
      if (text.includes("mode = 'one_time'")) {
        return { rows: stubs.entries.filter((entry) => entry.mode === "one_time" && entry.min_qty === 1) };
      }
      if (text.includes("mode = 'subscription'")) {
        return { rows: stubs.entries.filter((entry) =>
          entry.mode === "subscription" && entry.min_qty === 1 && entry.price_list_id === values[1]) };
      }
      const mode = values[1];
      return { rows: stubs.entries.filter((entry) => entry.mode === mode) };
    },
  };
}

describe("Postgres pricing resolver adapter", () => {
  it("uses the open-mode price when the requested mode has no matching tier", async () => {
    const calls: unknown[][] = [];
    const executor: PgQueryExecutor = {
      async query(text, values = []) {
        calls.push(values);
        if (text.includes("price_lists")) {
          return { rows: [{ id: "list-1", valid_from: "2026-01-01T00:00:00Z", valid_to: null }] };
        }
        const mode = values[1];
        return mode === "subscription"
          ? { rows: [] }
          : { rows: [{
              id: "entry-1",
              price_list_id: "list-1",
              variant_id: "variant-1",
              mode: "any",
              min_qty: 1,
              unit_price_minor: 1990,
              amount_kind: "gross",
              valid_from: "2026-01-01T00:00:00Z",
              valid_to: null,
            }] };
      },
    };

    const result = await createPostgresPricingResolverPort(executor).resolvePrice({
      variantId: "variant-1",
      mode: "subscription",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "PL",
      currency: "PLN",
      atTime: "2026-08-12T00:00:00Z",
    });

    expect(result).toMatchObject({ mode: "any", unitPriceMinor: 1990 });
    expect(calls.map((values) => values[1])).toEqual(["PLN", "subscription", "any"]);
  });

  it("reads one exact one-time base per catalog SKU without consulting any or tier rows", async () => {
    const calls: unknown[][] = [];
    const executor: PgQueryExecutor = {
      async query(text, values = []) {
        calls.push(values);
        if (text.includes("price_lists")) {
          return { rows: [{ id: "list-1", valid_from: "2026-01-01T00:00:00Z", valid_to: null }] };
        }
        expect(text).toContain("mode = 'one_time'");
        expect(text).toContain("min_qty = 1");
        expect(text).not.toContain("mode IN");
        return { rows: [
          { id: "direct-a", price_list_id: "list-1", variant_id: "variant-a", mode: "one_time", min_qty: 1, unit_price_minor: 2000, amount_kind: "gross", valid_from: "2026-01-01T00:00:00Z", valid_to: null },
          { id: "direct-b", price_list_id: "list-1", variant_id: "variant-b", mode: "one_time", min_qty: 1, unit_price_minor: 2100, amount_kind: "gross", valid_from: "2026-01-01T00:00:00Z", valid_to: null },
        ] };
      },
    };

    const resolved = await createPostgresPricingResolverPort(executor).listExactOneTimeBasePrices({
      variantIds: ["variant-a", "variant-b", "variant-a"], ...DEFAULT_CATALOG_PRICING_REGION, atTime: "2026-08-12T00:00:00Z",
    });

    expect([...resolved].map(([variantId, price]) => [variantId, price.mode, price.unitPriceMinor]))
      .toEqual([["variant-a", "one_time", 2000], ["variant-b", "one_time", 2100]]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]).toEqual(["variant-a", "variant-b"]);
    expect(calls[1]?.[1]).toBe("list-1");
  });

  it("refuses absent or ambiguous price LISTS in the strict catalog batch", async () => {
    // A list-level fault is a deployment fault, not a per-SKU data fault. It must
    // keep throwing: degrading it would blank every price at once and report success.
    const query = { variantIds: ["variant-1"], ...DEFAULT_CATALOG_PRICING_REGION, atTime: AT };

    await expect(withRows([], [base()]).listExactOneTimeBasePrices(query)).rejects
      .toMatchObject({ code: "active_price_list_not_found" });
    await expect(withRows([list(), { ...list(), id: "other-list" }], [base()]).listExactOneTimeBasePrices(query)).rejects
      .toMatchObject({ code: "active_price_list_ambiguous" });
  });

  it("degrades ONLY the offending SKU and prices the rest of the batch", async () => {
    // One mispriced SKU must not remove the whole storefront listing. The batch
    // resolves every healthy variant and simply omits the refused one, which the
    // catalog join renders as `not_configured` rather than as a price.
    const query = {
      variantIds: ["variant-1", "variant-healthy"], ...DEFAULT_CATALOG_PRICING_REGION, atTime: AT,
    };
    const healthy = base({ id: "healthy-entry", variant_id: "variant-healthy", unit_price_minor: 2400 });

    for (const [label, entries] of [
      ["base_price_not_found", [healthy]],
      ["base_price_ambiguous", [healthy, base(), base({ id: "duplicate-base" })]],
      ["base_price_amount_kind_invalid", [healthy, base({ amount_kind: "net" })]],
    ] as const) {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const resolved = await withRows([list()], [...entries]).listExactOneTimeBasePrices(query);

        expect([...resolved.keys()], label).toEqual(["variant-healthy"]);
        expect(resolved.get("variant-healthy")?.unitPriceMinor, label).toBe(2400);
        expect(resolved.has("variant-1"), label).toBe(false);
        // A silent degrade would turn a loud 503 into an invisible missing price.
        expect(info.mock.calls.map(([line]) => JSON.parse(String(line))), label).toEqual([{
          event: "catalog_list_price_sku_degraded",
          variant_id: "variant-1",
          refusal_code: label,
        }]);
      } finally {
        info.mockRestore();
      }
    }
  });
});

describe("Postgres strict commerce price authority", () => {
  const query = {
    variantId: "variant-1", regionCode: AUTHORITY_REGION, currency: AUTHORITY_CURRENCY, channel: "D2C", atTime: AT,
  } as const;

  it("matches managed authority's validated policy-derived result", async () => {
    const port = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base()], policies: [await policy()],
    }));

    await expect(port.resolvePrice({ ...query, mode: "subscription" })).resolves.toMatchObject({
      kind: "subscription_policy", unitPriceMinor: 1340,
      base: { priceEntryId: "base-entry", unitPriceMinor: 1490 },
      policy: { id: POLICY_ID },
    });
  });

  it("matches managed authority's no-history compatibility result", async () => {
    const port = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base(), base({ id: "legacy-subscription", mode: "subscription", unit_price_minor: 1340 })],
    }));

    await expect(port.resolvePrice({ ...query, mode: "subscription" })).resolves.toMatchObject({
      kind: "subscription_legacy", unitPriceMinor: 1340,
      legacyResolved: { priceEntryId: "legacy-subscription" },
    });
  });

  it.each([
    ["open-mode fallback", base({ id: "legacy-any", mode: "any" })],
    ["subscription tier", base({ id: "legacy-tier", mode: "subscription", min_qty: 2 })],
    ["another active price list", base({
      id: "legacy-other-list",
      price_list_id: "00000000-0000-4000-8000-000000000004",
      mode: "subscription",
    })],
  ])("refuses a %s instead of treating it as an exact legacy subscription entry", async (_label, rejected) => {
    const port = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base(), rejected],
    }));

    await expect(port.resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({
      code: "legacy_subscription_price_not_found",
    });
  });

  it("refuses duplicate exact legacy subscription entries", async () => {
    const port = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [
        base(),
        base({ id: "legacy-first", mode: "subscription" }),
        base({ id: "legacy-second", mode: "subscription" }),
      ],
    }));

    await expect(port.resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({
      code: "legacy_subscription_price_ambiguous",
    });
  });

  it("refuses missing or ambiguous exact base anchors", async () => {
    const missing = createPostgresCommercePriceAuthorityPort(authorityExecutor({ entries: [] }));
    const ambiguous = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base(), base({ id: "second-base" })],
    }));

    await expect(missing.resolvePrice({ ...query, mode: "one_time" })).rejects.toMatchObject({ code: "base_price_not_found" });
    await expect(ambiguous.resolvePrice({ ...query, mode: "one_time" })).rejects.toMatchObject({ code: "base_price_ambiguous" });
  });

  it("refuses a sole net base anchor before returning current money", async () => {
    const port = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base({ amount_kind: "net" })],
    }));

    await expect(port.resolvePrice({ ...query, mode: "one_time" })).rejects.toMatchObject({
      code: "base_price_amount_kind_invalid",
    });
  });

  it("refuses zero or multiple active price lists before inspecting base candidates", async () => {
    const noList = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base()], lists: [],
    }));
    const multipleLists = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base()],
      lists: [list(), { ...list(), id: "00000000-0000-4000-8000-000000000004" }],
    }));

    await expect(noList.resolvePrice({ ...query, mode: "one_time" })).rejects.toMatchObject({
      code: "active_price_list_not_found",
    });
    await expect(multipleLists.resolvePrice({ ...query, mode: "one_time" })).rejects.toMatchObject({
      code: "active_price_list_ambiguous",
    });
  });

  it("refuses history with zero/multiple effective, corrupt, or mismatched policy rows", async () => {
    const noEffective = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base(), base({ id: "legacy", mode: "subscription" })],
      policies: [await policy({ effective_from: "2027-01-01T00:00:00Z" })],
    }));
    const multiple = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base()],
      policies: [await policy(), await policy({ id: "00000000-0000-4000-8000-000000000003", revision_no: 2 })],
    }));
    const corrupt = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base()], policies: [await policy({ rounding_rule: "CEIL_TO_QUANTUM" })],
    }));
    const mismatch = createPostgresCommercePriceAuthorityPort(authorityExecutor({
      entries: [base()], policies: [await policy({ digest: "a".repeat(64) })],
    }));

    await expect(noEffective.resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({ code: "subscription_price_policy_not_effective" });
    await expect(multiple.resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({ code: "subscription_price_policy_ambiguous" });
    await expect(corrupt.resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({ code: "subscription_price_policy_invalid" });
    await expect(mismatch.resolvePrice({ ...query, mode: "subscription" })).rejects.toMatchObject({ code: "subscription_price_policy_digest_mismatch" });
  });
});
