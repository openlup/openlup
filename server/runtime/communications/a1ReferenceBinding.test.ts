import { readFileSync } from "node:fs";
import type { SyncRequest, ConsentPushRequest } from "@openlup/platform/communications/contracts";
import { createHash, createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createA1ReferenceBinding, type A1HostInputs, type A1Ports } from "./a1ReferenceBinding.js";
const syncBinding = { account: "account:1", environment: "test", namespace: "namespace:1", mappingVersion: "v1" };
const audience = { kind: "audience" as const, reference: "audience:1" };
const projection = { email: "synthetic@example.invalid", externalReference: "local:1", fields: { givenName: "Synthetic" }, properties: { segment: "example" } };
function request<O extends SyncRequest["operation"]>(operation: O, overrides: Partial<SyncRequest<O>> = {}): SyncRequest<O> {
  const payload = operation === "profile.sync" ? { projection, consentEvidenceReference: "local-consent:1" } : operation === "erasure.request" ? { caseReference: "case:1", authorityReference: "authority:1" } : {};
  // This synthetic host owns the opaque subject reference; it is not parsed by the adapter.
  return { binding: syncBinding, audience, subjectReference: "subject:1", requestId: operation + ":1", generation: 1, deadlineMs: 100000, authorizationReference: `authorization:${operation}`, operation, payload, ...overrides } as SyncRequest<O>;
}
function pushRequest(): ConsentPushRequest {
  return { ...request("profile.sync"), operation: "consent.push", authorizationReference: "authorization:consent.push", audience, payload: { action: "grant", consentEvidenceReference: "grant:1" } };
}
function marketingFixture(pending: boolean) {
  const values = new Map<string, string>(), state = { now: 10, calls: [] as string[] };
  const remote = JSON.parse(readFileSync(new URL("../../../packages/platform/test/communications/klaviyo/profile.json", import.meta.url), "utf8"));
  const config: A1HostInputs["marketing"] = {
    binding: syncBinding, audience, subjectMapper: () => ({ binding: syncBinding, subjectReference: "subject:1", generation: 1, erased: false, id: "owned_1", email: projection.email, externalReference: projection.externalReference, ownedFields: ["givenName"], ownedProperties: ["segment"] }),
    resolveCredential: () => ({ binding: syncBinding, key: "synthetic" }),
    authorizations: new Map([["authorization:profile.sync", { binding: syncBinding, audience, subjectReference: "subject:1", operation: "profile.sync", expiresAtMs: 100000 }]]),
    localEvidence: new Map([["local-consent:1", { binding: syncBinding, audience, subjectReference: "subject:1", purpose: "purpose:1", action: "profile", current: true, projection }]]),
    storage: { availability: { account: syncBinding.account, environment: syncBinding.environment, busy: false, quarantined: false },
      get: async key => values.get(key) ?? null,
      compareAndSwap: async (key, expected, next) => { if ((values.get(key) ?? null) !== expected) return false; values.set(key, next); return true; } },
    verification: pending ? undefined : { binding: syncBinding, audience, evidenceReference: "offline:synthetic-not-TEST", revision: "2026-07-15", operations: ["profile.sync"], scopes: ["profiles:read", "profiles:write"], noTrigger: { profile: true, accountWideGrant: false, doi: false }, safeCreate: false, safeListRemoval: false, suppressionSafeAtEffect: false, negativeSourcesComplete: false, listMappings: {} },
    now: () => state.now, rateIntervalMs: 1,
    fetch: async (_url, init) => { const method = init?.method ?? "GET"; state.calls.push(method); state.now += 2; return Response.json(remote); },
  };
  return { config, storage: config.storage, state, effects: () => state.calls.filter(method => method !== "GET") };
}

const candidate = { artifact: "synthetic", configuration: "selected", environment: "disposable", database: "synthetic", schema: "70" };
const at = "2026-10-20T12:00:00.000Z";
const message = { from: "sender@example.invalid", to: "reader@example.invalid", subject: "Synthetic", html: "<p>Notice</p>" };
function host(pending = false) {
  const marketing = marketingFixture(pending);
  let current = candidate;
  const effects: string[] = [];
  const callbackPort = { findSend: vi.fn(async () => ({ id: "send" })), applyObservation: vi.fn(async () => {}), recordAttempt: vi.fn(async () => {}) };
  const inputs: A1HostInputs = {
    migrationIdentity: "70",
    admission: { candidate, currentIdentity: () => current,
      observed: { loadedPackages: [{ name: "@openlup/core", version: "0.17.0", kind: "kernel" }, { name: "@openlup/platform", version: "0.17.0", kind: "rail" }], inventoryComplete: true },
      schemaProbe: { observe: async required => ({ database: "synthetic", version: "70", objects: required.objects.map(object => ({ object, present: true })) }) } },
    sender: { environmentTagName: "host_env", policy: vi.fn(to => { effects.push("policy"); return { mode: "sandbox_sink" as const, reason: "synthetic", intendedRecipient: to, recipient: "sink@example.invalid", credential: "synthetic-send", environmentTag: "non_production" as const }; }),
      fetch: vi.fn(async (_url, init) => { effects.push(String(init?.method)); return Response.json({ id: "message" }); }) },
    callback: { port: callbackPort, webhookSecret: "synthetic-hook", environmentTagName: "host_env", resolveReceiverEnvironmentTag: () => "non_production", now: () => 1000 },
    marketing: marketing.config,
    delivery: { database: { connectionString: "postgresql://unused.invalid/synthetic" }, options: { binding: "synthetic", poolFactory: () => { effects.push("database"); throw Error("unexpected database"); } },
      resolveCredential: () => { effects.push("credential"); return "synthetic-read"; }, now: () => { effects.push("clock"); return at; }, graceMinutes: 45, limit: 1 },
  };
  return { inputs, marketing, callbackPort, effects, stale: () => { current = { ...candidate, configuration: "changed" }; } };
}
async function bind(h = host()) { return (await createA1ReferenceBinding({ enabled: true, loadHostInputs: () => h.inputs }))!; }
const invocations = (p: A1Ports) => [
  () => p.transport.send(message), () => p.webhook({ rawBody: "{}", headers: {} }), () => p.reconcile(),
  () => p.marketing.profiles.sync(request("profile.sync")), () => p.marketing.consent.read(request("consent.read")),
  () => p.marketing.erasure.request(request("erasure.request")), () => p.marketing.erasure.read(request("erasure.read")),
  () => p.marketing.consentPush.push(pushRequest()), () => p.marketing.newsletter.sync({} as never), () => p.marketing.newsletter.reconcile!(),
  () => p.marketing.admit({} as never, {} as never), () => p.marketing.apply({} as never, {} as never), () => p.marketing.observe({} as never, {} as never),
];
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock("./referenceComposition.js"); vi.doUnmock("@openlup/platform/communications/resend"); vi.doUnmock("@openlup/platform/communications/klaviyo"); vi.doUnmock("@openlup/platform/communications"); vi.resetModules(); });

it("P3 case 1: absent and false opt-in do no loading, imports or construction", async () => {
  const loadHostInputs = vi.fn(() => { throw Error("eager host input"); });
  const imported = vi.fn(() => { throw Error("eager composition import"); });
  vi.doMock("./referenceComposition.js", imported);
  vi.doMock("@openlup/platform/communications/resend", imported);
  vi.doMock("@openlup/platform/communications/klaviyo", imported);
  vi.doMock("@openlup/platform/communications", imported);
  const { createA1ReferenceBinding: create } = await import("./a1ReferenceBinding.js");
  expect(await create()).toBeUndefined();
  expect(await create({ loadHostInputs })).toBeUndefined();
  expect(await create({ enabled: false, loadHostInputs })).toBeUndefined();
  expect(loadHostInputs).not.toHaveBeenCalled(); expect(imported).not.toHaveBeenCalled();
});
it("P3 case 2: schema refusal and stale identity block every exposed callable before effects", async () => {
  for (const ready of [false, true]) {
    const h = host();
    if (!ready) h.inputs.admission.schemaProbe = { observe: async required => ({ database: "synthetic", version: "69", objects: required.objects.map(object => ({ object, present: false })) }) };
    h.inputs.select = ports => ({ routes: [{ id: "/synthetic", handle: ports.webhook as never }], schedules: [{ id: "synthetic", cadenceSeconds: 60, run: ports.reconcile }] });
    const binding = await bind(h); expect(binding.admitted).toBe(ready); if (ready) h.stale();
    for (const invoke of [...invocations(binding.ports), () => binding.route("/synthetic", {} as never, {} as never), () => binding.run("synthetic"),
      () => binding.runtime.routes[0]!.handle({} as never), () => binding.runtime.schedules[0]!.run()]) {
      await expect(async () => invoke()).rejects.toThrow(ready ? "stale" : "not_admitted");
    }
    expect(h.effects).toEqual([]); expect(h.marketing.state.calls).toEqual([]); expect(h.callbackPort.findSend).not.toHaveBeenCalled();
  }
});
it("P3 case 3: guarded send and authenticated environment-selected callback delegate exactly", async () => {
  const h = host(), binding = await bind(h);
  expect((await binding.ports.transport.send(message)).outcome.ok).toBe(true);
  const fetcher = vi.mocked(h.inputs.sender.fetch!);
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ to: ["sink@example.invalid"], tags: [{ name: "host_env", value: "non_production" }] });
  const blocked = host(); blocked.inputs.sender.policy = () => ({ mode: "blocked", reason: "synthetic" });
  expect((await (await bind(blocked)).ports.transport.send(message)).outcome.ok).toBe(false); expect(blocked.effects).toEqual([]);
  for (const tag of ["production", "non_production"]) {
    const rawBody = JSON.stringify({ type: "email.delivered", data: { email_id: "message", tags: [{ name: "host_env", value: tag }] } });
    expect((await binding.ports.webhook({ rawBody, headers: {} })).status).toBe(401);
    const signature = createHmac("sha256", "synthetic-hook").update("hook.1000." + rawBody).digest("base64");
    expect((await binding.ports.webhook({ rawBody, headers: { webhookId: "hook", timestamp: "1000", signature: "v1," + signature } })).status).toBe(200);
    expect(h.callbackPort.applyObservation).toHaveBeenCalledTimes(tag === "production" ? 0 : 1);
  }
  expect(h.callbackPort.applyObservation.mock.calls[0]).toBeDefined();
});
it("P3 case 4: current marketing ports retain pending verification, shared host state and newsletter refusal", async () => {
  const pending = host(true), unverified = await bind(pending);
  expect(unverified.ports.marketing.capabilities.operations["profile.sync"].state).toBe("verification_pending");
  expect(await unverified.ports.marketing.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "refused", reason: "verification_pending" });
  expect(pending.marketing.state.calls).toEqual([]);
  const h = host(), first = await bind(h);
  expect(await first.ports.marketing.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "acknowledged" });
  const writes = h.marketing.effects().length;
  const second = await bind(h);
  expect(await second.ports.marketing.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "acknowledged" });
  expect(h.marketing.effects()).toHaveLength(writes);
  h.marketing.storage.availability.quarantined = true;
  h.marketing.state.now += 100;
  const third = await bind(h);
  expect(await third.ports.marketing.profiles.sync(request("profile.sync", { requestId: "new" }))).toMatchObject({ kind: "retryable", reason: "cooling" });
  expect(h.marketing.effects()).toHaveLength(writes); expect(h.marketing.storage.availability.quarantined).toBe(true);
  expect(await third.ports.marketing.newsletter.sync({} as never)).toEqual({ status: "skipped", reason: "unsupported" });
  expect(await third.ports.marketing.newsletter.reconcile!()).toEqual({ status: "skipped", reason: "unsupported" });
});
it("P3 case 5: real polling converges through native mapping, replay, unknown refusal and pool cleanup", async () => {
  const h = host(), facts = new Map<string, unknown>(), kinds: unknown[] = [];
  let closes = 0, releases = 0, pools = 0, notFound = 0;
  const send = { id: "send", message_id: "message", recipient_fingerprint: createHash("sha256").update(message.to).digest("hex"), observed_state: null, observed_at: at, abandoned_at: null };
  h.inputs.delivery.options.poolFactory = (() => { pools++; return {
    connect: async () => ({ release: () => { releases++; }, query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("AS browser")) return { rows: [{ browser: false, unsafe: false }] };
      if (sql.includes("SELECT id,message_id")) return { rows: [send] };
      if (sql.includes("SELECT * FROM public.communication_native_sends")) return { rows: [send] };
      if (sql.includes("INSERT INTO public.communication_native_observations")) {
        expect(values[2]).toBe("send"); expect(values[4]).toBe("2026-10-20T12:00:00.000000Z");
        const key = String(values[1]); if (facts.has(key)) return { rows: [] };
        facts.set(key, values[6]); kinds.push(values[3]); return { rows: [{ observation_key: key }] };
      }
      if (sql.includes("SELECT fact_fingerprint")) return { rows: [{ fact_fingerprint: facts.get(String(values[1])) }] };
      if (sql.includes("SELECT abandoned_at")) return { rows: [{ abandoned_at: notFound >= 3 ? at : null }] };
      if (sql.includes("not_found_count=least")) { expect(values[2]).toBe(3); notFound++; return { rows: [{ abandoned_at: notFound >= 3 ? at : null }] }; }
      return { rows: [{ id: "send" }] };
    } }), end: async () => { closes++; },
  }; }) as never;
  let state = "delivery_delayed", status = 200;
  h.inputs.delivery.fetch = async () => Response.json({ last_event: state, to: [message.to] }, { status });
  const binding = await bind(h);
  for (const [wire, nativeKind] of [["delivery_delayed", "delayed"], ["delivered", "delivered"], ["failed", "failed"], ["bounced", "bounced"], ["complained", "complained"]]) {
    state = wire!; const result = await binding.ports.reconcile(); expect(result.reconciled).toBe(1); expect(result.failures).toBe(0); expect(kinds.at(-1)).toBe(nativeKind);
    const size = facts.size; expect((await binding.ports.reconcile()).reconciled).toBe(1); expect(facts.size).toBe(size);
  }
  // Capture only the wrapper; the five-state transcript above executes the real poller and native writer.
  vi.spyOn(await import("@openlup/platform/communications/resend"), "runResendDeliveryReconciliation").mockImplementationOnce(async input => {
    const before = facts.size;
    expect(() => input.port.applyPolledEvent({ sendId: "send", messageId: "message", eventType: "email.unknown", eventAt: at, recipientEmail: null })).toThrow("a1_poll_kind_unknown");
    expect(facts.size).toBe(before);
    await input.port.applyPolledEvent({ sendId: "send", messageId: "message", eventType: "email.sent", eventAt: at, recipientEmail: null });
    expect(kinds.at(-1)).toBe("sent"); throw Error("poll failure");
  });
  await expect(binding.ports.reconcile()).rejects.toThrow("poll failure");
  status = 404;
  for (let n = 0; n < 4; n++) expect((await binding.ports.reconcile()).abandoned).toBe(n === 2 ? 1 : 0);
  h.inputs.delivery.resolveCredential = () => { throw Error("credential failure"); };
  await expect(binding.ports.reconcile()).rejects.toThrow("credential failure");
  expect(closes).toBe(pools); expect(releases).toBeGreaterThan(0);
});
