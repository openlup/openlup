import { describe, expect, it, vi } from "vitest";
import {
  runResendDeliveryReconciliation,
  type ResendDeliveryReconciliationPort,
} from "./resendDeliveryReconciliationWorker.js";
function port(rows: Array<{ id: string; resendId: string; status: string | null }>) {
  const applied: Array<Record<string, unknown>> = [];
  const notFound: Array<Record<string, unknown>> = [];
  const pollAttempts: Array<Record<string, unknown>> = [];
  const impl: ResendDeliveryReconciliationPort = {
    findFrozenSends: vi.fn().mockResolvedValue(rows),
    applyPolledEvent: vi.fn().mockImplementation(async (input) => {
      applied.push(input as unknown as Record<string, unknown>);
    }),
    recordPollAttempt: vi.fn().mockImplementation(async (input) => {
      pollAttempts.push(input as unknown as Record<string, unknown>);
    }),
    recordSendNotFound: vi.fn().mockImplementation(async (input) => {
      notFound.push(input as unknown as Record<string, unknown>);
      return { abandoned: false };
    }),
  };
  return { impl, applied, notFound, pollAttempts };
}

describe("runResendDeliveryReconciliation", () => {
  it("applies provider state for frozen sends and counts terminal polls", async () => {
    const { impl, applied, pollAttempts } = port([
      { id: "send-1", resendId: "re-1", status: "sent" },
      { id: "send-2", resendId: "re-2", status: "sent" },
    ]);
    const readEmail = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        lastEvent: "delivered",
        recipientEmail: "first@example.com",
        httpStatus: 200,
        providerError: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        lastEvent: "complained",
        recipientEmail: "second@example.com",
        httpStatus: 200,
        providerError: null,
      });

    const result = await runResendDeliveryReconciliation({
      port: impl,
      readEmail,
      now: "2026-07-07T12:00:00.000Z",
      graceMinutes: 45,
      limit: 50,
    });

    expect(result).toMatchObject({ checked: 2, reconciled: 2, terminalPolled: 1, failures: 0, stillPending: 0 });
    expect(applied[0]).toMatchObject({
      sendId: "send-1",
      webhookType: "email.delivered",
      recipientEmail: "first@example.com",
    });
    expect(applied[1]).toMatchObject({
      sendId: "send-2",
      webhookType: "email.complained",
      recipientEmail: "second@example.com",
    });
    expect(pollAttempts).toEqual([
      { sendId: "send-1", attemptedAt: "2026-07-07T12:00:00.000Z" },
      { sendId: "send-2", attemptedAt: "2026-07-07T12:00:00.000Z" },
    ]);
  });

  it("counts provider-still-sent as pending and read errors as failures without applying", async () => {
    const { impl, applied, pollAttempts } = port([
      { id: "send-1", resendId: "re-1", status: "sent" },
      { id: "send-2", resendId: "re-2", status: "sent" },
    ]);
    const readEmail = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        lastEvent: "sent",
        recipientEmail: "first@example.com",
        httpStatus: 200,
        providerError: null,
      })
      .mockResolvedValueOnce({
        ok: false,
        lastEvent: null,
        recipientEmail: null,
        httpStatus: 500,
        providerError: "Resend HTTP 500",
      });

    const result = await runResendDeliveryReconciliation({
      port: impl,
      readEmail,
      now: "2026-07-07T12:00:00.000Z",
      graceMinutes: 45,
      limit: 50,
    });

    expect(result).toMatchObject({ checked: 2, reconciled: 0, stillPending: 1, failures: 1 });
    expect(result.failureBreakdown).toMatchObject({ providerError: 1, notFound: 0, authFailed: 0, network: 0 });
    expect(applied).toHaveLength(0);
    expect(pollAttempts).toEqual([
      { sendId: "send-1", attemptedAt: "2026-07-07T12:00:00.000Z" },
      { sendId: "send-2", attemptedAt: "2026-07-07T12:00:00.000Z" },
    ]);
  });

  it("buckets read failures by class and only abandons on 404", async () => {
    const { impl, notFound, pollAttempts } = port([
      { id: "send-1", resendId: "re-1", status: "sent" },
      { id: "send-2", resendId: "re-2", status: "sent" },
      { id: "send-3", resendId: "re-3", status: "sent" },
      { id: "send-4", resendId: "re-4", status: "sent" },
    ]);
    const readEmail = vi.fn()
      .mockResolvedValueOnce({ ok: false, lastEvent: null, recipientEmail: null, httpStatus: 404, providerError: "not_found" })
      .mockResolvedValueOnce({ ok: false, lastEvent: null, recipientEmail: null, httpStatus: 401, providerError: "unauthorized" })
      .mockResolvedValueOnce({ ok: false, lastEvent: null, recipientEmail: null, httpStatus: 0, providerError: "fetch_failed" })
      .mockResolvedValueOnce({ ok: false, lastEvent: null, recipientEmail: null, httpStatus: 429, providerError: "rate_limited" });

    const result = await runResendDeliveryReconciliation({
      port: impl,
      readEmail,
      now: "2026-07-07T12:00:00.000Z",
      graceMinutes: 45,
      limit: 50,
    });

    expect(result).toMatchObject({ checked: 4, failures: 4, reconciled: 0 });
    expect(result.failureBreakdown).toEqual({ notFound: 1, authFailed: 1, network: 1, providerError: 0, other: 1 });
    // Only the 404 send is offered for abandonment; auth/network/other are not.
    expect(notFound).toEqual([{ sendId: "send-1", threshold: 3 }]);
    expect(pollAttempts).toEqual([
      { sendId: "send-2", attemptedAt: "2026-07-07T12:00:00.000Z" },
      { sendId: "send-3", attemptedAt: "2026-07-07T12:00:00.000Z" },
      { sendId: "send-4", attemptedAt: "2026-07-07T12:00:00.000Z" },
    ]);
  });

  it("counts a send as abandoned when the port reports the threshold was crossed", async () => {
    const { impl } = port([{ id: "send-1", resendId: "re-1", status: "sent" }]);
    (impl.recordSendNotFound as ReturnType<typeof vi.fn>).mockResolvedValue({ abandoned: true });
    const readEmail = vi.fn().mockResolvedValue({
      ok: false,
      lastEvent: null,
      recipientEmail: null,
      httpStatus: 404,
      providerError: "not_found",
    });

    const result = await runResendDeliveryReconciliation({
      port: impl,
      readEmail,
      now: "2026-07-07T12:00:00.000Z",
      graceMinutes: 45,
      limit: 50,
    });

    expect(result).toMatchObject({ checked: 1, failures: 1, abandoned: 1 });
    expect(result.failureBreakdown.notFound).toBe(1);
  });

  it("counts apply errors as failures and keeps processing the batch", async () => {
    const { impl } = port([
      { id: "send-1", resendId: "re-1", status: "sent" },
      { id: "send-2", resendId: "re-2", status: "sent" },
    ]);
    (impl.applyPolledEvent as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const readEmail = vi.fn().mockResolvedValue({
      ok: true,
      lastEvent: "delivered",
      recipientEmail: "client@example.com",
      httpStatus: 200,
      providerError: null,
    });

    const result = await runResendDeliveryReconciliation({
      port: impl,
      readEmail,
      now: "2026-07-07T12:00:00.000Z",
      graceMinutes: 45,
      limit: 50,
    });

    expect(result).toMatchObject({ checked: 2, reconciled: 1, failures: 1 });
  });

  it("counts rotation failure but still applies terminal provider truth", async () => {
    const { impl, applied } = port([{ id: "send-1", resendId: "re-1", status: "sent" }]);
    (impl.recordPollAttempt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rotation down"));
    const readEmail = vi.fn().mockResolvedValue({
      ok: true,
      lastEvent: "delivered",
      recipientEmail: "client@example.com",
      httpStatus: 200,
      providerError: null,
    });

    const result = await runResendDeliveryReconciliation({
      port: impl,
      readEmail,
      now: "2026-07-07T12:00:00.000Z",
      graceMinutes: 45,
      limit: 50,
    });

    expect(result).toMatchObject({ checked: 1, reconciled: 1, failures: 1 });
    expect(applied).toHaveLength(1);
  });
});
