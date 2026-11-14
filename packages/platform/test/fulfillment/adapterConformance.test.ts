import { expect, it } from "vitest";
import type { FulfillmentAdapterConformanceSubject as Subject, FulfillmentDispatchResult, FulfillmentReadbackResult, FulfillmentRefusal } from "../../src/fulfillment/contracts/index.js";
import { runFulfillmentAdapterConformance as run } from "../../src/fulfillment/index.js";
import { at, memoryStore, observation, profile, request } from "./fixtures.js";

function subject(full: boolean): Subject {
  let calls = 0;
  const prepared = new Map<string, string>(), responses = new Map<string, FulfillmentDispatchResult>();
  const unsupported = (phase: FulfillmentRefusal["phase"]): FulfillmentRefusal => ({ reason: "unsupported", phase, retryable: false });
  const evidence = (input = request()) => ({ commandFingerprint: `actual:${input.requestKey}:${input.contactRevision.revision}`, contactRevision: input.contactRevision, providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a" });
  const accepted = (input = request()): FulfillmentDispatchResult => ({ kind: "accepted", externalRef: "external-a", evidence: evidence(input), providerAttemptKey: "legacy-attempt", labelKey: "legacy-label" });
  const readInput = (kind: string) => ({ providerRef: "warehouse-a", requestKey: kind, fulfillmentRef: "fulfillment-a", externalRef: "external-a", mode: "command" as const });
  const readResult = (kind: string): FulfillmentReadbackResult => {
    if (!full || kind === "unsupported") return { kind: "unsupported", refusal: unsupported("readback") };
    if (kind === "absent") { const { mode: _mode, ...scope } = readInput(kind); return { kind: "absent", scope, proof: { kind: "authoritative_exact_lookup", evidenceRef: "evidence:exact-a", checkedAt: at } }; }
    if (kind === "unknown" || kind === "missing") return { kind: "unknown", refusal: { reason: kind === "missing" ? "local_missing" : "io_failure", phase: "readback", retryable: kind !== "missing" } };
    return { kind: "found", externalRef: "external-a", createdAt: null, updatedAt: at, observation: observation() };
  };
  const input = request(); const document = { objectRef: "label-a", mediaType: "application/pdf" as const, externalRef: "external-a" };
  const s: Subject = {
    subjectId: full ? "full-fixture" : "minimal-fixture", approveTrackingUrl: url => url === "https://tracking.example.invalid/TRACK-a", adapter: {
      capabilities: profile(full),
      dispatch: {
        async prepare(value) {
          if (!value.selection.providerRef) return { kind: "refused", refusal: { reason: "selection_required", phase: "selection", retryable: false } };
          if (!value.lines.length) return { kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } };
          const proof = evidence(value); prepared.set(proof.commandFingerprint, JSON.stringify(value)); return { kind: "prepared", evidence: proof };
        },
        async dispatch(value, proof) {
          if (prepared.get(proof.commandFingerprint) !== JSON.stringify(value)) return { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } };
          if (responses.has(value.requestKey)) return responses.get(value.requestKey)!;
          calls += 1;
          const result: FulfillmentDispatchResult = value.requestKey === "unknown" ? { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: true } }
            : value.requestKey === "refused" ? { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } } : accepted(value);
          responses.set(value.requestKey, result); return result;
        },
      },
      label: { async create() { return full ? { kind: "created", parcelRef: "parcel-a", document } : { kind: "refused", refusal: unsupported("dispatch") }; },
        async read() { return full ? { kind: "available", url: "https://storage.example.invalid/?signature=fixture-signed-url", expiresAt: at } : { kind: "refused", refusal: unsupported("readback") }; },
        async void() { return full ? { providerDeletion: "confirmed", labelDeleted: true, canProceed: true } : { providerDeletion: "unconfirmed", labelDeleted: false, canProceed: false, refusal: unsupported("dispatch") }; } },
      readback: { async read(value) { return readResult(value.requestKey); } },
    }, readIoCount: () => calls, sensitiveValues: ["fixture-secret", "fixture-body", "fixture-signed-url", "fixture-credential"],
    fixtures: { dispatch: [
      { input, expectedPrepare: { kind: "prepared", evidence: evidence(input) }, expectedDispatch: accepted(input), replay: true },
      { input: { ...input, lines: [] }, expectedPrepare: { kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } } },
    ],
    label: { create: [{ input: [input], expected: full ? { kind: "created", parcelRef: "parcel-a", document } : { kind: "refused", refusal: unsupported("dispatch") } }],
      read: [{ input: [document], expected: full ? { kind: "available", url: "https://storage.example.invalid/?signature=fixture-signed-url", expiresAt: at } : { kind: "refused", refusal: unsupported("readback") } }],
      void: [{ input: [{ parcelRef: "parcel-a", document }], expected: full ? { providerDeletion: "confirmed", labelDeleted: true, canProceed: true } : { providerDeletion: "unconfirmed", labelDeleted: false, canProceed: false, refusal: unsupported("dispatch") } }] },
    readback: (full ? ["found", "absent", "unknown", "missing", "unsupported"] : ["unsupported"]).map(kind => ({ input: [readInput(kind)], expected: readResult(kind), ...(kind === "missing" ? { localMissing: true } : {}) })),
    },
  };
  if (full) {
    const unknown = { ...input, requestKey: "unknown" }, refused = { ...input, requestKey: "refused" };
    s.fixtures.dispatch = [...s.fixtures.dispatch, { input: unknown, expectedPrepare: { kind: "prepared", evidence: evidence(unknown) }, expectedDispatch: { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: true } }, replay: true },
      { input: refused, expectedPrepare: { kind: "prepared", evidence: evidence(refused) }, expectedDispatch: { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } } }];
    s.adapter.observation = { async verifyAndNormalize(value) {
      if (value.headers.authorization !== "fixture-secret") return { kind: "refused", refusal: { reason: "untrusted", phase: "verify", retryable: false } };
      const status = new TextDecoder().decode(value.rawBody) === "delivered" ? "delivered" : "in_transit";
      return { kind: "verified", observation: observation(status, value.receivedAt) };
    } };
    s.fixtures.observation = ["in_transit", "delivered", "in_transit"].map((status, i) => {
      const receivedAt = `2026-10-21T1${i}:00:00.000Z`;
      return { input: [{ rawBody: new TextEncoder().encode(status), headers: { authorization: "fixture-secret" }, receivedAt }], expected: { kind: "verified", observation: observation(status === "delivered" ? "delivered" : "in_transit", receivedAt) } };
    });
    s.adapter.stockSync = { async getStock() { return []; }, async getStockMovements() { return []; } };
    s.fixtures.stockSync = [{ operation: "getStock", input: [], expected: [] }, { operation: "getStockMovements", input: [{ size: 2 }], expected: [] }];
    s.adapter.productSync = { async ensureProduct() { return null; }, async getProductPacks() { return []; }, async addProductPack() {}, async listStockedSkus() { return []; } };
    s.fixtures.productSync = [{ operation: "ensureProduct", input: ["skip"], expected: null }, { operation: "getProductPacks", input: ["sku-a"], expected: [] },
      { operation: "addProductPack", input: ["sku-a", { ean: "ean-a", quantity: 1 }], expected: undefined }, { operation: "listStockedSkus", input: [], expected: [] }];
    s.store = { create: async () => memoryStore(), claim: { requestKey: input.requestKey, fulfillmentRef: input.fulfillmentRef, orderRef: input.orderRef, parcelRef: null, mode: "stage", evidence: evidence(input) },
      remappedClaim: { requestKey: input.requestKey, fulfillmentRef: input.fulfillmentRef, orderRef: input.orderRef, parcelRef: null, mode: "stage", evidence: evidence(request(2)) },
      mappedAttemptKey: "legacy-mapped", remappedAttemptKey: "legacy-remapped", request: input, remappedRequest: request(2) };
  }
  return s;
}

it("proves full and minimal offline fixture adapters plus G14/store reclaim/remap without returning transient material", async () => {
  const evidence = await run([subject(true), subject(false)]);
  expect(evidence.subjects.map(s => s.subjectId)).toEqual(["full-fixture", "minimal-fixture"]);
  expect(evidence.cases).toContainEqual({ subjectId: "full-fixture", operation: "store G14 replay, own-key remap and one-remap bound", passed: true });
  expect(evidence.cases.some(c => c.operation === "readback absent")).toBe(true);
  expect(evidence.cases.some(c => c.operation.startsWith("dispatch unknown"))).toBe(true);
  expect(JSON.stringify(evidence)).not.toMatch(/fixture-secret|fixture-body|fixture-signed-url|fixture-credential/);
});

it("rejects mismatched preparation I/O, leaked durable fields, false absence and outcome-key collisions", async () => {
  const mismatch = subject(false); const dispatch = mismatch.adapter.dispatch.dispatch;
  mismatch.adapter.dispatch.dispatch = async (input, proof) => proof.commandFingerprint.endsWith(":mismatch") ? { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: true } } : dispatch(input, proof);
  await expect(run([mismatch])).rejects.toThrow("mismatched preparation refusal");
  const leak = subject(false); const prepare = leak.adapter.dispatch.prepare;
  leak.adapter.dispatch.prepare = async input => { const result = await prepare(input); if (result.kind === "prepared") Object.assign(result.evidence, { rawBody: "fixture-body" }); return result; };
  Object.assign(leak.fixtures.dispatch[0].expectedPrepare.kind === "prepared" && leak.fixtures.dispatch[0].expectedPrepare.evidence, { rawBody: "fixture-body" });
  await expect(run([leak])).rejects.toThrow("validation:fixtures");
  const absence = subject(true); absence.adapter.capabilities.operations = { ...absence.adapter.capabilities.operations, exactAbsence: { supported: false, reason: "not_exposed" } };
  await expect(run([absence])).rejects.toThrow("unsupported exact absence");
  const collision = subject(true); const verify = collision.adapter.observation!.verifyAndNormalize;
  collision.adapter.observation!.verifyAndNormalize = async input => { const result = await verify(input); if (result.kind === "verified") result.observation.eventKey = "provider-id-only"; return result; };
  for (const row of collision.fixtures.observation!) if (row.expected.kind === "verified") row.expected.observation.eventKey = "provider-id-only";
  await expect(run([collision])).rejects.toThrow("eventKey includes outcome and occurrence");
});

it.each(["claim", "begin"] as const)("rejects contradictory optional-store %s results", async operation => {
  const value = subject(true), create = value.store!.create;
  value.store!.create = async () => {
    const store = await create(), invoke = store[operation];
    Object.assign(store, { [operation]: async (...args: never[]) => {
      const result = await (invoke as (...input: never[]) => Promise<unknown>)(...args);
      return Object.assign(result as object, operation === "claim" ? { refusal: { reason: "claim_conflict", phase: "claim", retryable: false } } : { record: {} });
    } });
    return store;
  };
  await expect(run([value])).rejects.toThrow(`${operation} contradictory result`);
});

it("preserves baseline host-storage label reads without weakening other unsupported reads", async () => {
  const value = subject(false), available = { kind: "available" as const, url: "https://storage.example.invalid/label", expiresAt: at };
  value.adapter.capabilities.labelReadOwner = "host_storage";
  value.adapter.label!.read = async () => available;
  value.fixtures.label!.read = [{ input: value.fixtures.label!.read![0]!.input, expected: available }];
  await expect(run([value])).resolves.toHaveProperty("mode", "baseline");
  value.adapter.capabilities.labelReadOwner = "adapter";
  await expect(run([value])).rejects.toThrow("unsupported labelRead explicit refusal");
});

it.each(["bind", "call", "apply", "then"])("never reads a supplied function's %s override", async hook => {
  const value = subject(true), original = value.adapter.readback!.read;
  let alternateCalls = 0, declaredCalls = 0;
  const declared: typeof original = () => { declaredCalls++; throw new Error("declared read failed"); };
  Object.defineProperty(declared, hook, { get() { alternateCalls++; return () => original; } });
  value.adapter.readback!.read = declared;
  await expect(run([value])).rejects.toThrow("readback fixture success did not return");
  expect(declaredCalls).toBe(1); expect(alternateCalls).toBe(0);
});

it("invokes the captured I/O counter instead of its bind override", async () => {
  const value = subject(false); value.readIoCount = () => NaN;
  Object.defineProperty(value.readIoCount, "bind", { value: () => () => 0 });
  await expect(run([value])).rejects.toThrow("validation:io_count");
});

it.each(["value", "getter"])("ignores native promise then %s overrides without substituting a result", async shape => {
  const value = subject(true), read = value.adapter.readback!.read;
  let hooks = 0;
  value.adapter.readback!.read = input => {
    const pending = read(input).then(result => ({ ...result, kind: "unsupported" as const }));
    const then = () => { hooks++; return Promise.resolve(value.fixtures.readback![0]!.expected); };
    Object.defineProperty(pending, "then", shape === "getter" ? { get() { hooks++; return then; } } : { value: then });
    return pending;
  };
  await expect(run([value])).rejects.toThrow("readback fixture"); expect(hooks).toBe(0);
});

it.each(["thenable", "then-getter", "promise-proxy", "constructor", "species"])("refuses %s before reading its hooks", async shape => {
  const value = subject(true); let hooks = 0;
  value.adapter.readback!.read = () => {
    const hook = () => { hooks++; throw new Error("hook executed"); };
    const pending = shape === "thenable" ? { then: hook } : shape === "then-getter" ? Object.defineProperty({}, "then", { get: hook })
      : shape === "promise-proxy" ? new Proxy(Promise.resolve({}), { get: hook }) : Promise.resolve({});
    if (shape === "constructor") Object.defineProperty(pending, "constructor", { get: hook });
    if (shape === "species") Object.defineProperty(pending, "constructor", { value: Object.defineProperty({}, Symbol.species, { get: hook }) });
    return pending as ReturnType<NonNullable<Subject["adapter"]["readback"]>["read"]>;
  };
  await expect(run([value])).rejects.toThrow("validation:native_promise"); expect(hooks).toBe(0);
});

it.each(["iterator", "toJSON", "valueOf", "accessor", "proxy"])("never lets result %s hooks alter validation or comparison", async shape => {
  const value = subject(true), read = value.adapter.readback!.read; let hooks = 0;
  value.adapter.readback!.read = async input => {
    const result = await read(input), hook = () => { hooks++; return value.fixtures.readback![0]!.expected; };
    if (shape === "proxy") return new Proxy(result, { ownKeys: () => { hooks++; return []; } });
    Object.defineProperty(result, shape === "iterator" ? Symbol.iterator : shape === "accessor" ? "kind" : shape,
      shape === "accessor" ? { get: hook } : { value: hook });
    return result;
  };
  await expect(run([value])).rejects.toThrow("validation:uncloneable_data"); expect(hooks).toBe(0);
});

it.each(["approveTrackingUrl", "approveReference", "trackingUrl"] as const)("captures %s before calls and clones its result", async key => {
  const value = subject(true), prepare = value.adapter.dispatch.prepare; let hooks = 0;
  const original = key === "trackingUrl" ? (url: string) => url : () => true;
  Object.defineProperty(original, "bind", { get() { hooks++; throw new Error("bind read"); } });
  if (key === "approveTrackingUrl") value.approveTrackingUrl = original as (url: string) => boolean;
  else value.observationCodecs = { [key]: original };
  value.adapter.dispatch.prepare = input => {
    if (key === "approveTrackingUrl") value.approveTrackingUrl = () => false;
    else Object.assign(value.observationCodecs!, { [key]: () => { throw new Error("replaced callback"); } });
    return prepare(input);
  };
  await expect(run([value])).resolves.toHaveProperty("mode", "baseline"); expect(hooks).toBe(0);
});

it("refuses codec coercion hooks before projecting a tracking URL", async () => {
  const value = subject(true); let hooks = 0;
  value.observationCodecs = { trackingUrl: () => ({ toString() { hooks++; return "https://tracking.example.invalid/TRACK-a"; } }) as unknown as string };
  await expect(run([value])).rejects.toThrow("observation allowlist"); expect(hooks).toBe(0);
});

it.each(["subject", "port", "method", "codec", "store"] as const)("refuses an executable %s accessor without executing it", async shape => {
  const value = subject(true); let hooks = 0;
  const [owner, key] = shape === "subject" ? [value, "adapter"] : shape === "port" ? [value.adapter, "readback"] : shape === "method" ? [value.adapter.readback!, "read"] : shape === "store" ? [value.store!, "create"] : [value.observationCodecs = {}, "trackingUrl"];
  Object.defineProperty(owner, key, { get() { hooks++; throw new Error("accessor invoked"); } });
  await expect(run([value])).rejects.toThrow("validation:accessor"); expect(hooks).toBe(0);
});

it.each(["factory", "method", "result", "iterator", "late-replacement"] as const)("protects optional store %s invocations and data", async shape => {
  const value = subject(true), create = value.store!.create; let hooks = 0;
  value.store!.create = async () => {
    if (shape === "factory") throw new Error("declared factory failed");
    const store = await create(), claim = store.claim;
    if (shape === "late-replacement") {
      store.claim = async input => { store.claim = async () => { hooks++; throw new Error("replacement claim"); }; return claim(input); };
    } else if (shape === "method") {
      store.claim = () => { throw new Error("declared claim failed"); };
      Object.defineProperty(store.claim, "bind", { value: () => claim });
    } else if (shape === "result") store.claim = async input => new Proxy(await claim(input), { ownKeys: () => { hooks++; return []; } });
    else if (shape === "iterator") store.readMappedAttempts = async () => Object.defineProperty([], Symbol.iterator, { value: () => { hooks++; return [][Symbol.iterator](); } });
    return store;
  };
  if (shape === "factory") Object.defineProperty(value.store!.create, "bind", { value: () => create });
  if (shape === "late-replacement") await expect(run([value])).resolves.toHaveProperty("mode", "baseline");
  else if (shape === "factory" || shape === "method") await expect(run([value])).rejects.toEqual({});
  else await expect(run([value])).rejects.toThrow("validation:uncloneable_data");
  expect(hooks).toBe(0);
});

it.each(["port", "function", "prototype"])("refuses an executable %s proxy without invoking its traps", async shape => {
  const value = subject(true); let hooks = 0;
  if (shape === "port") value.adapter.readback = new Proxy(value.adapter.readback!, { getOwnPropertyDescriptor() { hooks++; throw new Error("trap"); } });
  else if (shape === "function") value.adapter.readback!.read = new Proxy(value.adapter.readback!.read, { apply() { hooks++; throw new Error("trap"); } });
  else value.adapter.readback = Object.create(new Proxy({}, { getOwnPropertyDescriptor() { hooks++; throw new Error("trap"); } }));
  await expect(run([value])).rejects.toThrow(`validation:${shape === "function" ? "function" : "container"}`); expect(hooks).toBe(0);
});

it.each(["hooks", "proxy"])("compares a cloned result without inspecting its inherited %s", async shape => {
  const value = subject(true), read = value.adapter.readback!.read; let hooks = 0;
  value.adapter.readback!.read = async input => {
    const hook = () => { hooks++; throw new Error("inherited hook"); };
    const prototype = shape === "proxy" ? new Proxy({}, { getPrototypeOf: hook, get: (_target, key) => key === "then" ? undefined : hook() })
      : { toJSON: hook, valueOf: hook, [Symbol.iterator]: hook };
    return Object.setPrototypeOf(await read(input), prototype);
  };
  await expect(run([value])).resolves.toHaveProperty("mode", "baseline"); expect(hooks).toBe(0);
});

it("never lets the optional remap worker await a caller thenable", async () => {
  const value = subject(true), prepare = value.adapter.dispatch.prepare, create = value.store!.create; let host = false, hooks = 0;
  value.store!.create = async () => { host = true; return create(); };
  value.adapter.dispatch.prepare = input => host ? { then(resolve: (value: unknown) => void) { hooks++; void prepare(input).then(resolve); } } as unknown as ReturnType<typeof prepare> : prepare(input);
  await expect(run([value])).rejects.toThrow("one-remap limit before I/O"); expect(hooks).toBe(0);
});

it.each(["provider-sync", "provider-reject", "store-sync", "store-reject", "sweep-sync", "sweep-reject"])("snapshots %s failures before the host worker can inspect diagnostics", async shape => {
  const value = subject(true), prepare = value.adapter.dispatch.prepare, create = value.store!.create; let host = false, hooks = 0;
  const error = Object.defineProperty({}, "code", { enumerable: true, get() { hooks++; return "forged"; } });
  const fail = () => { if (shape.endsWith("sync")) throw error; return Promise.reject(error); };
  value.store!.create = async () => {
    host = true; const store = await create();
    if (shape.startsWith("store")) store.prepare = fail;
    if (shape.startsWith("sweep")) store.markStaleSubmissionsUncertain = fail;
    return store;
  };
  value.adapter.dispatch.prepare = input => host && shape.startsWith("provider") ? fail() : prepare(input);
  await expect(run([value])).rejects.toThrow("one-remap limit before I/O"); expect(hooks).toBe(0);
});
