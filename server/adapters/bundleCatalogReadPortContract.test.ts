import { describe, expect, it } from "vitest";

import { createManagedBundleCatalogStore } from "./supabase/bundleCatalogStore.js";
import { createPostgresBundleCatalogStore } from "./postgres/bundleCatalogStore.js";
import type { BundleCatalogReadPort } from "../domains/bundle/bundleCatalogReadPort.js";

/**
 * The two shipped read adapters, driven through ONE scenario table.
 *
 * Each chain is given a scripted double seeded with ITS OWN row shapes — the
 * hosted API returns embedded relations, the direct chain returns flat joined
 * rows — over the same underlying catalogue. That is the whole point: the rows
 * disagree and the port's answers must not, or "a caller cannot tell them apart"
 * is a claim rather than a property.
 *
 * The one place they are ALLOWED to differ is the operator trail, because the two
 * chains keep different ledgers. That divergence is asserted per chain rather than
 * hidden, so a later wave that closes it has to come here and delete the exception.
 *
 * Vocabulary-neutral throughout: XTS currency, neutral slugs, no vendor names.
 */

const UPDATED_AT = "2026-08-12T10:00:00.000Z";
const VALID_FROM = "2026-08-01T00:00:00.000Z";

// ── the direct chain's double ────────────────────────────────────────────────
const DIRECT_ROWS: Array<[RegExp, Record<string, unknown>[]]> = [
  [/count\(\*\) AS total\s+FROM public\.catalog_bundles/, [{ total: "1" }]],
  [
    /FROM public\.catalog_bundles b\s+WHERE b\.code/,
    [directBundleRow()],
  ],
  [
    /FROM public\.catalog_bundles b\s+JOIN public\.catalog_bundle_prices/,
    [
      {
        id: "bundle-1",
        code: "starter-set",
        title: "Starter set",
        fulfillment_mode: "virtual",
        mode: "one_time",
        target_price_minor: 3333,
        price_list_id: "list-1",
        currency: "XTS",
      },
    ],
  ],
  [/FROM public\.catalog_bundles b/, [directBundleRow()]],
  [
    /FROM unnest/,
    [directComponentRow("unit-a", 3, 1000), directComponentRow("unit-b", 2, 700)],
  ],
  [
    /FROM public\.catalog_bundle_components c/,
    [directComponentRow("unit-a", 3, 1000), directComponentRow("unit-b", 2, 700)],
  ],
  [
    /SELECT p\.mode/,
    [
      {
        mode: "one_time",
        target_price_minor: 3333,
        currency: "XTS",
        amount_kind: "gross",
        active: true,
        valid_from: VALID_FROM,
        valid_to: null,
      },
    ],
  ],
  [/SELECT list\.id, list\.currency/, [{ id: "list-1", currency: "XTS" }]],
  [/FROM public\.price_lists/, [{ id: "list-1", currency: "XTS" }]],
  [
    /count\(\*\) AS total FROM public\.catalog_bundle_write_events/,
    [{ total: "1" }],
  ],
  [
    /FROM public\.catalog_bundle_write_events/,
    [
      {
        id: "event-1",
        bundle_code: "starter-set",
        action: "bundle_target_price_set",
        before_state: null,
        after_state: { targetPriceMinor: 3333 },
        created_at: UPDATED_AT,
      },
    ],
  ],
];

function directBundleRow() {
  return {
    id: "bundle-1",
    code: "starter-set",
    title: "Starter set",
    status: "active",
    fulfillment_mode: "virtual",
    updated_at: UPDATED_AT,
    component_count: "2",
    has_active_target_price: true,
    composition_constraint: {},
    metadata: {},
  };
}

function directComponentRow(sku: string, quantity: number, price: number) {
  return {
    bundle_id: "bundle-1",
    sku,
    title: `Unit ${sku}`,
    product_slug: `product-${sku}`,
    variant_id: `variant-${sku}`,
    quantity,
    is_addon: false,
    sort_order: 0,
    reference_unit_price_minor: price,
  };
}

function directPort(): BundleCatalogReadPort {
  return createPostgresBundleCatalogStore({
    query(text: string) {
      const match = DIRECT_ROWS.find(([pattern]) => pattern.test(text));
      if (!match) throw new Error(`unscripted statement: ${text}`);
      return Promise.resolve({ rows: match[1] } as never);
    },
  });
}

// ── the hosted chain's double ────────────────────────────────────────────────
const HOSTED_ROWS: Record<string, Record<string, unknown>[]> = {
  catalog_bundles: [
    {
      id: "bundle-1",
      code: "starter-set",
      title: "Starter set",
      status: "active",
      fulfillment_mode: "virtual",
      updated_at: UPDATED_AT,
      composition_constraint: {},
      metadata: {},
    },
  ],
  catalog_bundle_components: [
    hostedComponentRow("unit-a", 3),
    hostedComponentRow("unit-b", 2),
  ],
  catalog_bundle_prices: [
    {
      bundle_id: "bundle-1",
      mode: "one_time",
      target_price_minor: 3333,
      amount_kind: "gross",
      active: true,
      valid_from: VALID_FROM,
      valid_to: null,
      price_list_id: "list-1",
      price_lists: { currency: "XTS" },
    },
  ],
  price_entries: [
    // The lowest active tier wins; the higher tier must not be picked up.
    { variant_id: "variant-unit-a", price_list_id: "list-1", unit_price_minor: 1000, min_qty: 1 },
    { variant_id: "variant-unit-a", price_list_id: "list-1", unit_price_minor: 900, min_qty: 10 },
    { variant_id: "variant-unit-b", price_list_id: "list-1", unit_price_minor: 700, min_qty: 1 },
  ],
  price_lists: [{ id: "list-1", currency: "XTS" }],
  admin_audit_events: [
    {
      id: "event-1",
      action: "bundle_target_price_set",
      actor_kind: "human",
      actor_email: "operator@example.test",
      entity_id: "starter-set",
      old_value: null,
      new_value: { targetPriceMinor: 3333 },
      occurred_at: UPDATED_AT,
    },
  ],
};

function hostedComponentRow(sku: string, quantity: number) {
  return {
    bundle_id: "bundle-1",
    quantity,
    is_addon: false,
    sort_order: 0,
    // An embedded relation arrives as a row on a to-one join.
    catalog_skus: {
      id: `variant-${sku}`,
      sku,
      title: `Unit ${sku}`,
      catalog_products: { slug: `product-${sku}` },
    },
  };
}

function hostedPort(tables: string[] = []): BundleCatalogReadPort {
  return createManagedBundleCatalogStore({
    from(table: string) {
      tables.push(table);
      const rows = HOSTED_ROWS[table] ?? [];
      const chain: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve),
      };
      for (const method of ["select", "eq", "in", "or", "order", "range", "limit"]) {
        chain[method] = () => chain;
      }
      return chain as never;
    },
  });
}

const CHAINS: Array<[string, () => BundleCatalogReadPort]> = [
  ["hosted", () => hostedPort()],
  ["direct", directPort],
];

const EXPECTED_COMPONENTS = [
  {
    sku: "unit-a",
    title: "Unit unit-a",
    productSlug: "product-unit-a",
    variantId: "variant-unit-a",
    quantity: 3,
    isAddon: false,
    sortOrder: 0,
    referenceUnitPriceMinor: 1000,
  },
  {
    sku: "unit-b",
    title: "Unit unit-b",
    productSlug: "product-unit-b",
    variantId: "variant-unit-b",
    quantity: 2,
    isAddon: false,
    sortOrder: 0,
    referenceUnitPriceMinor: 700,
  },
];

describe.each(CHAINS)("bundle read port contract — %s chain", (_name, build) => {
  it("lists bundles with their component count and price state", async () => {
    const result = await build().listBundles({ status: "all", limit: 50, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.bundles).toEqual([
      {
        code: "starter-set",
        title: "Starter set",
        status: "active",
        fulfillmentMode: "virtual",
        componentCount: 2,
        hasActiveTargetPrice: true,
        updatedAt: UPDATED_AT,
      },
    ]);
  });

  it("returns the detail with every component priced against the resolved list", async () => {
    const bundle = await build().getBundle({ code: "starter-set" });

    expect(bundle).toMatchObject({
      code: "starter-set",
      resolvedCurrency: "XTS",
      resolvedPriceListId: "list-1",
      // `{}` is the stored empty envelope; unconstrained is null, not an envelope
      // with no kind, on both chains.
      compositionConstraint: null,
      metadata: {},
    });
    expect(bundle?.components).toEqual(EXPECTED_COMPONENTS);
    expect(bundle?.prices).toEqual([
      {
        mode: "one_time",
        targetPriceMinor: 3333,
        currency: "XTS",
        amountKind: "gross",
        active: true,
        validFrom: VALID_FROM,
        validTo: null,
      },
    ]);
  });

  it("returns the live sellable set, priced in its own currency", async () => {
    const feed = await build().listActiveBundleCompositions();

    expect(feed).toEqual([
      {
        code: "starter-set",
        title: "Starter set",
        fulfillmentMode: "virtual",
        currency: "XTS",
        targetPriceMinor: 3333,
        mode: "one_time",
        components: EXPECTED_COMPONENTS,
      },
    ]);
  });

  it("answers the same operator trail shape from two different ledgers", async () => {
    const history = await build().listBundleHistory({
      code: "starter-set",
      limit: 50,
      offset: 0,
    });

    expect(history.total).toBe(1);
    expect(history.events[0]).toMatchObject({
      id: "event-1",
      action: "bundle_target_price_set",
      entityId: "starter-set",
      newValue: { targetPriceMinor: 3333 },
      occurredAt: UPDATED_AT,
    });
  });
});

describe("bundle read port contract — named divergence", () => {
  it("only the hosted chain can name the actor kind", async () => {
    const hosted = await hostedPort().listBundleHistory({
      code: "starter-set",
      limit: 50,
      offset: 0,
    });
    const direct = await directPort().listBundleHistory({
      code: "starter-set",
      limit: 50,
      offset: 0,
    });

    expect(hosted.events[0]).toMatchObject({
      actorKind: "human",
      actorEmail: "operator@example.test",
    });
    // The self-hosted chain has no operator registry, so it records WHICH
    // principal wrote but never what kind of actor it was. Null, never invented.
    expect(direct.events[0]).toMatchObject({ actorKind: null, actorEmail: null });
  });

  it("reads only the relations the port contract names", async () => {
    const tables: string[] = [];
    await hostedPort(tables).getBundle({ code: "starter-set" });

    expect([...new Set(tables)].sort()).toEqual([
      "catalog_bundle_components",
      "catalog_bundle_prices",
      "catalog_bundles",
      "price_entries",
    ]);
  });
});
