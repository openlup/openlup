import { expect, it } from "vitest";
import type { DispatchEvidence, DispatchRecord, FulfillmentDispatchPort, FulfillmentDispatchRequest, FulfillmentDispatchResult, FulfillmentStorePort } from "../../src/fulfillment/contracts/index.js";
import { runFulfillmentDispatchWorker } from "../../src/fulfillment/index.js";

function fixture(mode: DispatchRecord["mode"] = "live") {
  const trace: string[] = [], writes: unknown[] = [], attempts = new Map<string, unknown>(), attemptReplays: boolean[] = [];
  const acceptanceAttempts = new Map<string, { labelKey: string; externalRef: string }>();
  const ackKeys: { providerAttemptKey: string; labelKey: string }[] = [];
  const key = "legacy-dispatch: f/α";
  let candidate: FulfillmentDispatchRequest = {
    requestKey: key, fulfillmentRef: "fulfillment-a", orderRef: "order-a", orderNumber: null, parcelRef: null,
    contactRevision: { schemaVersion: 1, source: "contact", revision: 1 },
    recipient: { name: null, email: null, phone: null, line1: "Synthetic 1", line2: null, city: "Example", postalCode: "00000", country: "XX", deliveryInstructions: null, courierInstructions: null },
    lines: [{ skuRef: "sku-a", title: null, quantity: 1, productRef: null, packRef: null }],
    selection: { providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a", deliveryKind: "courier", pickupPoint: null },
  };
  let record: DispatchRecord | null = null, beginStale = 0, claimStale = 0, failAck = 0, ackCommitted = false, calls = 0, concurrentAcceptance = false;
  const keys = { request: () => key, mappedAttempt: (requestKey: string, index: number) => `${requestKey}:attempt${index === 0 ? "" : ":contact-remap"}`,
    acceptance: () => ({ providerAttemptKey: `${key}:provider-accepted`, labelKey: `${key}:label-ack` }) };
  const store: FulfillmentStorePort = {
    async read(k) { trace.push("read"); expect(k).toBe(key); return record && structuredClone(record); },
    async readCandidate() { trace.push("candidate"); return candidate; },
    async prepare() { trace.push("readiness"); return { disposition: "ready", contactRevision: candidate.contactRevision.revision }; },
    async claim(input) {
      trace.push(`claim:${input.evidence.contactRevision.revision}`); writes.push(structuredClone(input));
      if (claimStale-- > 0) { refresh(); return { kind: "refused", refusal: { reason: "contact_stale", phase: "claim", retryable: true } }; }
      const replayed = !!record;
      // A draft re-claim atomically refreshes BOTH proof fields after contact_stale.
      record = record && record.status !== "draft" ? record : { ...input, dispatchRef: "dispatch-a", externalRef: null, status: "draft", replayed };
      return { kind: "claimed", record: { ...record, replayed } };
    },
    async recordProviderAttempt(attemptKey, fulfillmentRef, preparedEvidence, dispatchMode, status) {
      trace.push(`attempt:${preparedEvidence.contactRevision.revision}`);
      const replayed = attempts.has(attemptKey); attemptReplays.push(replayed);
      if (!replayed) { const row = { attemptKey, fulfillmentRef, preparedEvidence, mode: dispatchMode, status }; attempts.set(attemptKey, row); writes.push(structuredClone(row)); }
      return { replayed };
    },
    async begin(input) {
      trace.push(`begin:${record!.evidence.contactRevision.revision}`);
      expect(input.commandFingerprint).toBe(record!.evidence.commandFingerprint);
      if (beginStale-- > 0) { refresh(); return { kind: "refused", refusal: { reason: "contact_stale", phase: "begin", retryable: true } }; }
      if (concurrentAcceptance) { record!.status = "uncertain"; record!.externalRef = "external-a"; }
      const begun = record!.status === "draft";
      if (begun) record!.status = "submitting";
      return { kind: "begun", begun, replayed: !begun, record: structuredClone(record!) };
    },
    async finalize(input) {
      trace.push("finalize"); writes.push(input);
      if (input.result.kind === "accepted") { record!.status = "uncertain"; record!.externalRef = input.result.externalRef; }
      else record!.status = input.result.kind === "unknown" ? "uncertain" : "failed";
      return structuredClone(record!);
    },
    async acknowledge(input) {
      trace.push("ack"); writes.push(input);
      const { providerAttemptKey, labelKey, externalRef } = input.acceptance;
      ackKeys.push({ providerAttemptKey, labelKey });
      const failing = failAck-- > 0;
      if (failing && !ackCommitted) throw new Error("synthetic-private-ack");
      const replayed = acceptanceAttempts.has(providerAttemptKey);
      if (replayed) {
        expect(acceptanceAttempts.get(providerAttemptKey)).toEqual({ labelKey, externalRef });
      } else {
        acceptanceAttempts.set(providerAttemptKey, { labelKey, externalRef });
      }
      record!.status = "created"; record!.externalRef = externalRef;
      if (failing) throw new Error("synthetic-private-ack");
      return { acknowledged: true, replayed, record: structuredClone(record!) };
    },
    async markStaleSubmissionsUncertain() { trace.push("sweep"); return 0; },
  };
  let response: FulfillmentDispatchResult | Error | null = null;
  const provider: FulfillmentDispatchPort = {
    async prepare(request) {
      trace.push(`command:${request.contactRevision.revision}`);
      // Actual command identity includes the recipient revision. Extra adapter
      // runtime properties must not leak into any durable record or result.
      const evidence = { commandFingerprint: `actual-command-${request.contactRevision.revision}`, contactRevision: { ...request.contactRevision, headers: "synthetic-private-header" },
        providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a", rawBody: "synthetic-private-body", rawCommand: request, password: "synthetic-private-password" };
      return { kind: "prepared", evidence };
    },
    async dispatch(request, evidence) {
      trace.push("POST"); calls += 1;
      expect(evidence.commandFingerprint).toBe(`actual-command-${request.contactRevision.revision}`);
      expect({ ...evidence, mapping: record!.evidence.mapping }).toEqual(record!.evidence);
      if (response instanceof Error) throw response;
      return response ?? { kind: "accepted", externalRef: "external-a", evidence,
        providerAttemptKey: "adapter-attempt-key", labelKey: "adapter-label-key" };
    },
  };
  function refresh() { candidate = { ...candidate, contactRevision: { ...candidate.contactRevision, revision: candidate.contactRevision.revision + 1 } }; }
  return { trace, writes, attempts, attemptReplays, acceptanceAttempts, ackKeys, store, provider, keys,
    run: () => runFulfillmentDispatchWorker({ store, provider, keys, config: { mode, batchLimit: 10 }, listCandidates: async () => { trace.push("list"); return [candidate]; }, now: () => new Date("2026-10-21T10:00:00Z") }),
    stale: (where: "begin" | "claim", count = 1) => { if (where === "begin") beginStale = count; else claimStale = count; },
    failAck: (committed = false) => { failAck = 1; ackCommitted = committed; },
    acceptConcurrently: () => { concurrentAcceptance = true; },
    response: (value: FulfillmentDispatchResult | Error) => { response = value; },
    record: () => record!, calls: () => calls,
  };
}

it("keeps readback → attempt → begin order, refreshes the draft once, preserves opaque keys and redacts evidence (G14)", async () => {
  const f = fixture(); f.stale("begin");
  expect(await f.run()).toMatchObject({ ok: true, updated: 1, providerCalls: 1 });
  expect(f.trace).toEqual(["sweep", "list", "read", "readiness", "candidate", "command:1", "claim:1", "read", "attempt:1", "begin:1", "candidate", "command:2", "claim:2", "read", "attempt:2", "begin:2", "POST", "ack"]);
  expect([...f.attempts.keys()]).toEqual(["legacy-dispatch: f/α:attempt", "legacy-dispatch: f/α:attempt:contact-remap"]);
  expect(f.record().evidence).toMatchObject({ commandFingerprint: "actual-command-2", contactRevision: { revision: 2 } });
  expect(JSON.stringify(f.writes)).not.toMatch(/synthetic-private|rawBody|rawCommand|headers|password|recipient/);
  for (const where of ["claim", "begin"] as const) {
    const bounded = fixture(); bounded.stale(where, 2);
    expect(await bounded.run()).toMatchObject({ ok: false, reason: "contact_stale", providerCalls: 0 });
    expect(bounded.trace.filter(x => x.startsWith("command:"))).toHaveLength(2);
  }
});

it("records attempts before shadow exit and unsafe-state refusal; the same key replays without another write", async () => {
  const f = fixture("shadow");
  expect(await f.run()).toMatchObject({ ok: true, updated: 1, providerCalls: 0 });
  const first = JSON.stringify([...f.attempts]);
  expect(await f.run()).toMatchObject({ ok: true, updated: 0, providerCalls: 0 });
  expect(f.attemptReplays).toEqual([false, true]); expect(f.attempts.size).toBe(1);
  expect(JSON.stringify([...f.attempts])).toBe(first);
  expect(f.trace).not.toContain("POST"); expect(f.trace).not.toContain("begin:1");
  for (const status of ["submitting", "uncertain", "failed", "cancelled", "cancel_requested"] as const) {
    const unsafe = fixture("shadow"); await unsafe.run(); unsafe.record().status = status;
    const result = await runFulfillmentDispatchWorker({ store: unsafe.store, provider: unsafe.provider, keys: unsafe.keys,
      config: { mode: "live", batchLimit: 1 }, listCandidates: async () => [await unsafe.store.readCandidate("fulfillment-a") as FulfillmentDispatchRequest] });
    expect(result).toMatchObject({ ok: false, providerCalls: 0, reason: `dispatch_not_safe_to_submit:${status}` });
    expect(unsafe.trace.at(-1)).toBe("attempt:1");
  }
});

it("repairs accepted proof after a lost ACK locally and never posts twice, including an ACK that committed before throwing", async () => {
  for (const committed of [false, true]) {
    const f = fixture(); f.failAck(committed);
    expect(await f.run()).toMatchObject(committed ? { ok: true, updated: 1 } : { ok: false, reason: "dispatch_proof_write_failed_after_provider_acceptance" });
    expect(f.record().status).toBe(committed ? "created" : "uncertain");
    expect(f.record().externalRef).toBe("external-a");
    expect(await f.run()).toMatchObject({ ok: true, providerCalls: 0, replayed: committed ? 1 : 0, updated: committed ? 0 : 1 });
    if (!committed) expect(f.writes.at(-1)).toMatchObject({ acceptance: { recovery: { source: "persisted_acceptance", proof: "persisted_external_ref", noProviderPost: true } } });
    expect(f.calls()).toBe(1); expect(f.record().status).toBe("created");
    expect(f.trace.slice(-3)).toEqual(["list", "read", "ack"]);
    expect(f.ackKeys).toEqual([f.keys.acceptance(), f.keys.acceptance()]);
    expect([...f.acceptanceAttempts]).toEqual([[f.keys.acceptance().providerAttemptKey,
      { labelKey: f.keys.acceptance().labelKey, externalRef: "external-a" }]]);
  }
});

it("uses the same host acceptance keys after POST, at loop-start repair and after a concurrent begin", async () => {
  const main = fixture();
  expect(await main.run()).toMatchObject({ ok: true, providerCalls: 1, updated: 1 });
  expect(await main.run()).toMatchObject({ ok: true, providerCalls: 0, replayed: 1, updated: 0 });
  const concurrent = fixture(); concurrent.acceptConcurrently();
  expect(await concurrent.run()).toMatchObject({ ok: true, providerCalls: 0, updated: 1 });
  expect(concurrent.trace.slice(-3)).toEqual(["begin:1", "read", "ack"]);
  expect([...main.ackKeys, ...concurrent.ackKeys]).toEqual(Array.from({ length: 3 }, () => main.keys.acceptance()));
  expect(main.acceptanceAttempts.size).toBe(1);
  expect(concurrent.acceptanceAttempts.size).toBe(1);
});

it("retains definitive versus ambiguous outcomes and fails closed on unclassified post-boundary exceptions", async () => {
  for (const kind of ["not_dispatched", "unknown", "throw"] as const) {
    const f = fixture();
    f.response(kind === "throw" ? new Error("synthetic-private-body password=synthetic-private-password") : kind === "unknown"
      ? { kind, effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: true } }
      : { kind, effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } });
    const result = await f.run(); expect(result).toMatchObject({ ok: false, failures: 1, providerCalls: 1 });
    expect(f.record().status).toBe(kind === "not_dispatched" ? "failed" : "uncertain");
    expect(JSON.stringify([result, f.writes])).not.toContain("synthetic-private");
    expect(await f.run()).toMatchObject({ providerCalls: 0 }); expect(f.calls()).toBe(1);
  }
});
