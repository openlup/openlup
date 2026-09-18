import { describe, expect, it, vi } from "vitest";

import { createSupabaseCycleChargeFailurePropagationPort as createPort } from "./cycleChargeFailurePropagation.js";

// The renewal rail. An off-session cycle charge that the provider refuses is
// terminalised here, and this is the one seam of the four whose port method only
// ever applies `failed` — there is no success path through it to stay quiet for.
describe("cycle charge failure propagation terminal decline signal", () => {
  async function applyAndCaptureSignals(replayed: boolean) {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const client = {
        rpc: vi.fn(async () => ({
          data: { paymentResult: { replayed } },
          error: null,
        })),
        from: vi.fn(),
      };
      const applied = await createPort(client as never).applyFailedResult({
        idempotencyKey: "renewal-apply-1",
        paymentIntentId: "intent-1",
        occurredAt: "2026-08-26T09:14:00.000Z",
        failureReason: "provider_declined",
        failureClassification: { failureClass: "hard_do_not_retry", decidedBy: "advice_code" },
      });
      return {
        applied,
        signals: consoleInfo.mock.calls
          .map(([line]) => String(line))
          .filter((line) => line.includes("payment_decline_terminal")),
      };
    } finally {
      consoleInfo.mockRestore();
    }
  }

  it("reports the refusal that ended an off-session renewal charge", async () => {
    const { applied, signals } = await applyAndCaptureSignals(false);

    expect(applied).toEqual({ replayed: false });
    expect(signals).toHaveLength(1);
    expect(JSON.parse(signals[0])).toMatchObject({
      name: "payment_decline_terminal",
      domain: "payment",
      surface: "hidden",
      details: {
        provider: null,
        failureClass: "hard_do_not_retry",
        failureReason: "provider_declined",
        resultStatus: "failed",
        occurredAt: "2026-08-26T09:14:00.000Z",
      },
    });
  });

  // ⛔ The renewal cron replays the same row on a retried execution by design —
  // the idempotency keys are deliberately deterministic. A signal per replay
  // would page once per sweep for a refusal already reported.
  it("stays silent when the cron replayed a refusal it already propagated", async () => {
    const { applied, signals } = await applyAndCaptureSignals(true);

    expect(applied).toEqual({ replayed: true });
    expect(signals).toHaveLength(0);
  });
});
