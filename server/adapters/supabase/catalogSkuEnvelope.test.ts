import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CatalogSkuAuthorityError } from "../../../src/domains/catalog/catalogFoundationContracts.js";
import type { CatalogActiveSkuEnvelopeListQuery } from "../../../src/domains/catalog/ports.js";
import {
  CATALOG_ENVELOPE_FIXTURE,
  catalogSkuEnvelopeFixture,
  createCatalogSkuEnvelopeScaleFixture,
} from "../catalogSkuEnvelope.fixture.js";
import {
  createSupabaseCatalogSkuEnvelopeReadPort,
  type CatalogSkuEnvelopeSupabaseClient,
} from "./catalogSkuEnvelope.js";

const MANAGED_MIGRATION = "supabase/migrations/20260827220000_catalog_document_revision_foundation.sql";
const DETAIL_SKU_ID = CATALOG_ENVELOPE_FIXTURE.skuIds.grams400;

interface Call {
  table: string;
  columns: string;
  filters: Array<[string, string, unknown]>;
  orders: Array<{ column: string; ascending: boolean }>;
  limit: number | null;
}

interface ClientOptions {
  skus?: readonly Record<string, unknown>[];
  products?: readonly Record<string, unknown>[];
  revisions?: readonly Record<string, unknown>[];
  eans?: readonly Record<string, unknown>[];
}

function client(options: ClientOptions = {}): { calls: Call[]; client: CatalogSkuEnvelopeSupabaseClient } {
  const calls: Call[] = [];
  const rowsByTable: Record<string, readonly Record<string, unknown>[]> = {
    catalog_skus: options.skus ?? catalogSkuEnvelopeFixture.supabaseSkus,
    catalog_products: options.products ?? catalogSkuEnvelopeFixture.products,
    catalog_product_document_revisions: options.revisions ?? catalogSkuEnvelopeFixture.revisions,
    catalog_sku_eans: options.eans ?? catalogSkuEnvelopeFixture.supabaseEans,
  };
  return {
    calls,
    client: {
      from(table: string) {
        const call: Call = { table, columns: "", filters: [], orders: [], limit: null };
        calls.push(call);
        const builder = {
          select(columns: string) { call.columns = columns; return builder; },
          eq(column: string, value: unknown) { call.filters.push(["eq", column, value]); return builder; },
          or(filters: string) { call.filters.push(["or", "filters", filters]); return builder; },
          gt(column: string, value: unknown) { call.filters.push(["gt", column, value]); return builder; },
          in(column: string, values: readonly unknown[]) { call.filters.push(["in", column, values]); return builder; },
          order(column: string, options: { ascending: boolean }) { call.orders.push({ column, ascending: options.ascending }); return builder; },
          limit(count: number) { call.limit = count; return builder; },
          then(resolve: (value: { data: readonly Record<string, unknown>[]; error: null }) => unknown) {
            let rows = rowsByTable[table] ?? [];
            for (const [operator, column, value] of call.filters) {
              if (operator === "eq") rows = rows.filter((row) => row[column] === value);
              if (operator === "or" && value === "sellable_standalone.eq.true,sellable_in_subscription.eq.true") {
                rows = rows.filter((row) => row.sellable_standalone === true || row.sellable_in_subscription === true);
              }
              if (operator === "gt") rows = rows.filter((row) => String(row[column]) > String(value));
              if (operator === "in") {
                const values = new Set(value as readonly unknown[]);
                rows = rows.filter((row) => values.has(row[column]));
              }
            }
            rows = [...rows].sort((left, right) => {
              for (const { column, ascending } of call.orders) {
                const comparison = String(left[column]).localeCompare(String(right[column]));
                if (comparison !== 0) return ascending ? comparison : -comparison;
              }
              return 0;
            });
            return Promise.resolve({ data: call.limit === null ? rows : rows.slice(0, call.limit), error: null }).then(resolve);
          },
        };
        return builder;
      },
    } as unknown as CatalogSkuEnvelopeSupabaseClient,
  };
}

describe("Supabase catalog SKU envelope adapter", () => {
  it("selects SKU codes before pagination and excludes malformed unrelated rows from every authority read", async () => {
    const unrelated = Array.from({ length: 20 }, (_, index) => ({
      ...catalogSkuEnvelopeFixture.supabaseSkus[0],
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      product_id: "99999999-9999-4999-8999-999999999999",
      sku: `UNRELATED-${index}`,
      net_weight_g: null,
    }));
    const unrelatedProduct = {
      ...catalogSkuEnvelopeFixture.products[0], id: unrelated[0]!.product_id,
      primary_sku_id: unrelated[0]!.id, current_document_revision_id: "99999999-9999-4999-8999-999999999998",
    };
    const probe = client({
      skus: [...unrelated, ...catalogSkuEnvelopeFixture.supabaseSkus],
      products: [...catalogSkuEnvelopeFixture.products, unrelatedProduct],
      revisions: [...catalogSkuEnvelopeFixture.revisions, {
        ...catalogSkuEnvelopeFixture.revisions[0], id: unrelatedProduct.current_document_revision_id,
        product_id: unrelatedProduct.id, schema_id: "",
      }],
      eans: [...catalogSkuEnvelopeFixture.supabaseEans, ...unrelated.map((sku) => ({
        ...catalogSkuEnvelopeFixture.supabaseEans[0], catalog_sku_id: sku.id, ean: "invalid",
      }))],
    });
    const port = createSupabaseCatalogSkuEnvelopeReadPort(probe.client);
    const skuCodes = [CATALOG_ENVELOPE_FIXTURE.skus[2].code, CATALOG_ENVELOPE_FIXTURE.skus[0].code];
    const first = await port.listActiveSkuEnvelopes({ cursor: null, limit: 1, skuCodes });
    expect(first).toEqual({ items: [catalogSkuEnvelopeFixture.envelopes[0]], nextCursor: CATALOG_ENVELOPE_FIXTURE.skuIds.grams200 });
    const second = await port.listActiveSkuEnvelopes({ cursor: first.nextCursor, limit: 1, skuCodes });
    expect(second).toEqual({ items: [catalogSkuEnvelopeFixture.envelopes[2]], nextCursor: null });
    expect(probe.calls).toHaveLength(8);
    for (const offset of [0, 4]) {
      expect(probe.calls[offset]).toMatchObject({
        filters: expect.arrayContaining([["in", "sku", skuCodes]]),
        limit: 2,
        orders: [{ column: "id", ascending: true }],
      });
      expect(probe.calls[offset + 1]?.filters).toEqual([["in", "id", [CATALOG_ENVELOPE_FIXTURE.productId]]]);
      expect(probe.calls[offset + 2]?.filters).toEqual([["in", "id", [CATALOG_ENVELOPE_FIXTURE.documentId]]]);
      expect(probe.calls[offset + 3]?.filters).toEqual([["in", "catalog_sku_id", [offset === 0 ? first.items[0]!.sku.id : second.items[0]!.sku.id]]]);
    }
    expect(probe.calls[4]?.filters).toContainEqual(["gt", "id", first.nextCursor]);
  });

  it.each([
    { label: "invalid identifier", eans: [{ ...catalogSkuEnvelopeFixture.supabaseEans[1], ean: "invalid" }] },
    { label: "invalid document reference", revisions: [{ ...catalogSkuEnvelopeFixture.revisions[0], schema_id: "" }] },
  ])("continues refusing an enrolled row with $label", async ({ label: _label, ...options }) => {
    const probe = client(options);
    await expect(createSupabaseCatalogSkuEnvelopeReadPort(probe.client).listActiveSkuEnvelopes({
      cursor: null, limit: 10, skuCodes: [CATALOG_ENVELOPE_FIXTURE.skus[1].code],
    })).rejects.toThrow();
  });

  it("retains active and OR-sellability predicates within the selected scope", async () => {
    const skus = catalogSkuEnvelopeFixture.supabaseSkus.map((sku, index) => ({
      ...sku, sellable_standalone: index === 0, sellable_in_subscription: index === 1,
    }));
    const inactive = { ...skus[0], id: "99999999-9999-4999-8999-999999999999", sku: "INACTIVE-A", status: "archived" };
    const probe = client({ skus: [...skus, inactive] });
    const page = await createSupabaseCatalogSkuEnvelopeReadPort(probe.client).listActiveSkuEnvelopes({
      cursor: null, limit: 10, skuCodes: [...skus.map((sku) => sku.sku), inactive.sku],
    });
    expect(page.items.map(({ sku }) => [sku.code, sku.sellability])).toEqual([
      [skus[0]!.sku, { status: "active", oneTime: true, subscription: false }],
      [skus[1]!.sku, { status: "active", oneTime: false, subscription: true }],
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("keeps omitted scope, inventory, public pages and detail reads broad after a scoped call", async () => {
    const probe = client();
    const port = createSupabaseCatalogSkuEnvelopeReadPort(probe.client);
    await expect(port.listActiveSkuEnvelopes({ cursor: null, limit: 10, skuCodes: ["ABSENT-A"] }))
      .resolves.toEqual({ items: [], nextCursor: null });
    expect(probe.calls).toHaveLength(1);
    for (const list of [port.listActiveSkuEnvelopes, port.listSkuEnvelopes, port.listPublicActiveSkuEnvelopes]) {
      await expect(list({ cursor: null, limit: 10 })).resolves.toEqual({ items: catalogSkuEnvelopeFixture.envelopes, nextCursor: null });
    }
    await expect(port.listPublicActiveProductSkuEnvelopes(CATALOG_ENVELOPE_FIXTURE.productId, { cursor: null, limit: 10 }))
      .resolves.toEqual({ items: catalogSkuEnvelopeFixture.envelopes, nextCursor: null });
    await expect(port.getSkuEnvelopeById(DETAIL_SKU_ID)).resolves.toEqual(catalogSkuEnvelopeFixture.envelopes[1]);
    for (const call of probe.calls.slice(1).filter(({ table }) => table === "catalog_skus")) {
      expect(call.filters.some(([operator, column]) => operator === "in" && column === "sku")).toBe(false);
    }
  });

  it.each([
    { skuCodes: null }, { skuCodes: [] }, { skuCodes: "ITEM-A" },
    { skuCodes: ["ITEM-A", "ITEM-A"] }, { skuCodes: ["ITEM-A", " ITEM-A "] },
    { skuCodes: ["ITEM A"] }, { skuCodes: ["X".repeat(161)] },
    { skuCodes: Array.from({ length: 101 }, (_, index) => `ITEM-${index}`) },
  ])("refuses invalid scope before constructing any database query: %j", async ({ skuCodes }) => {
    const probe = client();
    await expect(createSupabaseCatalogSkuEnvelopeReadPort(probe.client).listActiveSkuEnvelopes({
      cursor: null, limit: 10, skuCodes,
    } as CatalogActiveSkuEnvelopeListQuery)).rejects.toThrow("catalog_active_sku_selection_invalid");
    expect(probe.calls).toHaveLength(0);
  });

  it("deeply projects one product, three architectural SKUs, and one document revision in four bulk queries", async () => {
    const probe = client();
    const page = await createSupabaseCatalogSkuEnvelopeReadPort(probe.client).listSkuEnvelopes({ cursor: null, limit: 3 });

    expect(page).toEqual({ items: catalogSkuEnvelopeFixture.envelopes, nextCursor: null });
    expect(probe.calls.map((call) => call.table)).toEqual([
      "catalog_skus", "catalog_products", "catalog_product_document_revisions", "catalog_sku_eans",
    ]);
    expect(probe.calls.map((call) => call.columns).join("\n")).not.toMatch(/document_payload|catalog_skus\s*\.\s*gtin/i);
    expectSelectedColumns(probe.calls);
  });

  it("pages only active, sellable SKU envelopes before identifier authority is read", async () => {
    const inactive = {
      ...catalogSkuEnvelopeFixture.supabaseSkus[0],
      id: "99999999-9999-4999-8999-999999999991",
      sku: "INACTIVE-400",
      status: "archived",
    };
    const unsellable = {
      ...catalogSkuEnvelopeFixture.supabaseSkus[0],
      id: "99999999-9999-4999-8999-999999999992",
      sku: "UNSELLABLE-400",
      sellable_standalone: false,
      sellable_in_subscription: false,
    };
    const probe = client({ skus: [...catalogSkuEnvelopeFixture.supabaseSkus, inactive, unsellable] });

    await expect(createSupabaseCatalogSkuEnvelopeReadPort(probe.client).listActiveSkuEnvelopes({
      cursor: null,
      limit: 10,
    })).resolves.toEqual({ items: catalogSkuEnvelopeFixture.envelopes, nextCursor: null });
    expect(probe.calls[0]).toMatchObject({
      table: "catalog_skus",
      filters: expect.arrayContaining([
        ["eq", "status", "active"],
        ["or", "filters", "sellable_standalone.eq.true,sellable_in_subscription.eq.true"],
      ]),
    });
    expect(probe.calls).toHaveLength(4);
  });

  it("keeps an active unsellable SKU discoverable and pages it by product without changing commerce reads", async () => {
    const unsellable = {
      ...catalogSkuEnvelopeFixture.supabaseSkus[0],
      id: "99999999-9999-4999-8999-999999999992",
      sku: "UNSELLABLE-200",
      sellable_standalone: false,
      sellable_in_subscription: false,
      is_addon: true,
    };
    const probe = client({
      skus: [...catalogSkuEnvelopeFixture.supabaseSkus, unsellable],
      eans: [
        ...catalogSkuEnvelopeFixture.supabaseEans,
        { ...catalogSkuEnvelopeFixture.supabaseEans[0], catalog_sku_id: unsellable.id, ean: "4006381333931" },
      ],
    });
    const port = createSupabaseCatalogSkuEnvelopeReadPort(probe.client);

    const publicPage = await port.listPublicActiveSkuEnvelopes({ cursor: null, limit: 10 });
    expect(publicPage.items).toHaveLength(4);
    expect(publicPage.items.at(-1)?.sku).toMatchObject({ code: "UNSELLABLE-200", isAddon: true });
    expect(probe.calls[0]?.filters).not.toContainEqual(["or", "filters", "sellable_standalone.eq.true,sellable_in_subscription.eq.true"]);

    const productPage = await port.listPublicActiveProductSkuEnvelopes(CATALOG_ENVELOPE_FIXTURE.productId, { cursor: null, limit: 10 });
    expect(productPage.items).toHaveLength(4);
    expect(probe.calls[4]?.filters).toContainEqual(["eq", "product_id", CATALOG_ENVELOPE_FIXTURE.productId]);
  });

  it.each([
    ["global", (port: ReturnType<typeof createSupabaseCatalogSkuEnvelopeReadPort>) => port.listPublicActiveSkuEnvelopes({ cursor: null, limit: 10 })],
    ["product-scoped", (port: ReturnType<typeof createSupabaseCatalogSkuEnvelopeReadPort>) => port.listPublicActiveProductSkuEnvelopes(CATALOG_ENVELOPE_FIXTURE.productId, { cursor: null, limit: 10 })],
  ] as const)("refuses a missing primary SKU in the %s public page", async (_name, list) => {
    const products = [{ ...catalogSkuEnvelopeFixture.products[0], primary_sku_id: null }];
    await expect(list(createSupabaseCatalogSkuEnvelopeReadPort(client({ products }).client)))
      .rejects.toMatchObject({ name: CatalogSkuAuthorityError.name, code: "catalog_sku_authority_primary_sku_invalid" });
  });

  it("filters an unsellable prefix in Supabase before applying the active-page limit", async () => {
    const unsellablePrefix = Array.from({ length: 600 }, (_, index) => ({
      ...catalogSkuEnvelopeFixture.supabaseSkus[0],
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sku: `UNSELLABLE-${String(index).padStart(4, "0")}`,
      sellable_standalone: false,
      sellable_in_subscription: false,
    }));
    const probe = client({ skus: [...unsellablePrefix, ...catalogSkuEnvelopeFixture.supabaseSkus] });

    await expect(createSupabaseCatalogSkuEnvelopeReadPort(probe.client).listActiveSkuEnvelopes({
      cursor: null,
      limit: 3,
    })).resolves.toEqual({ items: catalogSkuEnvelopeFixture.envelopes, nextCursor: null });
    expect(probe.calls[0]?.filters).toContainEqual([
      "or",
      "filters",
      "sellable_standalone.eq.true,sellable_in_subscription.eq.true",
    ]);
    expect(probe.calls).toHaveLength(4);
  });

  it("deeply projects the same detail envelope", async () => {
    const probe = client();
    await expect(createSupabaseCatalogSkuEnvelopeReadPort(probe.client).getSkuEnvelopeById(DETAIL_SKU_ID))
      .resolves.toEqual(catalogSkuEnvelopeFixture.envelopes[1]);
    expect(probe.calls).toHaveLength(4);
  });

  it("resolves exact SKU-code and primary-product-slug selectors in four queries", async () => {
    const byCode = client();
    await expect(createSupabaseCatalogSkuEnvelopeReadPort(byCode.client).getSkuEnvelope({
      kind: "sku_code",
      skuCode: "CATALOG-FOUNDATION-400",
    })).resolves.toEqual(catalogSkuEnvelopeFixture.envelopes[1]);
    expect(byCode.calls).toHaveLength(4);

    const bySlug = client();
    await expect(createSupabaseCatalogSkuEnvelopeReadPort(bySlug.client).getSkuEnvelope({
      kind: "primary_product_slug",
      productSlug: CATALOG_ENVELOPE_FIXTURE.product.slug,
    })).resolves.toEqual(catalogSkuEnvelopeFixture.envelopes[1]);
    expect(bySlug.calls).toHaveLength(4);
  });

  it.each([
    ["SKU absent", { skus: [] }, { kind: "sku_code", skuCode: "ABSENT-SKU" }, "catalog_sku_authority_sku_absent"],
    ["product absent", { products: [] }, { kind: "primary_product_slug", productSlug: "absent-product" }, "catalog_sku_authority_product_absent"],
    ["primary SKU absent", { products: [{ ...catalogSkuEnvelopeFixture.products[0], primary_sku_id: null }] }, { kind: "primary_product_slug", productSlug: CATALOG_ENVELOPE_FIXTURE.product.slug }, "catalog_sku_authority_primary_sku_invalid"],
    ["primary SKU belongs to another product", { skus: catalogSkuEnvelopeFixture.supabaseSkus.map((sku) => sku.id === DETAIL_SKU_ID ? { ...sku, product_id: "11111111-1111-4111-8111-000000000111" } : sku) }, { kind: "primary_product_slug", productSlug: CATALOG_ENVELOPE_FIXTURE.product.slug }, "catalog_sku_authority_primary_sku_invalid"],
    ["SKU selector ambiguous", { skus: [...catalogSkuEnvelopeFixture.supabaseSkus, { ...catalogSkuEnvelopeFixture.supabaseSkus[1], id: "22222222-2222-4444-8444-000000000444" }] }, { kind: "sku_code", skuCode: "CATALOG-FOUNDATION-400" }, "catalog_sku_authority_selector_ambiguous"],
    ["product selector ambiguous", { products: [...catalogSkuEnvelopeFixture.products, { ...catalogSkuEnvelopeFixture.products[0], id: "11111111-1111-4111-8111-000000000111" }] }, { kind: "primary_product_slug", productSlug: CATALOG_ENVELOPE_FIXTURE.product.slug }, "catalog_sku_authority_selector_ambiguous"],
  ] as const)("refuses %s with the shared selector authority code", async (_label, options, selector, code) => {
    await expect(createSupabaseCatalogSkuEnvelopeReadPort(client(options).client).getSkuEnvelope(selector))
      .rejects.toMatchObject({ name: CatalogSkuAuthorityError.name, code });
  });

  it.each([
    ["SKU absent", { skus: [] }, "catalog_sku_authority_sku_absent"],
    ["current document absent", { products: [{ ...catalogSkuEnvelopeFixture.products[0], current_document_revision_id: null }] }, "catalog_sku_authority_current_document_absent"],
    ["current document invalid", { revisions: [{ ...catalogSkuEnvelopeFixture.revisions[0], product_id: "99999999-9999-4999-8999-999999999999" }] }, "catalog_sku_authority_current_document_invalid"],
  ] as const)("refuses %s with the shared named authority code", async (_label, options, code) => {
    await expect(createSupabaseCatalogSkuEnvelopeReadPort(client(options).client).getSkuEnvelopeById(DETAIL_SKU_ID))
      .rejects.toMatchObject({ name: CatalogSkuAuthorityError.name, code });
  });

  it.each([
    ["absent", [], "catalog_sku_identifier_authority_absent"],
    ["ambiguous", [catalogSkuEnvelopeFixture.supabaseEans[1], { ...catalogSkuEnvelopeFixture.supabaseEans[1], ean: "5901234123457" }], "catalog_sku_identifier_authority_ambiguous"],
    ["invalid", [{ ...catalogSkuEnvelopeFixture.supabaseEans[1], ean: "5901234123450" }], "catalog_sku_identifier_authority_invalid"],
  ] as const)("has %s primary-GTIN authority parity", async (_label, eans, code) => {
    await expect(createSupabaseCatalogSkuEnvelopeReadPort(client({ eans }).client).getSkuEnvelopeById(DETAIL_SKU_ID))
      .rejects.toMatchObject({ name: CatalogSkuAuthorityError.name, code });
  });

  it("does not use the dormant managed GTIN column and rejects unsafe limits before querying", async () => {
    const probe = client();
    await expect(createSupabaseCatalogSkuEnvelopeReadPort(probe.client).listSkuEnvelopes({ cursor: null, limit: 0 }))
      .rejects.toThrow("catalog_sku_envelope_invalid_limit");
    expect(probe.calls).toHaveLength(0);
    expect(readFileSync(MANAGED_MIGRATION, "utf8")).not.toMatch(/catalog_skus\s*\.\s*gtin\b/i);
  });

  it("paginates 500 products, 5,000 SKUs and 10,000 identifiers without query growth", async () => {
    const scale = createCatalogSkuEnvelopeScaleFixture();
    expect(scale.products).toHaveLength(500);
    expect(scale.supabaseSkus).toHaveLength(5_000);
    expect(scale.supabaseEans).toHaveLength(10_000);
    expect(new Set(scale.supabaseSkus.map((sku) => sku.product_id)).size).toBe(500);
    expect(new Set(scale.supabaseEans.map((identifier) => identifier.ean)).size).toBe(10_000);

    const listing = client({
      skus: [...scale.supabaseSkus].reverse(),
      products: [...scale.products].reverse(),
      revisions: [...scale.revisions].reverse(),
      eans: [...scale.supabaseEans].reverse(),
    });
    const port = createSupabaseCatalogSkuEnvelopeReadPort(listing.client);
    let cursor: string | null = null;
    let seen = 0;
    const seenIds: string[] = [];
    const seenCodes: string[] = [];
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const before = listing.calls.length;
      const page = await port.listActiveSkuEnvelopes({ cursor, limit: 500 });
      expect(listing.calls.length - before).toBe(4);
      expect(page.items).toEqual(scale.envelopes.slice(pageNo * 500, (pageNo + 1) * 500));
      expect(page.nextCursor).toBe(pageNo === 9 ? null : scale.envelopes[(pageNo + 1) * 500 - 1]!.sku.id);
      seen += page.items.length;
      seenIds.push(...page.items.map(({ sku }) => sku.id));
      seenCodes.push(...page.items.map(({ sku }) => sku.code));
      cursor = page.nextCursor;
    }
    expect(seen).toBe(5_000);
    expect(cursor).toBeNull();
    expect(seenIds).toEqual(scale.envelopes.map(({ sku }) => sku.id));
    expect(seenCodes).toEqual(scale.envelopes.map(({ sku }) => sku.code));
    expect(new Set(seenIds).size).toBe(5_000);
    expect(new Set(seenCodes).size).toBe(5_000);
    expect(listing.calls.map((call) => call.columns).join("\n"))
      .not.toMatch(/document_payload|catalog_skus\s*\.\s*gtin/i);
    expectSelectedColumns(listing.calls);

    for (const [selector, expected] of [
      [{ kind: "sku_code", skuCode: scale.supabaseSkus[0]!.sku }, scale.envelopes[0]],
      [{ kind: "sku_code", skuCode: scale.supabaseSkus.at(-1)!.sku }, scale.envelopes.at(-1)],
      [{ kind: "primary_product_slug", productSlug: scale.products[0]!.slug }, scale.envelopes[0]],
      [{ kind: "primary_product_slug", productSlug: scale.products.at(-1)!.slug }, scale.envelopes[4_990]],
    ] as const) {
      const detail = client({ skus: [...scale.supabaseSkus].reverse(), products: [...scale.products].reverse(), revisions: [...scale.revisions].reverse(), eans: [...scale.supabaseEans].reverse() });
      await expect(createSupabaseCatalogSkuEnvelopeReadPort(detail.client).getSkuEnvelope(selector)).resolves.toEqual(expected);
      expect(detail.calls).toHaveLength(4);
      expectSelectedColumns(detail.calls);
    }

    await expect(createSupabaseCatalogSkuEnvelopeReadPort(client({ skus: scale.supabaseSkus, products: scale.products, revisions: scale.revisions, eans: scale.supabaseEans }).client)
      .getSkuEnvelope({ kind: "sku_code", skuCode: "ABSENT-SKU" }))
      .rejects.toMatchObject({ code: "catalog_sku_authority_sku_absent" });
    await expect(createSupabaseCatalogSkuEnvelopeReadPort(client({ skus: scale.supabaseSkus, products: scale.products, revisions: scale.revisions, eans: scale.supabaseEans }).client)
      .getSkuEnvelope({ kind: "primary_product_slug", productSlug: "absent-product" }))
      .rejects.toMatchObject({ code: "catalog_sku_authority_product_absent" });
  });
});

const EXPECTED_COLUMNS: Record<string, string> = {
  catalog_skus: "id, product_id, sku, net_weight_g, status, sellable_standalone, sellable_in_subscription, is_addon, asset_ref",
  catalog_products: "id, slug, primary_sku_id, current_document_revision_id",
  catalog_product_document_revisions: "id, product_id, revision_no, schema_id, document_ref, source_ref, digest",
  catalog_sku_eans: "catalog_sku_id, ean, kind, quantity, is_primary",
};

function expectSelectedColumns(calls: readonly Call[]): void {
  for (const call of calls) {
    expect(call.columns).toBe(EXPECTED_COLUMNS[call.table]);
    if (call.table === "catalog_skus") {
      expect(call.columns.split(/,\s*/u)).not.toContain("gtin");
    }
  }
}
