import { describe, expect, it, vi } from "vitest";
import { createSupabaseBackInStockNotificationPort } from "./backInStockNotification.js";

describe("createSupabaseBackInStockNotificationPort", () => {
  it("marks a back-in-stock notification as notified with the stable RPC payload", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const port = createSupabaseBackInStockNotificationPort({ rpc });
    const signal = new AbortController().signal;

    await expect(port.markNotified({
      outboxEventId: "event-1",
      notificationId: "notification-1",
      consentDecisionId: "consent-1",
      signal,
    })).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith("mark_back_in_stock_notification_notified", {
      p_outbox_event_id: "event-1",
      p_notification_id: "notification-1",
      p_consent_decision_id: "consent-1",
    });
  });

  it("closes a suppressed notification with the stable RPC payload", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const port = createSupabaseBackInStockNotificationPort({ rpc });
    const signal = new AbortController().signal;

    await expect(port.closeSuppressed({
      outboxEventId: "event-1",
      notificationId: "notification-1",
      consentDecisionId: "consent-1",
      reason: "email_unsubscribed",
      signal,
    })).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith("close_back_in_stock_notification", {
      p_outbox_event_id: "event-1",
      p_notification_id: "notification-1",
      p_consent_decision_id: "consent-1",
      p_closed_reason: "consent_blocked",
      p_detail: "email_unsubscribed",
    });
  });

  it("uses abortSignal when the Supabase request builder exposes it", async () => {
    const abortSignal = vi.fn(async () => ({ data: true, error: null }));
    const rpc = vi.fn(() => ({ abortSignal }) as never);
    const port = createSupabaseBackInStockNotificationPort({ rpc });
    const signal = new AbortController().signal;

    await port.markNotified({
      outboxEventId: "event-1",
      notificationId: "notification-1",
      consentDecisionId: "consent-1",
      signal,
    });

    expect(abortSignal).toHaveBeenCalledWith(signal);
  });
});
