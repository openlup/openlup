import { describe, expect, it } from "vitest";
import {
  createSupabaseLowStockEvidencePort,
  createSupabaseProductReconciliationEvidencePort,
} from "./fulfillmentEvidencePorts.js";
import { createSupabaseOmnipackOperationalProofPort } from "./fulfillmentOperationalProof.js";

describe("admin fulfillment evidence Supabase ports", () => {
  it("exposes low-stock and product reconciliation evidence readers", () => {
    expect(createSupabaseLowStockEvidencePort({} as never).getLowStockEvidence).toBeTypeOf("function");
    expect(
      createSupabaseProductReconciliationEvidencePort({} as never).getProductReconciliationEvidence,
    ).toBeTypeOf("function");
    expect(createSupabaseOmnipackOperationalProofPort({} as never).getOmnipackOperationalProof).toBeTypeOf("function");
  });

  it("aggregates OmniPack operational proof from durable evidence only", async () => {
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
        { provider_kind: "omnipack", sku: "OPENLUP-DOG-LAMB-CAN-400G", stale_after: "2026-06-29T10:00:00+00:00" },
      ],
      omnipack_stock_snapshots: [
        { provider_kind: "omnipack", sku: "OPENLUP-DOG-LAMB-CAN-400G", mismatch_kind: "provider_lower", snapshot_at: "2026-06-30T08:05:00+00:00" },
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
      "provider_stock_consumption_gap",
    ]));
    expect(proof.blockers).not.toContain("provider_local_mismatch");
    expect(proof.webhooks.routes).toContainEqual(expect.objectContaining({
      route: "order.shipped",
      failedCount: 1,
    }));
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
