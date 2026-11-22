import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CatalogSkuAuthorityError } from "../../../src/domains/catalog/catalogFoundationContracts.js";
import type { CatalogActiveSkuEnvelopeListQuery } from "../../../src/domains/catalog/ports.js";
import {
  CATALOG_ENVELOPE_FIXTURE,
  catalogSkuEnvelopeFixture,
  createCatalogSkuEnvelopeScaleFixture,
} from "../catalogSkuEnvelope.fixture.js";
import { createPostgresCatalogSkuEnvelopeReadPort } from "./catalogSkuEnvelope.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const PORTABLE_MIGRATION = "db/platform/migrations/20260827220000_catalog_document_revision_foundation.sql";
const DETAIL_SKU_ID = CATALOG_ENVELOPE_FIXTURE.skuIds.grams400;

interface ExecutorOptions {
  rows?: readonly Record<string, unknown>[];
  identifiers?: readonly Record<string, unknown>[];
}

function executor(options: ExecutorOptions = {}): { calls: Array<{ text: string; values: unknown[] }>; client: PgQueryExecutor } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const rows = options.rows ?? catalogSkuEnvelopeFixture.postgresRows;
  const identifiers = options.identifiers ?? catalogSkuEnvelopeFixture.postgresIdentifiers;
  return {
    calls,
    client: {
      async query(text, values = []) {
        calls.push({ text, values });
        if (text.includes("catalog_sku_identifiers")) {
          const requested = new Set(values[0] as string[]);
          return {
            rows: identifiers.filter((identifier) => requested.has(String(identifier.catalog_sku_id)))
              .sort((left, right) => String(left.catalog_sku_id).localeCompare(String(right.catalog_sku_id))
                || String(left.identifier_kind).localeCompare(String(right.identifier_kind))
                || Number(right.is_primary) - Number(left.is_primary)
                || String(left.issuer).localeCompare(String(right.issuer))
                || String(left.normalized_value).localeCompare(String(right.normalized_value))),
          };
        }
        if (text.includes("WHERE sku.id =")) {
          return { rows: rows.filter((row) => row.sku_id === values[0]) };
        }
        if (text.includes("WHERE sku.sku =")) {
          return { rows: rows.filter((row) => row.sku_code === values[0]).slice(0, 2) };
        }
        if (text.includes("WHERE product.slug =")) {
          return {
            rows: rows.filter((row) => row.product_slug === values[0] && (
              row.sku_id === row.primary_sku_id || row.sku_id === null
            )).slice(0, 2),
          };
        }
        const productScoped = text.includes("sku.product_id = $1::uuid");
        const [productId, cursor, limit] = productScoped
          ? values as [string, string | null, number]
          : [undefined, ...values] as [undefined, string | null, number];
        const activeOnly = text.includes("sku.status = 'active'");
        const sellableOnly = text.includes("sku.sellable_standalone OR sku.sellable_in_subscription");
        const skuCodes = text.includes("sku.sku = ANY($3::text[])") ? values[2] as readonly string[] | null : null;
        const listed = rows.filter((row) => (
          (!productScoped || row.sku_product_id === productId)
          && (!activeOnly || row.sku_status === "active")
          && (!sellableOnly || row.sellable_one_time === true || row.sellable_subscription === true)
          && (skuCodes == null || skuCodes.includes(String(row.sku_code)))
        ));
        return { rows: [...listed].sort((left, right) => String(left.sku_id).localeCompare(String(right.sku_id))).filter((row) => cursor === null || String(row.sku_id) > cursor).slice(0, limit) };
      },
    },
  };
}

describe("Postgres catalog SKU envelope adapter", () => {
  it("binds selected codes before pagination and excludes malformed unrelated rows from mapping and identifiers", async () => {
    const unrelated = Array.from({ length: 20 }, (_, index) => ({
      ...catalogSkuEnvelopeFixture.postgresRows[0],
      sku_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sku_code: `UNRELATED-${index}`,
      net_content_unscaled: null,
      document_schema_id: "",
    }));
    const probe = executor({
      rows: [...unrelated, ...catalogSkuEnvelopeFixture.postgresRows],
      identifiers: [...catalogSkuEnvelopeFixture.postgresIdentifiers, ...unrelated.map((row) => ({
        ...catalogSkuEnvelopeFixture.postgresIdentifiers[0], catalog_sku_id: row.sku_id, normalized_value: "invalid",
      }))],
    });
    const port = createPostgresCatalogSkuEnvelopeReadPort(probe.client);
    const skuCodes = [CATALOG_ENVELOPE_FIXTURE.skus[2].code, CATALOG_ENVELOPE_FIXTURE.skus[0].code];
    const first = await port.listActiveSkuEnvelopes({ cursor: null, limit: 1, skuCodes });
    expect(first).toEqual({ items: [catalogSkuEnvelopeFixture.envelopes[0]], nextCursor: CATALOG_ENVELOPE_FIXTURE.skuIds.grams200 });
    const second = await port.listActiveSkuEnvelopes({ cursor: first.nextCursor, limit: 1, skuCodes });
    expect(second).toEqual({ items: [catalogSkuEnvelopeFixture.envelopes[2]], nextCursor: null });
    expect(probe.calls).toHaveLength(4);
    for (const offset of [0, 2]) {
      const call = probe.calls[offset]!;
      expect(call.values).toEqual([offset === 0 ? null : first.nextCursor, 2, skuCodes]);
      expect(call.text).toContain("sku.sku = ANY($3::text[])");
      expect(call.text.indexOf("sku.sku = ANY")).toBeLessThan(call.text.indexOf("ORDER BY sku.id"));
      expect(call.text.indexOf("ORDER BY sku.id")).toBeLessThan(call.text.indexOf("LIMIT $2::integer"));
      for (const code of skuCodes) expect(call.text).not.toContain(code);
      expect(probe.calls[offset + 1]?.values).toEqual([[offset === 0 ? first.items[0]!.sku.id : second.items[0]!.sku.id]]);
    }
  });

  it.each([
    { label: "invalid identifier", identifiers: [{ ...catalogSkuEnvelopeFixture.postgresIdentifiers[1], normalized_value: "invalid" }] },
    { label: "invalid document reference", rows: [{ ...catalogSkuEnvelopeFixture.postgresRows[1], document_schema_id: "" }] },
  ])("continues refusing an enrolled row with $label", async ({ label: _label, ...options }) => {
    const probe = executor(options);
    await expect(createPostgresCatalogSkuEnvelopeReadPort(probe.client).listActiveSkuEnvelopes({
      cursor: null, limit: 10, skuCodes: [CATALOG_ENVELOPE_FIXTURE.skus[1].code],
    })).rejects.toThrow();
  });

  it("retains active and OR-sellability predicates within the selected scope", async () => {
    const rows = catalogSkuEnvelopeFixture.postgresRows.map((row, index) => ({
      ...row, sellable_one_time: index === 0, sellable_subscription: index === 1,
    }));
    const inactive = { ...rows[0], sku_id: "99999999-9999-4999-8999-999999999999", sku_code: "INACTIVE-A", sku_status: "archived" };
    const probe = executor({ rows: [...rows, inactive] });
    const page = await createPostgresCatalogSkuEnvelopeReadPort(probe.client).listActiveSkuEnvelopes({
      cursor: null, limit: 10, skuCodes: [...rows.map((row) => row.sku_code), inactive.sku_code],
    });
    expect(page.items.map(({ sku }) => [sku.code, sku.sellability])).toEqual([
      [rows[0]!.sku_code, { status: "active", oneTime: true, subscription: false }],
      [rows[1]!.sku_code, { status: "active", oneTime: false, subscription: true }],
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("keeps omitted scope, inventory, public pages and detail reads broad after a scoped call", async () => {
    const probe = executor();
    const port = createPostgresCatalogSkuEnvelopeReadPort(probe.client);
    await expect(port.listActiveSkuEnvelopes({ cursor: null, limit: 10, skuCodes: ["ABSENT-A"] }))
      .resolves.toEqual({ items: [], nextCursor: null });
    expect(probe.calls).toHaveLength(1);
    for (const list of [port.listActiveSkuEnvelopes, port.listSkuEnvelopes, port.listPublicActiveSkuEnvelopes]) {
      await expect(list({ cursor: null, limit: 10 })).resolves.toEqual({ items: catalogSkuEnvelopeFixture.envelopes, nextCursor: null });
    }
    expect(probe.calls[1]?.values).toEqual([null, 11, null]);
    expect(probe.calls[3]?.values).toEqual([null, 11]);
    expect(probe.calls[5]?.values).toEqual([null, 11]);
    await expect(port.listPublicActiveProductSkuEnvelopes(CATALOG_ENVELOPE_FIXTURE.productId, { cursor: null, limit: 10 }))
      .resolves.toEqual({ items: catalogSkuEnvelopeFixture.envelopes, nextCursor: null });
    expect(probe.calls[7]?.values).toEqual([CATALOG_ENVELOPE_FIXTURE.productId, null, 11]);
    await expect(port.getSkuEnvelopeById(DETAIL_SKU_ID)).resolves.toEqual(catalogSkuEnvelopeFixture.envelopes[1]);
  });

  it.each([
    { skuCodes: null }, { skuCodes: [] }, { skuCodes: "ITEM-A" },
    { skuCodes: ["ITEM-A", "ITEM-A"] }, { skuCodes: ["ITEM-A", " ITEM-A "] },
    { skuCodes: ["ITEM A"] }, { skuCodes: ["X".repeat(161)] },
    { skuCodes: Array.from({ length: 101 }, (_, index) => `ITEM-${index}`) },
  ])("refuses invalid scope before executing any database query: %j", async ({ skuCodes }) => {
    const probe = executor();
    await expect(createPostgresCatalogSkuEnvelopeReadPort(probe.client).listActiveSkuEnvelopes({
      cursor: null, limit: 10, skuCodes,
    } as CatalogActiveSkuEnvelopeListQuery)).rejects.toThrow("catalog_active_sku_selection_invalid");
    expect(probe.calls).toHaveLength(0);
  });

  it("deeply projects one product, three architectural SKUs, and one document revision in two bulk queries", async () => {
    const probe = executor();
    const page = await createPostgresCatalogSkuEnvelopeReadPort(probe.client).listSkuEnvelopes({ cursor: null, limit: 3 });

    expect(page).toEqual({ items: catalogSkuEnvelopeFixture.envelopes, nextCursor: null });
    expect(probe.calls).toHaveLength(2);
    expect(probe.calls.map((call) => call.text).join("\n")).not.toMatch(/document_payload|\b(?:sku|catalog_skus)\s*\.\s*gtin\b/i);
    expectExactSkuSelects(probe.calls);
  });

  it("pages only active, sellable SKU envelopes in the portable query", async () => {
    const inactive = {
      ...catalogSkuEnvelopeFixture.postgresRows[0],
      sku_id: "99999999-9999-4999-8999-999999999991",
      sku_code: "INACTIVE-400",
      sku_status: "archived",
    };
    const unsellable = {
      ...catalogSkuEnvelopeFixture.postgresRows[0],
      sku_id: "99999999-9999-4999-8999-999999999992",
      sku_code: "UNSELLABLE-400",
      sellable_one_time: false,
      sellable_subscription: false,
    };
    const probe = executor({ rows: [...catalogSkuEnvelopeFixture.postgresRows, inactive, unsellable] });

    await expect(createPostgresCatalogSkuEnvelopeReadPort(probe.client).listActiveSkuEnvelopes({
      cursor: null,
      limit: 10,
    })).resolves.toEqual({ items: catalogSkuEnvelopeFixture.envelopes, nextCursor: null });
    expect(probe.calls).toHaveLength(2);
    expect(probe.calls[0]!.text).toContain("sku.status = 'active'");
    expect(probe.calls[0]!.text).toContain("sku.sellable_standalone OR sku.sellable_in_subscription");
  });

  it("keeps an active unsellable SKU discoverable and pages it by product without changing commerce reads", async () => {
    const unsellable = {
      ...catalogSkuEnvelopeFixture.postgresRows[0],
      sku_id: "99999999-9999-4999-8999-999999999992",
      sku_code: "UNSELLABLE-200",
      sellable_one_time: false,
      sellable_subscription: false,
      is_addon: true,
    };
    const probe = executor({
      rows: [...catalogSkuEnvelopeFixture.postgresRows, unsellable],
      identifiers: [
        ...catalogSkuEnvelopeFixture.postgresIdentifiers,
        { ...catalogSkuEnvelopeFixture.postgresIdentifiers[0], catalog_sku_id: unsellable.sku_id, normalized_value: "4006381333931" },
      ],
    });
    const port = createPostgresCatalogSkuEnvelopeReadPort(probe.client);

    const publicPage = await port.listPublicActiveSkuEnvelopes({ cursor: null, limit: 10 });
    expect(publicPage.items).toHaveLength(4);
    expect(publicPage.items.at(-1)?.sku).toMatchObject({ code: "UNSELLABLE-200", isAddon: true });
    expect(probe.calls[0]?.text).not.toContain("sku.sellable_standalone OR sku.sellable_in_subscription");

    const productPage = await port.listPublicActiveProductSkuEnvelopes(CATALOG_ENVELOPE_FIXTURE.productId, { cursor: null, limit: 10 });
    expect(productPage.items).toHaveLength(4);
    expect(probe.calls[2]?.values).toEqual([CATALOG_ENVELOPE_FIXTURE.productId, null, 11]);
  });

  it.each([
    ["global", (port: ReturnType<typeof createPostgresCatalogSkuEnvelopeReadPort>) => port.listPublicActiveSkuEnvelopes({ cursor: null, limit: 10 })],
    ["product-scoped", (port: ReturnType<typeof createPostgresCatalogSkuEnvelopeReadPort>) => port.listPublicActiveProductSkuEnvelopes(CATALOG_ENVELOPE_FIXTURE.productId, { cursor: null, limit: 10 })],
  ] as const)("refuses a missing primary SKU in the %s public page", async (_name, list) => {
    const rows = [{ ...catalogSkuEnvelopeFixture.postgresRows[0], primary_sku_id: null }];
    await expect(list(createPostgresCatalogSkuEnvelopeReadPort(executor({ rows }).client)))
      .rejects.toMatchObject({ name: CatalogSkuAuthorityError.name, code: "catalog_sku_authority_primary_sku_invalid" });
  });

  it("deeply projects the same detail envelope", async () => {
    const probe = executor();
    await expect(createPostgresCatalogSkuEnvelopeReadPort(probe.client).getSkuEnvelopeById(DETAIL_SKU_ID))
      .resolves.toEqual(catalogSkuEnvelopeFixture.envelopes[1]);
    expect(probe.calls).toHaveLength(2);
  });

  it("resolves exact SKU-code and primary-product-slug selectors in two queries", async () => {
    const byCode = executor();
    await expect(createPostgresCatalogSkuEnvelopeReadPort(byCode.client).getSkuEnvelope({
      kind: "sku_code",
      skuCode: "CATALOG-FOUNDATION-400",
    })).resolves.toEqual(catalogSkuEnvelopeFixture.envelopes[1]);
    expect(byCode.calls).toHaveLength(2);

    const bySlug = executor();
    await expect(createPostgresCatalogSkuEnvelopeReadPort(bySlug.client).getSkuEnvelope({
      kind: "primary_product_slug",
      productSlug: CATALOG_ENVELOPE_FIXTURE.product.slug,
    })).resolves.toEqual(catalogSkuEnvelopeFixture.envelopes[1]);
    expect(bySlug.calls).toHaveLength(2);
  });

  it.each([
    ["SKU absent", { rows: [] }, { kind: "sku_code", skuCode: "ABSENT-SKU" }, "catalog_sku_authority_sku_absent"],
    ["product absent", { rows: [] }, { kind: "primary_product_slug", productSlug: "absent-product" }, "catalog_sku_authority_product_absent"],
    ["primary SKU absent", { rows: [{ ...catalogSkuEnvelopeFixture.postgresRows[1], sku_id: null, sku_product_id: null, sku_code: null, net_content_unscaled: null, sku_status: null, sellable_one_time: null, sellable_subscription: null }] }, { kind: "primary_product_slug", productSlug: CATALOG_ENVELOPE_FIXTURE.product.slug }, "catalog_sku_authority_primary_sku_invalid"],
    ["primary SKU belongs to another product", { rows: [{ ...catalogSkuEnvelopeFixture.postgresRows[1], sku_product_id: "11111111-1111-4111-8111-000000000111" }] }, { kind: "primary_product_slug", productSlug: CATALOG_ENVELOPE_FIXTURE.product.slug }, "catalog_sku_authority_primary_sku_invalid"],
    ["SKU selector ambiguous", { rows: [...catalogSkuEnvelopeFixture.postgresRows, { ...catalogSkuEnvelopeFixture.postgresRows[1], sku_id: "22222222-2222-4444-8444-000000000444" }] }, { kind: "sku_code", skuCode: "CATALOG-FOUNDATION-400" }, "catalog_sku_authority_selector_ambiguous"],
    ["product selector ambiguous", { rows: [catalogSkuEnvelopeFixture.postgresRows[1], { ...catalogSkuEnvelopeFixture.postgresRows[1], product_id: "11111111-1111-4111-8111-000000000111", sku_product_id: "11111111-1111-4111-8111-000000000111" }] }, { kind: "primary_product_slug", productSlug: CATALOG_ENVELOPE_FIXTURE.product.slug }, "catalog_sku_authority_selector_ambiguous"],
  ] as const)("refuses %s with the shared selector authority code", async (_label, options, selector, code) => {
    await expect(createPostgresCatalogSkuEnvelopeReadPort(executor(options).client).getSkuEnvelope(selector))
      .rejects.toMatchObject({ name: CatalogSkuAuthorityError.name, code });
  });

  it.each([
    ["SKU absent", { rows: [] }, "catalog_sku_authority_sku_absent"],
    ["current document absent", { rows: [{ ...catalogSkuEnvelopeFixture.postgresRows[1], current_document_revision_id: null, document_revision_id: null, document_product_id: null, document_revision_no: null, document_schema_id: null, document_ref: null, document_source_ref: null, document_digest: null }] }, "catalog_sku_authority_current_document_absent"],
    ["current document invalid", { rows: [{ ...catalogSkuEnvelopeFixture.postgresRows[1], document_product_id: "99999999-9999-4999-8999-999999999999" }] }, "catalog_sku_authority_current_document_invalid"],
  ] as const)("refuses %s with the shared named authority code", async (_label, options, code) => {
    await expect(createPostgresCatalogSkuEnvelopeReadPort(executor(options).client).getSkuEnvelopeById(DETAIL_SKU_ID))
      .rejects.toMatchObject({ name: CatalogSkuAuthorityError.name, code });
  });

  it.each([
    ["absent", [], "catalog_sku_identifier_authority_absent"],
    ["ambiguous", [catalogSkuEnvelopeFixture.postgresIdentifiers[1], { ...catalogSkuEnvelopeFixture.postgresIdentifiers[1], issuer: "other-gs1" }], "catalog_sku_identifier_authority_ambiguous"],
    ["invalid", [{ ...catalogSkuEnvelopeFixture.postgresIdentifiers[1], normalized_value: "5901234123450" }], "catalog_sku_identifier_authority_invalid"],
  ] as const)("has %s primary-GTIN authority parity", async (_label, identifiers, code) => {
    await expect(createPostgresCatalogSkuEnvelopeReadPort(executor({ identifiers }).client).getSkuEnvelopeById(DETAIL_SKU_ID))
      .rejects.toMatchObject({ name: CatalogSkuAuthorityError.name, code });
  });

  it("does not use the dormant portable GTIN column and rejects unsafe limits before querying", async () => {
    const probe = executor();
    await expect(createPostgresCatalogSkuEnvelopeReadPort(probe.client).listSkuEnvelopes({ cursor: null, limit: 0 }))
      .rejects.toThrow("catalog_sku_envelope_invalid_limit");
    expect(probe.calls).toHaveLength(0);
    expect(readFileSync(PORTABLE_MIGRATION, "utf8")).not.toMatch(/catalog_skus\s*\.\s*gtin\b/i);
  });

  it("paginates 500 products, 5,000 SKUs and 10,000 identifiers without query growth", async () => {
    const scale = createCatalogSkuEnvelopeScaleFixture();
    expect(scale.products).toHaveLength(500);
    expect(scale.postgresRows).toHaveLength(5_000);
    expect(scale.postgresIdentifiers).toHaveLength(10_000);
    expect(new Set(scale.postgresRows.map((row) => row.product_id)).size).toBe(500);
    expect(new Set(scale.postgresIdentifiers.map((identifier) => identifier.normalized_value)).size).toBe(10_000);

    const listing = executor({ rows: [...scale.postgresRows].reverse(), identifiers: [...scale.postgresIdentifiers].reverse() });
    const port = createPostgresCatalogSkuEnvelopeReadPort(listing.client);
    let cursor: string | null = null;
    let seen = 0;
    const seenIds: string[] = [];
    const seenCodes: string[] = [];
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const before = listing.calls.length;
      const page = await port.listActiveSkuEnvelopes({ cursor, limit: 500 });
      expect(listing.calls.length - before).toBe(2);
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
    expect(listing.calls.map((call) => call.text).join("\n"))
      .not.toMatch(/document_payload|\b(?:sku|catalog_skus)\s*\.\s*gtin\b/i);
    expectExactSkuSelects(listing.calls);

    for (const [selector, expected] of [
      [{ kind: "sku_code", skuCode: String(scale.postgresRows[0]!.sku_code) }, scale.envelopes[0]],
      [{ kind: "sku_code", skuCode: String(scale.postgresRows.at(-1)!.sku_code) }, scale.envelopes.at(-1)],
      [{ kind: "primary_product_slug", productSlug: scale.products[0]!.slug }, scale.envelopes[0]],
      [{ kind: "primary_product_slug", productSlug: scale.products.at(-1)!.slug }, scale.envelopes[4_990]],
    ] as const) {
      const detail = executor({ rows: [...scale.postgresRows].reverse(), identifiers: [...scale.postgresIdentifiers].reverse() });
      await expect(createPostgresCatalogSkuEnvelopeReadPort(detail.client).getSkuEnvelope(selector)).resolves.toEqual(expected);
      expect(detail.calls).toHaveLength(2);
      expectExactSkuSelects(detail.calls);
    }

    await expect(createPostgresCatalogSkuEnvelopeReadPort(executor({ rows: scale.postgresRows, identifiers: scale.postgresIdentifiers }).client)
      .getSkuEnvelope({ kind: "sku_code", skuCode: "ABSENT-SKU" }))
      .rejects.toMatchObject({ code: "catalog_sku_authority_sku_absent" });
    await expect(createPostgresCatalogSkuEnvelopeReadPort(executor({ rows: scale.postgresRows, identifiers: scale.postgresIdentifiers }).client)
      .getSkuEnvelope({ kind: "primary_product_slug", productSlug: "absent-product" }))
      .rejects.toMatchObject({ code: "catalog_sku_authority_product_absent" });
  });
});

const EXPECTED_SKU_SELECT_COLUMNS = [
  "id",
  "product_id",
  "sku",
  "net_weight_g",
  "status",
  "sellable_standalone",
  "sellable_in_subscription",
  "is_addon",
  "asset_ref",
];

function expectExactSkuSelects(calls: ReadonlyArray<{ text: string }>): void {
  for (const { text } of calls) {
    if (!text.includes(" AS sku")) continue;
    const select = text.slice(text.indexOf("SELECT"), text.indexOf("FROM"));
    const columns = [...select.matchAll(/\bsku\.([a-z_]+)/gu)].map((match) => match[1]);
    expect(columns).toEqual(EXPECTED_SKU_SELECT_COLUMNS);
    expect(select).not.toMatch(/\bsku\s*\.\s*gtin\b/iu);
  }
}
