import { describe, expect, it } from "vitest";
import { FakeOmsClient } from "./readQueriesTestKit.js";
import { readOrderPaidOutboxEvents } from "./outboxEvents.js";

describe("supabase commerce OMS outbox event reads", () => {
  it("reads order-paid outbox evidence without non-canonical updated_at", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      selectErrors: [{
        table: "outbox_events",
        whenColumnsInclude: "updated_at",
        error: { code: "PGRST204", message: "Could not find the 'updated_at' column of 'outbox_events'" },
      }],
      rows: {
        outbox_events: [{
          id: "72222222-2222-4222-8222-222222222231",
          event_type: "commerce.order.paid",
          status: "discarded",
          aggregate_id: "42222222-2222-4222-8222-222222222231",
          created_at: "2026-06-05T10:00:00+00:00",
          available_at: "2026-06-05T10:00:00+00:00",
          attempts: 8,
        }],
      },
    });

    const result = await readOrderPaidOutboxEvents(client, "42222222-2222-4222-8222-222222222231");

    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1);
    expect(client.selects).toContainEqual({
      table: "outbox_events",
      columns: "id,event_type,status,aggregate_id,created_at,available_at,attempts",
    });
  });

  it("falls back when the optional attempts column is absent", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      selectErrors: [{
        table: "outbox_events",
        whenColumnsInclude: "attempts",
        error: { code: "PGRST204", message: "Could not find the 'attempts' column of 'outbox_events'" },
      }],
      rows: {
        outbox_events: [{
          id: "72222222-2222-4222-8222-222222222232",
          event_type: "commerce.order.paid",
          status: "processed",
          aggregate_id: "42222222-2222-4222-8222-222222222232",
          created_at: "2026-06-05T10:00:00+00:00",
          available_at: "2026-06-05T10:00:00+00:00",
        }],
      },
    });

    const result = await readOrderPaidOutboxEvents(client, "42222222-2222-4222-8222-222222222232");

    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1);
    expect(client.selects).toContainEqual({
      table: "outbox_events",
      columns: "id,event_type,status,aggregate_id,created_at,available_at",
    });
  });
});
