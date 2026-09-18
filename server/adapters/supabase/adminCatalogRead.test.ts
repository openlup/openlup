import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CatalogProductDetail } from "../../../src/domains/commerce/adminCatalogReadContracts.js";
import { createSupabaseAdminCatalogReadDataPort } from "./adminCatalogRead.js";
import { CatalogRpcError } from "../../domains/commerce/adminCatalogDataPort.js";

type Row = Record<string, unknown>;

interface Seed {
  catalog_products: Row[];
  catalog_skus: Row[];
  catalog_product_document_revisions: Row[];
  price_entries: Row[];
  admin_audit_events: Row[];
}

/**
 * Minimal Supabase query-builder fake covering the subset the read port uses:
 * select (with optional {count}), eq, in, or (slug/name ILIKE), order, range,
 * and an embedded `price_lists(currency)` join. Thenable so `await query` works.
 */
function makeClient(seed: Seed): SupabaseClient {
  const client = {
    from(table: keyof Seed) {
      let rows = [...(seed[table] ?? [])];
      let count: number | null = null;
      let joinPriceList = false;

      const builder: Record<string, unknown> = {
        select(_cols: string, opts?: { count?: string }) {
          if (typeof _cols === "string" && /price_lists(?:![^(]+)?\(/u.test(_cols)) joinPriceList = true;
          if (opts?.count) count = 0; // set after filtering, in then()
          return builder;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((r) => r[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          rows = rows.filter((r) => values.includes(r[column]));
          return builder;
        },
        or(expr: string) {
          // expr: "slug.ilike.%term%,name.ilike.%term%"
          const term = expr.split("ilike.%")[1]?.split("%")[0] ?? "";
          rows = rows.filter(
            (r) =>
              String(r.slug ?? "").includes(term) || String(r.name ?? "").includes(term),
          );
          return builder;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          const asc = opts?.ascending !== false;
          rows = [...rows].sort((a, b) => {
            const av = String(a[column] ?? "");
            const bv = String(b[column] ?? "");
            return asc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
          return builder;
        },
        range(from: number, to: number) {
          count = rows.length; // exact count BEFORE the page slice
          rows = rows.slice(from, to + 1);
          return builder;
        },
        then(onFulfilled: (v: { data: unknown[]; error: null; count: number | null }) => unknown) {
          const data = joinPriceList
            ? rows.map((r) => ({ ...r, price_lists: { currency: r._currency ?? "PLN" } }))
            : rows;
          const finalCount = count !== null ? count : null;
          return Promise.resolve(onFulfilled({ data, error: null, count: finalCount }));
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return client;
}

const baseSeed: Seed = {
  catalog_products: [
    { id: "p1", slug: "duck", status: "draft", name: "Duck", allergens: ["duck"], marketing_content: { content: { species: "dog" } }, current_document_revision_id: "r1" },
    { id: "p2", slug: "salmon", status: "active", name: "Salmon", allergens: [], marketing_content: { content: { species: "cat" } }, current_document_revision_id: null },
  ],
  // The retired per-unit energy column is still SEEDED here and is deliberately
  // WRONG against the document: 480 implies 120 per 100 g for a 400 g unit, and the
  // document says 118. A read reporting 480 is reading the stale column; one
  // reporting 472 is reading the document. That disagreement is the whole fixture.
  catalog_skus: [
    { id: "v1", product_id: "p1", sku: "SKU-DUCK", status: "draft", pet_type: "dog", title: "Duck", net_weight_g: 400, format_code: "can", unit_form_code: "can", kcal_per_unit: 480, gtin: null },
    { id: "v2", product_id: "p2", sku: "SKU-SALMON", status: "active", pet_type: "cat", title: "Salmon", net_weight_g: 200, format_code: "can", unit_form_code: "can", kcal_per_unit: 300, gtin: "123" },
  ],
  catalog_product_document_revisions: [
    {
      id: "r1", product_id: "p1", revision_no: 5, schema_id: "product-document.v1", digest: "d1",
      document_payload: { energy: { unscaled: 118, scale: 0, unit: "KCAL_PER_100G" } },
    },
  ],
  price_entries: [
    { variant_id: "v2", mode: "one_time", unit_price_minor: 990, active: true, valid_from: "2026-06-01T00:00:00Z", valid_to: null, _currency: "PLN" },
    { variant_id: "v1", mode: "one_time", unit_price_minor: 1290, active: false, valid_from: "2026-05-01T00:00:00Z", valid_to: "2026-06-01T00:00:00Z", _currency: "PLN" },
  ],
  admin_audit_events: [
    { id: "e1", action: "create_draft", actor_kind: "machine", actor_email: null, source: "mcp_agent", entity_type: "catalog_product", entity_id: "duck", old_value: null, new_value: { slug: "duck" }, occurred_at: "2026-06-01T00:00:00Z" },
    { id: "e2", action: "set_price", actor_kind: "machine", actor_email: null, source: "mcp_agent", entity_type: "catalog_product", entity_id: "SKU-DUCK", old_value: null, new_value: { unit_price_minor: 1290 }, occurred_at: "2026-06-02T00:00:00Z" },
    { id: "eX", action: "create_draft", actor_kind: "machine", actor_email: null, source: "mcp_agent", entity_type: "catalog_product", entity_id: "salmon", old_value: null, new_value: {}, occurred_at: "2026-06-03T00:00:00Z" },
  ],
};

describe("supabaseAdminCatalogReadDataPort.list", () => {
  it("returns summaries with skuCount + hasActivePrice and a pre-page total", async () => {
    const port = createSupabaseAdminCatalogReadDataPort(makeClient(baseSeed));
    const result = await port.list({ status: "all", limit: 50, offset: 0 });
    expect(result.total).toBe(2);
    const duck = result.products.find((p) => p.slug === "duck");
    const salmon = result.products.find((p) => p.slug === "salmon");
    expect(duck).toMatchObject({ status: "draft", species: "dog", skuCount: 1, hasActivePrice: false });
    expect(salmon).toMatchObject({ status: "active", species: "cat", skuCount: 1, hasActivePrice: true });
  });

  it("filters by petType (a SKU attribute)", async () => {
    const port = createSupabaseAdminCatalogReadDataPort(makeClient(baseSeed));
    const result = await port.list({ status: "all", petType: "cat", limit: 50, offset: 0 });
    expect(result.products.map((p) => p.slug)).toEqual(["salmon"]);
    expect(result.total).toBe(1);
  });

  it("honors limit/offset pagination over the full total", async () => {
    const port = createSupabaseAdminCatalogReadDataPort(makeClient(baseSeed));
    const result = await port.list({ status: "all", limit: 1, offset: 1 });
    expect(result.total).toBe(2);
    expect(result.products).toHaveLength(1);
  });
});

describe("supabaseAdminCatalogReadDataPort.get", () => {
  it("assembles full detail incl. price history and computes readyToPublish", async () => {
    const port = createSupabaseAdminCatalogReadDataPort(makeClient(baseSeed));
    const detail = await port.get("salmon");
    expect(detail).toMatchObject({ slug: "salmon", status: "active", species: "cat", readyToPublish: true, publishBlockers: [] });
    expect(detail.skus[0].gtin).toBe("123");
    expect(detail.skus[0].priceEntries[0]).toMatchObject({ unitPriceMinor: 990, currency: "PLN", active: true });
  });

  /** The one field these three tests are about, named once. */
  const perUnitEnergy = (detail: CatalogProductDetail) => detail.skus[0].kcalPerUnit;

  it("derives the per-unit energy from the current document, not the stale column", async () => {
    const port = createSupabaseAdminCatalogReadDataPort(makeClient(baseSeed));
    // round(118 per 100 g * 400 g / 100) — the same arithmetic the money path runs.
    expect(perUnitEnergy(await port.get("duck"))).toBe(472);
  });

  it("reports a null per-unit energy when the product has no published document", async () => {
    // Fail closed. The retired column says 300 for this SKU; with no document there
    // is no energy authority, and an operator shown "unknown" is better served than
    // one shown a number the storefront would contradict.
    const port = createSupabaseAdminCatalogReadDataPort(makeClient(baseSeed));
    expect(perUnitEnergy(await port.get("salmon"))).toBeNull();
  });

  it("reports a null per-unit energy when the current pointer resolves to no revision", async () => {
    // The pointer is set but the revision row is gone (or moved under the read).
    // The guarded port refuses; the projection turns that refusal into null rather
    // than failing the whole admin read or falling back to the column.
    const port = createSupabaseAdminCatalogReadDataPort(
      makeClient({ ...baseSeed, catalog_product_document_revisions: [] }),
    );
    expect(perUnitEnergy(await port.get("duck"))).toBeNull();
  });

  it("flags publishBlockers when no SKU has an active price", async () => {
    const port = createSupabaseAdminCatalogReadDataPort(makeClient(baseSeed));
    const detail = await port.get("duck");
    expect(detail.readyToPublish).toBe(false);
    expect(detail.publishBlockers).toContain("price_required_to_sell");
  });

  it("throws a P0002 NOT_FOUND CatalogRpcError when the slug is missing", async () => {
    const port = createSupabaseAdminCatalogReadDataPort(makeClient(baseSeed));
    const error = await port.get("ghost").catch((e) => e);
    expect(error).toBeInstanceOf(CatalogRpcError);
    expect(error.sqlstate).toBe("P0002");
  });
});

describe("supabaseAdminCatalogReadDataPort.history", () => {
  it("returns events for the slug AND its sku codes, newest first", async () => {
    const port = createSupabaseAdminCatalogReadDataPort(makeClient(baseSeed));
    const result = await port.history({ slug: "duck", limit: 50, offset: 0 });
    expect(result.events.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(result.total).toBe(2);
    // the salmon event (eX) is excluded — different entity_id space
    expect(result.events.some((e) => e.id === "eX")).toBe(false);
  });
});
