import { describe, expect, it } from "vitest";
import { CommerceOmsPersistenceError } from "../../../../../src/domains/commerce/omsPorts.js";
import {
  readOmnipackDispatchRefs,
  readOmnipackStatusEvidence,
  readProviderAttempts,
} from "./providerEvidence.js";
import { FakeOmsClient } from "./readQueriesTestKit.js";

describe("supabase commerce OMS provider evidence helpers", () => {
  it("reads provider attempts for fulfillment orders", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {
        commerce_fulfillment_provider_attempts: [
          {
            fulfillment_order_id: "fulfillment-1",
            provider_kind: "omnipack",
            status: "accepted",
            provider_tracking_id: null,
            created_at: "2026-06-05T10:00:00+00:00",
          },
        ],
      },
    });

    const rows = await readProviderAttempts(client, ["fulfillment-1"]);

    expect(rows).toHaveLength(1);
    expect(client.tablesRead).toEqual(["commerce_fulfillment_provider_attempts"]);
    expect(client.selects).toEqual([
      {
        table: "commerce_fulfillment_provider_attempts",
        columns: "fulfillment_order_id, provider_kind, status, provider_tracking_id, error, created_at",
      },
    ]);
    expect(client.filters).toContainEqual({
      table: "commerce_fulfillment_provider_attempts",
      kind: "in",
      column: "fulfillment_order_id",
      value: ["fulfillment-1"],
    });
  });

  it("reads OmniPack dispatch refs and status evidence", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {
        omnipack_dispatch_refs: [
          {
            id: "82222222-2222-4222-8222-222222222221",
            fulfillment_order_id: "fulfillment-1",
            provider_order_id: "provider-order-1",
            dispatch_mode: "stage",
            status: "created",
            created_at: "2026-06-05T10:00:00+00:00",
          },
        ],
        omnipack_status_evidence: [
          {
            id: "92222222-2222-4222-8222-222222222221",
            fulfillment_order_id: "fulfillment-1",
            provider_status: "shipped",
            local_status: "in_transit",
            evidence_kind: "reconciliation",
            occurred_at: "2026-06-05T11:00:00+00:00",
          },
        ],
      },
    });

    await expect(readOmnipackDispatchRefs(client, ["fulfillment-1"])).resolves.toEqual([
      {
        id: "82222222-2222-4222-8222-222222222221",
        fulfillment_order_id: "fulfillment-1",
        provider_order_id: "provider-order-1",
        dispatch_mode: "stage",
        status: "created",
        created_at: "2026-06-05T10:00:00+00:00",
      },
    ]);
    await expect(readOmnipackStatusEvidence(client, ["fulfillment-1"])).resolves.toEqual([
      {
        id: "92222222-2222-4222-8222-222222222221",
        fulfillment_order_id: "fulfillment-1",
        provider_status: "shipped",
        local_status: "in_transit",
        customer_status: "in_transit",
        evidence_kind: "reconciliation",
        occurred_at: "2026-06-05T11:00:00+00:00",
      },
    ]);
    expect(client.tablesRead).toEqual(["omnipack_dispatch_refs", "omnipack_status_evidence"]);
    expect(client.selects).toContainEqual({
      table: "omnipack_dispatch_refs",
      columns: "id, fulfillment_order_id, provider_order_id, dispatch_mode, status, error, created_at, updated_at",
    });
    expect(client.selects).toContainEqual({
      table: "omnipack_status_evidence",
      columns: "id, fulfillment_order_id, provider_status, provider_sub_status, local_status, evidence_kind, occurred_at, created_at",
    });
  });

  it("does not query provider evidence tables when there are no fulfillment orders", async () => {
    const client = new FakeOmsClient({ rpcData: {}, rows: {} });

    await expect(readProviderAttempts(client, [])).resolves.toEqual([]);
    await expect(readOmnipackDispatchRefs(client, [])).resolves.toEqual([]);
    await expect(readOmnipackStatusEvidence(client, [])).resolves.toEqual([]);
    expect(client.tablesRead).toEqual([]);
  });

  it("treats missing optional provider evidence tables as absent evidence", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {},
      selectErrors: [
        {
          table: "omnipack_status_evidence",
          whenColumnsInclude: "provider_status",
          error: { code: "42P01", message: "relation omnipack_status_evidence does not exist" },
        },
      ],
    });

    await expect(readOmnipackStatusEvidence(client, ["fulfillment-1"])).resolves.toEqual([]);
  });

  it("raises an OMS persistence error when provider evidence read fails", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {},
      selectErrors: [
        {
          table: "commerce_fulfillment_provider_attempts",
          whenColumnsInclude: "provider_kind",
          error: { code: "XX000", message: "storage failure" },
        },
      ],
    });

    await expect(readProviderAttempts(client, ["fulfillment-1"])).rejects.toBeInstanceOf(
      CommerceOmsPersistenceError,
    );
  });
});
