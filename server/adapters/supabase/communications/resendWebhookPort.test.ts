import { describe, expect, it, vi } from "vitest";

import { createSupabaseResendWebhookPort } from "./resendWebhookPort.js";

describe("Supabase Resend webhook port", () => {
  it("uses the canonical lookup and delivery convergence RPC", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "send-1" }, error: null });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const port = createSupabaseResendWebhookPort({
      from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) })),
      rpc,
    });

    await expect(port.findEmailSendByResendId("re_1")).resolves.toEqual({ id: "send-1" });
    await port.applyProviderEvent({
      emailSendId: "send-1",
      resendId: "re_1",
      resendEventType: "email.delivered",
      eventAt: "2026-08-23T10:00:00.000Z",
      metadata: { source: "resend-webhook" },
    });

    expect(rpc).toHaveBeenCalledWith("communication_update_email_delivery_from_provider", {
      p_email_send_id: "send-1",
      p_provider_message_id: "re_1",
      p_provider_event_type: "email.delivered",
      p_event_at: "2026-08-23T10:00:00.000Z",
      p_metadata: { source: "resend-webhook" },
    });
  });

  it("does not let attempt telemetry failure change acknowledgement behavior", async () => {
    const insert = vi.fn().mockRejectedValue(new Error("telemetry unavailable"));
    const port = createSupabaseResendWebhookPort({ from: vi.fn(() => ({ insert })) });
    await expect(port.recordAttempt({
      resendWebhookId: "evt_1",
      resendEventType: "email.delivered",
      resendEmailId: "re_1",
      outcome: "processed",
      httpStatus: 200,
      error: "x".repeat(501),
    })).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ error: "x".repeat(500) }));
  });
});
