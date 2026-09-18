import { describe, expect, it } from "vitest";
import { summarizeOutboxQueue } from "./outboxObservabilityEvidence.js";

describe("outbox observability evidence", () => {
  it("summarizes exact queue counts with the oldest due row", () => {
    expect(summarizeOutboxQueue([
      {
        id: "later",
        status: "pending",
        event_type: "commerce.order_draft.created",
        available_at: "2026-06-18T10:05:00.000Z",
        created_at: "2026-06-18T10:00:00.000Z",
      },
      {
        id: "earlier",
        status: "failed",
        event_type: "commerce.order.paid",
        available_at: "2026-06-18T09:55:00.000Z",
        created_at: "2026-06-18T09:50:00.000Z",
      },
      {
        id: "dormant-oldest",
        status: "pending",
        event_type: "commerce.payment_attempt.requested",
        available_at: "2026-06-01T00:00:00.000Z",
        created_at: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "dormant-prefix",
        status: "pending",
        event_type: "commerce.return.requested",
        available_at: "2026-05-01T00:00:00.000Z",
        created_at: "2026-05-01T00:00:00.000Z",
      },
    ], 7, 2)).toEqual({
      queueName: "outbox_events",
      jobName: "outbox-dispatch",
      queuedCount: 7,
      oldestQueuedAt: "2026-06-18T09:55:00.000Z",
      failedCount: 2,
      skippedCount: 0,
    });
  });
});
