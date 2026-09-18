import { describe, expect, it } from "vitest";
import { boundedCustomerJourneyAudit, portableTimelineAuditEvent } from "./customerJourneyAudit.js";

describe("customer journey portable audit", () => {
  it("orders offset timestamps by instant and breaks equal instants by event id", () => {
    const events = boundedCustomerJourneyAudit([
      audit("b", "2026-01-01T00:00:00+00:00"),
      audit("a", "2025-12-31T19:00:00-05:00"),
      audit("late", "2026-01-01T00:00:01+00:00"),
    ]).events;
    expect(events.map((event) => event.eventId)).toEqual(["a", "b", "late"]);
  });

  it("keeps an authoritative fulfillment observation id across corrected status and time", () => {
    const first = portableTimelineAuditEvent(timeline("2026-01-01T00:00:00.000Z", "in_transit"), "subject")[0];
    const corrected = portableTimelineAuditEvent(timeline("2026-01-01T01:00:00.000Z", "delivered"), "subject")[0];
    expect(first?.eventId).toBe(corrected?.eventId);
    expect(corrected).toMatchObject({ outcome: "delivered", entity: { kind: "order", id: "order" } });
  });
});

function audit(eventId: string, occurredAt: string) { return { eventId, occurredAt, action: "test", outcome: "observed", entity: { kind: "subject" as const, id: "subject" } }; }
function timeline(occurredAt: string, outcome: string) { return { occurredAt, kind: "fulfillment.status", label: "ignored", source: "fulfillment", entityRef: { orderId: "order", fulfillmentOrderId: "fulfillment", observationId: "evidence", outcome } }; }
