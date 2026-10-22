import { expect, it } from "vitest";
import { verifyAndNormalizeFulfillmentObservation as run } from "../../src/fulfillment/index.js";
import { at, ingressFixture, observation } from "./fixtures.js";

it("authenticates before parse, keeps first receipt on redelivery and settles processing idempotently (G7/G17)", async () => {
  const f = ingressFixture();
  expect(await run({ ...f.input, enabled: false })).toMatchObject({ kind: "refused", refusal: { reason: "disabled" } });
  expect(f.trace).toEqual([]);
  expect(await run({ ...f.input, verification: { ...f.input.verification, headers: {} } })).toMatchObject({ kind: "refused", refusal: { reason: "untrusted" } });
  expect(f.trace).toEqual(["auth"]); f.trace.length = 0;
  expect(await run(f.input)).toMatchObject({ kind: "processed", replayed: false, trackingRefs: 1 });
  expect(f.trace).toEqual(["auth", "parse", "ingest", "find", "ack", "status", "stock", "handoff:false", "tracking", "invoice", "processed"]);
  const effects = [...f.durableEffects];
  f.setObservation({ ...observation(), firstReceivedAt: "2026-10-21T13:00:00.000Z" });
  expect(await run(f.input)).toMatchObject({ replayed: true, trackingRefs: 0 });
  expect(f.inbound.get(observation().eventKey)!.firstReceivedAt).toBe(at);
  expect(f.durableEffects).toEqual(effects);
  await f.input.localPersistence.markProcessed(observation().eventKey, { status: "processed" });
  await f.input.localPersistence.markProcessed(observation().eventKey, { status: "processed" });
  expect(f.processed.size).toBe(1);
  const laterA = observation("in_transit", "2026-10-21T14:00:00Z"), b = observation("delivered", "2026-10-21T13:00:00Z");
  expect(new Set([observation().eventKey, b.eventKey, laterA.eventKey]).size).toBe(3);
  expect(observation("in_transit", null).fact.occurredAt).toBeNull();
  expect(observation("in_transit", null).eventKey).toBe(observation("in_transit", null).eventKey);
});

it("retains contention, failed annotation, recovery receipt and superseding handover boundaries (F3)", async () => {
  const f = ingressFixture(observation("packed")); f.failStock(true); f.failAnnotation(true);
  await expect(run(f.input)).rejects.toBe(f.stockBusy);
  expect(f.trace).toContain("annotate"); expect(f.processed.size).toBe(0);
  expect(f.durableEffects).not.toContain("handoff");
  f.failAnnotation(false);
  await expect(run(f.input)).rejects.toBe(f.stockBusy);
  expect(f.inbound.get(observation("packed").eventKey)?.diagnostics?.annotation).toBe("recorded");
  expect(f.processed.size).toBe(0);
  f.failStock(false);
  const recovered = observation("packed"); recovered.diagnostics = { recoveredPickedReceipt: { receiptRef: "receipt-a", closed: true } };
  f.setObservation(recovered);
  const result = await run(f.input);
  expect(result.kind !== "refused" && result.observation.diagnostics?.recoveredPickedReceipt).toEqual({ receiptRef: "receipt-a", closed: true });
  expect(f.durableEffects.filter(x => x === "stock")).toHaveLength(1);
  const terminal = ingressFixture(observation("delivered"));
  terminal.input.lifecycle.effects.markHandedOver = async () => { throw new Error("superseded"); };
  terminal.input.lifecycle.classifyFailure = () => "state_conflict";
  expect(await run(terminal.input)).toMatchObject({ kind: "superseded" });
  expect(terminal.trace).not.toContain("tracking"); expect(terminal.processed.size).toBe(1);
});


it("retries missing external references before acceptance and effects; either reference permits processing", async () => {
  for (const [observedRef, dispatchRef] of [[null, null], ["  ", "\t"], ["observed-a", null], [null, " dispatch-a "]] as const) {
    const value = observation(); value.correlation.externalRef = observedRef;
    const f = ingressFixture(value);
    f.input.lifecycle.findDispatchRef = async () => {
      f.trace.push("find");
      return { orderRef: "order-a", fulfillmentRef: "fulfillment-a", dispatchRef: "dispatch-created", externalRef: dispatchRef };
    };
    if (!(observedRef?.trim() || dispatchRef?.trim())) {
      await expect(run(f.input)).rejects.toThrow(TypeError);
      await expect(run(f.input)).rejects.toThrow("fulfillment_dispatch_acceptance_external_ref_missing");
      expect(f.trace).toEqual(["auth", "parse", "ingest", "find", "auth", "parse", "ingest", "find"]);
      expect(f.durableEffects).toEqual([]);
      expect(f.processed.size).toBe(0);
      expect(f.inbound.size).toBe(1); // Receipt remains available for provider retry.
    } else {
      expect(await run(f.input)).toMatchObject({ kind: "processed" });
      expect(f.trace).toContain("ack"); expect(f.trace).toContain("status");
      expect(f.processed.size).toBe(1);
    }
  }
});
