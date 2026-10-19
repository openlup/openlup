import { expect, it, vi } from "vitest";
import { processEmailObservation, type EmailObservationPort } from "../../src/communications/emailObservation.js";
import { runDeliveryReconciliation, type DeliveryReconciliationPort } from "../../src/communications/deliveryReconciliation.js";

const now = "2026-01-02T03:04:05.000Z";
const evidence = { eventType: "delivery-confirmed", eventAt: now, metadata: { opaque: ["original", 42] } };

it.each(["success", "missing", "lookup", "apply", "telemetry"])("observation ordering and %s disposition", async fault => {
  const calls: unknown[] = [];
  const port: EmailObservationPort = {
    findSend: async id => { calls.push(["find", id]); if (fault === "lookup") throw Error(fault); return fault === "missing" ? null : { id: "send-1" }; },
    applyObservation: async row => { calls.push(["apply", row]); if (fault === "apply") throw Error(fault); },
    recordAttempt: async row => { calls.push(["attempt", row]); if (fault === "telemetry") throw Error(fault); },
  };
  const observation = vi.fn(() => { calls.push(["evidence"]); return evidence; });
  const run = processEmailObservation({ port, messageId: "message-1", observation });
  if (fault === "lookup" || fault === "apply") await expect(run).rejects.toThrow(fault);
  else expect(await run).toEqual(fault === "missing" ? { outcome: "send_not_found" } : { outcome: "processed", sendId: "send-1" });
  expect(calls).toEqual([
    ["find", "message-1"],
    ...(["lookup", "missing"].includes(fault) ? [] : [["evidence"], ["apply", { ...evidence, sendId: "send-1", messageId: "message-1" }]]),
    ...(["lookup", "apply"].includes(fault) ? [] : [["attempt", fault === "missing" ? { outcome: "send_not_found" } : { outcome: "processed", sendId: "send-1" }]]),
  ]);
});

function polling() {
  const calls: unknown[] = [];
  const port = {
    findFrozenSends: vi.fn(async query => { calls.push(["query", query]); return [{ id: "send-1", messageId: "message-1" }]; }),
    applyPolledEvent: vi.fn(async row => { calls.push(["apply", row]); }),
    recordPollAttempt: vi.fn(async row => { calls.push(["rotate", row]); }),
    recordSendNotFound: vi.fn(async row => { calls.push(["not-found", row]); return { abandoned: false }; }),
  } satisfies DeliveryReconciliationPort;
  const readEmail = vi.fn(async id => { calls.push(["read", id]); return { ok: true, httpStatus: 200, recipientEmail: "reader@example.invalid" }; });
  const observationFor = vi.fn(() => { calls.push(["classify"]); return { eventType: "delivery-confirmed", terminal: false } as { eventType: string; terminal: boolean } | null; });
  return { port, calls, readEmail, observationFor, run: () => runDeliveryReconciliation({ port, readEmail, observationFor, now, graceMinutes: 45, limit: 50 }) };
}

it.each([[404, "notFound"], [401, "authFailed"], [403, "authFailed"], [0, "network"], [500, "providerError"],
  [599, "providerError"], [429, "other"], [600, "other"]] as const)("only failed 404 abandons: %s", async (httpStatus, bucket) => {
  const h = polling();
  h.readEmail.mockImplementation(async id => { h.calls.push(["read", id]); return { ok: false, httpStatus, recipientEmail: null }; });
  const result = await h.run();
  expect(result).toEqual({ checked: 1, reconciled: 0, stillPending: 0, terminalPolled: 0, failures: 1, abandoned: 0,
    failureBreakdown: { notFound: 0, authFailed: 0, network: 0, providerError: 0, other: 0, [bucket]: 1 } });
  expect(h.calls).toEqual([["query", { now, graceMinutes: 45, limit: 50 }], ["read", "message-1"],
    httpStatus === 404 ? ["not-found", { sendId: "send-1", threshold: 3 }] : ["rotate", { sendId: "send-1", attemptedAt: now }]]);
});

it.each([null, false, true])("pending/observed terminal classification %s", async terminal => {
  const h = polling();
  h.observationFor.mockImplementation(() => { h.calls.push(["classify"]); return terminal === null ? null : { eventType: "opaque-event", terminal }; });
  const result = await h.run();
  expect(result).toMatchObject({ checked: 1, reconciled: terminal === null ? 0 : 1, stillPending: terminal === null ? 1 : 0,
    terminalPolled: terminal === true ? 1 : 0, failures: 0 });
  expect(h.calls.slice(2, 4)).toEqual([["rotate", { sendId: "send-1", attemptedAt: now }], ["classify"]]);
  expect(h.port.applyPolledEvent.mock.calls).toEqual(terminal === null ? [] : [[{ sendId: "send-1", messageId: "message-1", eventType: "opaque-event", eventAt: now, recipientEmail: "reader@example.invalid" }]]);
});

it("successful 404 retains unusual no-rotation behavior without abandonment", async () => {
  const h = polling();
  h.readEmail.mockResolvedValue({ ok: true, httpStatus: 404, recipientEmail: null });
  expect(await h.run()).toMatchObject({ reconciled: 1, failures: 0, abandoned: 0 });
  expect(h.port.recordPollAttempt).not.toHaveBeenCalled();
  expect(h.port.recordSendNotFound).not.toHaveBeenCalled();
});

it("counts only newly abandoned rows and keeps the threshold exactly three", async () => {
  const h = polling();
  h.port.findFrozenSends.mockResolvedValue([{ id: "send-1", messageId: "message-1" }, { id: "send-2", messageId: "message-2" }]);
  h.readEmail.mockResolvedValue({ ok: false, httpStatus: 404, recipientEmail: null });
  h.port.recordSendNotFound.mockResolvedValueOnce({ abandoned: true }).mockResolvedValueOnce({ abandoned: false });
  expect(await h.run()).toMatchObject({ checked: 2, failures: 2, abandoned: 1 });
  expect(h.port.recordSendNotFound.mock.calls).toEqual([[{ sendId: "send-1", threshold: 3 }], [{ sendId: "send-2", threshold: 3 }]]);
});

it.each(["rotation", "apply"])("continues after %s failure without dropping the next observation", async fault => {
  const h = polling();
  h.port.findFrozenSends.mockResolvedValue([{ id: "send-1", messageId: "message-1" }, { id: "send-2", messageId: "message-2" }]);
  if (fault === "rotation") h.port.recordPollAttempt.mockRejectedValueOnce(Error(fault));
  else h.port.applyPolledEvent.mockRejectedValueOnce(Error(fault));
  expect(await h.run()).toMatchObject({ checked: 2, failures: 1, reconciled: fault === "rotation" ? 2 : 1 });
  expect(h.port.applyPolledEvent).toHaveBeenCalledTimes(2);
});

it.each(["query", "read", "not-found", "classification"])("preserves %s throw propagation", async fault => {
  const h = polling();
  if (fault === "query") h.port.findFrozenSends.mockRejectedValue(Error(fault));
  if (fault === "read") h.readEmail.mockRejectedValue(Error(fault));
  if (fault === "not-found") {
    h.readEmail.mockResolvedValue({ ok: false, httpStatus: 404, recipientEmail: null });
    h.port.recordSendNotFound.mockRejectedValue(Error(fault));
  }
  if (fault === "classification") h.observationFor.mockImplementation(() => { throw Error(fault); });
  await expect(h.run()).rejects.toThrow(fault);
  expect(h.port.applyPolledEvent).not.toHaveBeenCalled();
});

it.each(["rejection", "abort", "throw", "lookup", "apply", "telemetry", "replay", "polling"])("W3 neutral engine effect allowlist: %s", async fault => {
  const effects: string[] = [];
  const write = async (target: string) => { effects.push(target); };
  const port: EmailObservationPort = {
    findSend: async () => { if (fault === "lookup") throw Error(fault); return { id: "send-1" }; },
    applyObservation: async () => { await write("communication_update_email_delivery_from_provider"); if (fault === "apply") throw Error(fault); },
    recordAttempt: async () => { await write("email_webhook_attempts"); if (fault === "telemetry") throw Error(fault); },
  };
  const transport = async () => {
    if (fault === "abort") throw new DOMException("timeout", "AbortError");
    if (fault === "throw") throw Error("transport");
    return { ok: fault !== "rejection" };
  };
  try {
    if ((await transport()).ok) {
      await processEmailObservation({ port, messageId: "message-1", observation: () => evidence });
      if (fault === "replay") await processEmailObservation({ port, messageId: "message-1", observation: () => evidence });
      if (fault === "polling") {
        const h = polling();
        h.port.applyPolledEvent.mockImplementation(async () => { await write("communication_update_email_delivery_from_provider"); });
        h.port.recordPollAttempt.mockImplementation(async () => { await write("email_sends"); });
        await h.run();
      }
    }
  } catch {
    // Inspect the entire effect log even when a communication failure propagates.
  }
  expect(effects.every(target => ["communication_update_email_delivery_from_provider", "email_webhook_attempts", "email_sends"].includes(target))).toBe(true);
  if (["rejection", "abort", "throw", "lookup"].includes(fault)) expect(effects).toEqual([]);
  else expect(effects).toContain("communication_update_email_delivery_from_provider");
});
