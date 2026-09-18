import { describe, expect, it } from "vitest";
import { createSupabaseOmnipackOperationalProofPort } from "./fulfillmentOperationalProof.js";

describe("createSupabaseOmnipackOperationalProofPort", () => {
  it("fails closed when durable OmniPack proof evidence is absent", async () => {
    const proof = await createSupabaseOmnipackOperationalProofPort(client({}) as never).getOmnipackOperationalProof();

    expect(proof.ok).toBe(false);
    expect(proof.blockers).toEqual(expect.arrayContaining([
      "no_webhook_evidence",
      "no_reconciliation_evidence",
      "no_stock_sync_cursor",
      "no_provider_current_stock",
    ]));
  });

  it("aggregates OmniPack operational proof from durable local evidence", async () => {
    const proof = await createSupabaseOmnipackOperationalProofPort(client({
      inbound_provider_events: [
        {
          event_type: "order.picked",
          processing_status: "processed",
          received_at: "2026-06-30T09:00:00+00:00",
          processed_at: "2026-06-30T09:01:00+00:00",
          received_via: "omnipack.webhook.v0",
          provider: "omnipack",
        },
        {
          event_type: "order.shipped",
          processing_status: "failed",
          received_at: "2026-06-30T09:05:00+00:00",
          processed_at: null,
          received_via: "omnipack.webhook.v0",
          provider: "omnipack",
        },
        {
          event_type: "fulfilment.reconciliation",
          processing_status: "ignored",
          received_at: "2026-06-30T09:06:00+00:00",
          processed_at: "2026-06-30T09:07:00+00:00",
          received_via: "omnipack.reconciliation.v0",
          provider: "omnipack",
        },
      ],
      omnipack_status_evidence: [
        { evidence_kind: "reconciliation", local_status: "in_transit", created_at: "2026-06-30T09:10:00+00:00" },
      ],
      omnipack_stock_sync_cursors: [
        { provider_kind: "omnipack", status: "failed", last_stock_synced_at: "2026-06-30T08:00:00+00:00", updated_at: "2026-06-30T08:05:00+00:00" },
      ],
      fulfillment_provider_stock_current: [
        { provider_kind: "omnipack", sku: "OPENLUP-DOG-LAMB-CAN-400G", stale_after: "2000-01-01T00:00:00+00:00", inventory_class: "sellable" },
        { provider_kind: "omnipack", sku: "UNKNOWN-SKU", stale_after: "2999-01-01T00:00:00+00:00", inventory_class: null },
      ],
      omnipack_low_stock_evidence: [
        { status: "open", threshold_kind: "reservation_coverage" },
        { status: "resolved", threshold_kind: "reservation_coverage" },
        { status: "open", threshold_kind: "provider_mismatch" },
      ],
      commerce_fulfillment_orders: [
        { provider_kind: "omnipack", id: "ful-1", status: "handed_over", metadata: {} },
      ],
    }) as never).getOmnipackOperationalProof();

    expect(proof.ok).toBe(false);
    expect(proof.blockers).toEqual(expect.arrayContaining([
      "failed_inbound_events",
      "stock_sync_failed",
      "stale_provider_stock",
      "reservation_coverage_shortage",
      "provider_stock_consumption_gap",
    ]));
    expect(proof.blockers).not.toContain("provider_local_mismatch");
    expect(proof.stockSync).toMatchObject({
      reservationCoverageCount: 1,
      unknownStockSkuCount: 1,
    });
    expect(proof.stockSync).not.toHaveProperty("providerLocalMismatchSkuCount");
    expect(proof.webhooks.routes).toContainEqual(expect.objectContaining({
      route: "order.shipped",
      failedCount: 1,
    }));
    expect(proof.reconciliation.lastReconciledAt).toBe("2026-06-30T09:10:00+00:00");
    expect(proof.reconciliation.quarantineCount).toBe(1);
    expect(proof.fulfillment.sampleFulfillmentOrderIds).toEqual(["ful-1"]);
  });
});

function client(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      return query(tables[table] ?? []);
    },
  };
}

function query(rows: Array<Record<string, unknown>>) {
  const filters: Array<{ column: string; value: unknown }> = [];
  let limitCount: number | null = null;
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push({ column, value });
      return builder;
    },
    order: () => builder,
    limit: (count: number) => {
      limitCount = count;
      return builder;
    },
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => {
      let data = rows.filter((row) => filters.every((filter) => row[filter.column] === filter.value));
      if (limitCount !== null) data = data.slice(0, limitCount);
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return builder;
}
