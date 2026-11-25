import { describe, expect, it } from "vitest";
import { connectedNativeStoreTables } from "./connectedStoreCapture.js";
import {
  connectedStoreAllowedInsertTriggers,
  connectedStoreOwnedTables,
  connectedStoreRestoreOrder,
  connectedStoreSettingsTables,
  mergeAllowedInsertTriggers,
} from "./connectedStoreDomains/index.js";

describe("connectedStoreDomains composition", () => {
  it("contains no duplicate table entries across owned, restore order, settings, or full profile", () => {
    expect(new Set(connectedStoreOwnedTables).size).toBe(connectedStoreOwnedTables.length);
    expect(new Set(connectedNativeStoreTables).size).toBe(connectedNativeStoreTables.length);
    expect(new Set(connectedStoreRestoreOrder).size).toBe(connectedStoreRestoreOrder.length);
    expect(new Set(connectedStoreSettingsTables).size).toBe(connectedStoreSettingsTables.length);
  });

  it("partitions connectedNativeStoreTables cleanly into restore order and settings", () => {
    const all = new Set<string>(connectedNativeStoreTables);
    const owned = new Set<string>(connectedStoreOwnedTables);
    const order = new Set<string>(connectedStoreRestoreOrder);
    const settings = new Set<string>(connectedStoreSettingsTables);

    for (const table of settings) {
      expect(owned.has(table), `settings table ${table} must be owned`).toBe(true);
      expect(order.has(table), `settings table ${table} must not also be in restore order`).toBe(false);
    }

    const union = new Set<string>([...order, ...settings]);
    expect([...all].filter(table => !union.has(table))).toEqual([]);
    expect([...union].filter(table => !all.has(table))).toEqual([]);
    expect(connectedStoreRestoreOrder.length + connectedStoreSettingsTables.length).toBe(connectedNativeStoreTables.length);
  });

  it("preserves capture adjacency invariants relied on by money/tax and restore tests", () => {
    const limitsIndex = connectedStoreOwnedTables.indexOf("commerce_money_limits_v2");
    expect(limitsIndex).toBeGreaterThanOrEqual(0);
    expect(connectedStoreOwnedTables.slice(limitsIndex, limitsIndex + 8)).toEqual([
      "commerce_money_limits_v2",
      "tax_calculations",
      "commerce_order_tax_snapshots",
      "commerce_order_line_sources",
      "commerce_order_delivery_buckets",
      "commerce_order_line_allocations",
      "commerce_order_tax_positions",
      "commerce_order_fee_lines",
    ]);

    const checkoutLedgerIndex = connectedNativeStoreTables.indexOf("commerce_checkout_attempt_ledger");
    const promotionDefsIndex = connectedNativeStoreTables.indexOf("commerce_promotion_definitions");
    const editQuotesIndex = connectedNativeStoreTables.indexOf("subscription_edit_quotes");
    expect(checkoutLedgerIndex).toBeLessThan(promotionDefsIndex);
    expect(promotionDefsIndex).toBeLessThan(editQuotesIndex);
  });

  it("preserves core topological parent-before-child restore ordering", () => {
    const pos = (table: typeof connectedStoreRestoreOrder[number]) => connectedStoreRestoreOrder.indexOf(table);
    expect(pos("tax_coverage_revisions")).toBe(0);
    expect(pos("platform_human_principals")).toBeLessThan(pos("clients"));
    expect(pos("clients")).toBeLessThan(pos("subscriptions"));
    expect(pos("catalog_products")).toBeLessThan(pos("catalog_product_document_revisions"));
    expect(pos("catalog_product_document_revisions")).toBeLessThan(pos("catalog_skus"));
    expect(pos("catalog_skus")).toBeLessThan(pos("catalog_publications"));
    expect(pos("subscriptions")).toBeLessThan(pos("commerce_orders"));
    expect(pos("commerce_orders")).toBeLessThan(pos("commerce_order_line_sources"));
    expect(pos("commerce_order_line_sources")).toBeLessThan(pos("commerce_order_items"));
    expect(pos("commerce_orders")).toBeLessThan(pos("tax_calculations"));
    expect(pos("fulfillment_shipments")).toBeLessThan(pos("shipment_external_refs"));
    expect(pos("fulfillment_shipments")).toBeLessThan(pos("commerce_order_holds"));
    expect(pos("commerce_order_holds")).toBeLessThan(pos("subscription_delivery_alignment_cases"));
    expect(pos("invoicing_cutover")).toBeLessThan(pos("invoicing_duties"));
  });

  it("builds a frozen prototype-null allowed insert-trigger map covering only profile tables", () => {
    const profile = new Set<string>(connectedNativeStoreTables);
    expect(Object.getPrototypeOf(connectedStoreAllowedInsertTriggers)).toBeNull();
    expect(Object.isFrozen(connectedStoreAllowedInsertTriggers)).toBe(true);

    const entries = Object.entries(connectedStoreAllowedInsertTriggers);
    expect(entries.length).toBeGreaterThan(0);
    for (const [table, triggers] of entries) {
      expect(profile.has(table), `trigger table ${table} must be in connectedNativeStoreTables`).toBe(true);
      expect(triggers.length, `trigger list for ${table} must be non-empty`).toBeGreaterThan(0);
      expect(new Set(triggers).size, `duplicate trigger for ${table}`).toBe(triggers.length);
      for (const trigger of triggers) {
        expect(trigger).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
      }
    }
  });

  it("refuses duplicate table keys when merging domain insert triggers", () => {
    expect(() =>
      mergeAllowedInsertTriggers([
        { catalog_products: ["trg_a"] },
        { catalog_products: ["trg_b"] },
      ]),
    ).toThrow(/Duplicate connected-store insert trigger domain entry for table: catalog_products/);
  });
});
