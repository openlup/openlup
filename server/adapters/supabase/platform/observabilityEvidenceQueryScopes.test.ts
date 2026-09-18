import { describe, expect, it, vi } from "vitest";
import {
  excludeDormantOutboxEvents,
  selectRecentOmniPackQuarantine,
} from "./observabilityEvidenceQueryScopes.js";

describe("observability evidence query scopes", () => {
  it("excludes exact and prefix dormant event types from outbox queries", () => {
    const query = { not: vi.fn() };
    query.not.mockReturnValue(query);

    expect(excludeDormantOutboxEvents(query as never)).toBe(query);
    expect(query.not.mock.calls).toEqual([
      [
        "event_type",
        "in",
        "(commerce.subscription_payment.requested,commerce.payment_attempt.requested,commerce.subscription_payment.retry_requested,commerce.subscription.resume_requested)",
      ],
      ["event_type", "like", "commerce.return.%"],
    ]);
  });

  it("selects only recent ignored OmniPack inbound events", async () => {
    const rows = [{ provider: "omnipack", processing_status: "ignored", received_at: "2026-07-14T10:00:00.000Z" }];
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      gte: vi.fn(),
      limit: vi.fn(),
      then(resolve: (value: { data: typeof rows; error: null }) => void) {
        resolve({ data: rows, error: null });
      },
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.gte.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    const from = vi.fn(() => query);

    await expect(selectRecentOmniPackQuarantine(
      { from } as never,
      "2026-07-13T10:00:00.000Z",
    )).resolves.toEqual(rows);
    expect(from).toHaveBeenCalledWith("inbound_provider_events");
    expect(query.select).toHaveBeenCalledWith("provider,processing_status,received_at,error");
    expect(query.eq.mock.calls).toEqual([
      ["provider", "omnipack"],
      ["processing_status", "ignored"],
    ]);
    expect(query.gte).toHaveBeenCalledWith("received_at", "2026-07-13T10:00:00.000Z");
    expect(query.limit).toHaveBeenCalledWith(2000);
  });
});
