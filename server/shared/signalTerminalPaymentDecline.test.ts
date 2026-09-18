import { describe, expect, it, vi } from "vitest";

import { signalTerminalPaymentDecline } from "./signalTerminalPaymentDecline.js";

const base = {
  resultStatus: "failed",
  replayed: false,
  occurredAt: "2026-08-26T09:14:00.000Z",
  failureReason: "provider_declined",
  failureClassification: { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
  provider: "provider-a",
};

describe("signalTerminalPaymentDecline", () => {
  it("reports a refused payment with the codes an operator can act on", () => {
    const operationalEvents = vi.fn();
    signalTerminalPaymentDecline({ ...base, operationalEvents });

    expect(operationalEvents).toHaveBeenCalledTimes(1);
    expect(operationalEvents).toHaveBeenCalledWith({
      name: "payment_decline_terminal",
      domain: "payment",
      surface: "hidden",
      details: {
        provider: "provider-a",
        failureClass: "mandate_dead",
        failureReason: "provider_declined",
        resultStatus: "failed",
        occurredAt: "2026-08-26T09:14:00.000Z",
      },
    });
  });

  // Every seam that reaches this helper also applies successes through the same
  // port method. A signal on those would drown the refusals it exists to surface.
  it.each(["succeeded", "expired", "refunded", "processing"])(
    "stays silent for a %s result",
    (resultStatus) => {
      const operationalEvents = vi.fn();
      signalTerminalPaymentDecline({ ...base, resultStatus, operationalEvents });
      expect(operationalEvents).not.toHaveBeenCalled();
    },
  );

  // ⛔ The reconciliation cron re-reads the same attempts every sweep. Without
  // this, one refusal would re-page on every pass until the row aged out.
  it("stays silent when the write recorded no new transition", () => {
    const operationalEvents = vi.fn();
    signalTerminalPaymentDecline({ ...base, replayed: true, operationalEvents });
    expect(operationalEvents).not.toHaveBeenCalled();
  });

  // Two rails resolve a payment without classifying it and are pinned
  // classification-absent. Absence must read as absence, not as a guess.
  it("reports an honest null rather than inventing a class or a provider", () => {
    const operationalEvents = vi.fn();
    signalTerminalPaymentDecline({
      resultStatus: "failed",
      replayed: false,
      occurredAt: base.occurredAt,
      failureReason: null,
    });
    signalTerminalPaymentDecline({
      resultStatus: "failed",
      replayed: false,
      occurredAt: base.occurredAt,
      failureReason: null,
      operationalEvents,
    });

    expect(operationalEvents.mock.calls[0][0].details).toEqual({
      provider: null,
      failureClass: null,
      failureReason: null,
      resultStatus: "failed",
      occurredAt: base.occurredAt,
    });
  });

  // ⛔ The default is the console rail, not a noop. Four adapters call this, and
  // an injected-only recorder gives four chances to reintroduce the silence this
  // seam exists to end.
  it("cannot be silenced by a caller that wires no recorder", () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      signalTerminalPaymentDecline({ ...base, operationalEvents: undefined });
      const lines = consoleInfo.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes("payment_decline_terminal"))).toBe(true);
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("carries no key the recorder's allowlist would have to strip", () => {
    const operationalEvents = vi.fn();
    signalTerminalPaymentDecline({ ...base, operationalEvents });
    expect(Object.keys(operationalEvents.mock.calls[0][0].details).sort()).toEqual([
      "failureClass", "failureReason", "occurredAt", "provider", "resultStatus",
    ]);
  });
});
