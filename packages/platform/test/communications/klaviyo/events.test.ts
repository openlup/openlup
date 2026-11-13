import { expect, it } from "vitest";
import type { EcommerceEvent, EcommerceEventExportRequest } from "../../../src/communications/contracts/ecommerceEvents.js";
import { withdraw, request as syncRequest } from "./harness.js";
import { clientId, orderId, eventFixture } from "./eventsHarness.js";

it("E01 emits the frozen existing-profile tuple and uses authoritative currency exponent without consent writes", async () => {
  for (const [currency, exponent] of [["JPY", 0], ["USD", 2], ["BHD", 3]] as const) {
    const h = eventFixture(), request = { ...h.request, currencyExponent: exponent,
      event: { ...h.request.event, data: { ...(h.request.event as Extract<EcommerceEvent, { sourceType: "order.paid" }>).data, currency } } } as EcommerceEventExportRequest;
    h.approve(request);
    expect(h.provider.events.capabilities).toMatchObject({ state: "supported", binding: h.binding });
    expect(await h.provider.events.exportEvent(request)).toEqual({ kind: "accepted" });
    const call = h.state.calls[0], attributes = call.body.data.attributes;
    expect(call).toMatchObject({ url: "https://a.klaviyo.com/api/events", method: "POST", redirect: "manual",
      headers: { revision: "2026-07-15", Authorization: "Klaviyo-API-Key synthetic-key", "Content-Type": "application/vnd.api+json" } });
    expect(attributes).toMatchObject({ unique_id: "paid:1", time: request.event.occurredAt,
      value: 12345 / 10 ** exponent, value_currency: currency, profile: { data: { type: "profile", id: "owned_1" } },
      metric: { data: { type: "metric", attributes: { name: "Placed Order" } } } });
    expect(Object.keys(attributes.profile as object)).toEqual(["data"]);
    expect((attributes.profile as { data: object }).data).toEqual({ type: "profile", id: "owned_1" });
    expect(JSON.stringify(call.body)).not.toMatch(/email|external_id|settlementIntentId|authorization|backfill/);
    expect(h.ledger()).toMatchObject({ version: 1, entries: {}, withdrawals: {}, slot: false, quarantined: false });
  }
  const independent = eventFixture(); independent.config.verification = undefined; independent.authorizations.clear(); independent.localEvidence.clear();
  expect(await independent.rebuild().events.exportEvent(independent.request)).toEqual({ kind: "accepted" });
  expect(independent.state.calls).toHaveLength(1);
  for (const [minor, exponent, wire] of [
    [Number.MAX_SAFE_INTEGER, 0, "9007199254740991"],
    [Number.MAX_SAFE_INTEGER - 1, 2, "90071992547409.9"],
    [Number.MAX_SAFE_INTEGER, 2, undefined],
    [Number.MAX_SAFE_INTEGER - 1, 3, "9007199254740.99"],
    [Number.MAX_SAFE_INTEGER, 3, undefined],
    [0, 0, "0"], [0, 2, "0"], [0, 3, "0"],
  ] as const) {
    const h = eventFixture(), event = h.request.event as Extract<EcommerceEvent, { sourceType: "order.paid" }>;
    const request = { ...h.request, currencyExponent: exponent, event: { ...event, data: { ...event.data, amountMinor: minor,
      lines: [{ sku: "ITEM-1", quantity: 1, amountMinor: minor }] } } };
    h.approve(request);
    const outcome = await h.provider.events.exportEvent(request);
    expect(outcome, `${minor}/${exponent}`).toEqual(wire === undefined ? { kind: "refused", reason: "amount_unrepresentable" } : { kind: "accepted" });
    if (wire === undefined) expect(h.state.calls).toHaveLength(0);
    else expect(JSON.stringify(h.state.calls[0].body.data.attributes.value)).toBe(wire);
  }
});

it("E02 keeps refund status and the finite lifecycle catalogue nonfinancial", async () => {
  const events: EcommerceEvent[] = [
    { schemaVersion: 1, sourceId: "refund:1", sourceType: "order.refund_status_changed", occurredAt: new Date(1).toISOString(), subject: { clientId }, data: { orderId, status: "refunded" } },
    { schemaVersion: 1, sourceId: "checkout:1", sourceType: "checkout.recovery_qualified", occurredAt: new Date(1).toISOString(), subject: { clientId }, data: { orderId, expiresAt: new Date(100000).toISOString() } },
    ...(["subscription.created", "subscription.paused", "subscription.resumed", "subscription.cancelled"] as const).map(sourceType => ({ schemaVersion: 1 as const, sourceId: sourceType, sourceType, occurredAt: new Date(1).toISOString(), subject: { clientId }, data: { subscriptionId: orderId } })),
  ];
  for (const event of events) {
    const h = eventFixture(), { currencyExponent: _exponent, currencyExponentSource: _source, ...base } = h.request;
    const request = { ...base, event }; h.approve(request);
    expect(await h.provider.events.exportEvent(request), event.sourceType).toEqual({ kind: "accepted" });
    const attributes = h.state.calls[0].body.data.attributes;
    expect(attributes).not.toHaveProperty("value"); expect(attributes).not.toHaveProperty("value_currency");
    expect(JSON.stringify(attributes)).not.toContain('"Refunded Order"');
    expect(attributes.metric).toMatchObject({ data: { attributes: { name: expect.stringMatching(/^OpenLup /) } } });
  }
});

it("E03 refuses unqualified operations, mappings, history, future and malformed data before HTTP", async () => {
  const variants: [string, (h: ReturnType<typeof eventFixture>) => void | EcommerceEventExportRequest][] = [
    ["missing event scope", h => { h.config.events!.verification!.scopes = []; h.provider = h.rebuild(); }],
    ["no qualification", h => { h.config.events!.verification = undefined; h.provider = h.rebuild(); }],
    ["unproved effects", h => { h.config.events!.verification!.accountEffectsVerified = false; h.provider = h.rebuild(); }],
    ["unqualified source type", h => { h.config.events!.verification!.sourceTypes = ["order.refund_status_changed"]; h.provider = h.rebuild(); }],
    ["duplicate message ownership", h => { h.config.events!.verification!.messageOwnershipVerified = false; h.provider = h.rebuild(); }],
    ["wrong mapping", h => { h.config.binding = { ...h.binding, mappingVersion: "arbitrary" }; h.config.verification = undefined; h.provider = h.rebuild(); return { ...h.request, binding: h.config.binding }; }],
    ["foreign binding", h => ({ ...h.request, binding: { ...h.binding, account: "foreign" } })],
    ["historical", h => ({ ...h.request, classification: "historical" })],
    ["pre-cutover", h => { h.config.events!.liveSinceMs = 2; h.provider = h.rebuild(); }],
    ["future", h => ({ ...h.request, event: { ...h.request.event, occurredAt: new Date(100).toISOString() } })],
    ["unapproved extra field", h => ({ ...h.request, backfill: true } as EcommerceEventExportRequest)],
    ["missing exponent provenance", h => { const { currencyExponentSource: _source, ...request } = h.request; return request; }],
    ["financial refund injection", h => ({ ...h.request, event: { ...h.request.event, sourceType: "order.refund_status_changed", data: { orderId, status: "refunded", value: 12345 } } } as unknown as EcommerceEventExportRequest)],
    ["profile injection", h => ({ ...h.request, profileId: "profile/foreign" })],
    ["oversize", h => ({ ...h.request, authorityReference: "x".repeat(70000) })],
    ["revoked", h => { h.authority.current = false; }],
    ["erased", h => { h.state.subject.erased = true; }],
    ["stale generation", h => { h.state.subject.generation++; }],
  ];
  for (const [label, apply] of variants) {
    const h = eventFixture(), request = apply(h) ?? h.request;
    expect(await h.provider.events.exportEvent(request), label).toMatchObject({ kind: "refused" });
    expect(h.state.calls, label).toHaveLength(0);
  }
});

it("E04 rechecks current authority, erasure and target after awaits and credential lookup", async () => {
  for (const mutation of ["revoke", "erase", "generation", "profile", "email", "credential"] as const) {
    const h = eventFixture();
    const change = () => {
      if (mutation === "revoke" || mutation === "credential") h.authority.current = false;
      if (mutation === "erase") h.state.subject.erased = true;
      if (mutation === "generation") h.state.subject.generation++;
      if (mutation === "profile") h.state.subject.id = "foreign";
      if (mutation === "email") h.state.subject.email = "changed@example.invalid";
    };
    if (mutation === "credential") h.config.resolveCredential = () => { change(); return { binding: h.binding, key: "synthetic-key" }; };
    else h.state.afterAwait = change;
    const result = await h.rebuild().events.exportEvent(h.request);
    expect(result, mutation).toMatchObject({ kind: "refused" }); expect(h.state.calls, mutation).toHaveLength(0);
  }
});

it("E05 distinguishes protocol acceptance, refusals and uncertainty without reading response bodies", async () => {
  for (const status of [202, 200, 204, 301, 400, 401, 409, 500]) {
    const h = eventFixture(); h.state.fault = () => new Response(status === 204 ? null : "not-json", { status });
    expect(await h.provider.events.exportEvent(h.request), String(status)).toMatchObject(status === 202 ? { kind: "accepted" }
      : status >= 400 && status < 500 ? { kind: "refused", reason: status === 409 ? "identity_conflict" : "provider_refusal" }
        : { kind: "unknown", reason: "acceptance_ambiguous" });
    expect(h.ledger()).toMatchObject({ entries: {}, slot: false, quarantined: false });
    expect(h.storage.availability).toMatchObject({ busy: false, quarantined: false });
  }
  for (const fault of ["network", "timeout"] as const) {
    const h = eventFixture(); h.state.fault = () => fault === "network" ? Promise.reject(new Error("synthetic")) : new Promise<Response>(() => {});
    expect(await h.provider.events.exportEvent(h.request), fault).toEqual({ kind: "unknown", reason: "acceptance_ambiguous" });
    expect(h.storage.availability).toMatchObject({ busy: false, quarantined: false });
    expect(h.ledger()).toMatchObject({ entries: {}, slot: false, quarantined: false });
  }
  const h = eventFixture(), controller = new AbortController(); controller.abort();
  expect(await h.provider.events.exportEvent(h.request, { signal: controller.signal })).toMatchObject({ kind: "refused", reason: "deadline" });
  expect(await h.provider.events.exportEvent(h.request, { deadlineMs: 10 })).toMatchObject({ kind: "refused", reason: "deadline" });
  expect(h.state.calls).toHaveLength(0);
  const mapper = eventFixture(); mapper.config.subjectMapper = () => { throw new Error("synthetic mapper unavailable"); };
  expect(await mapper.rebuild().events.exportEvent(mapper.request)).toEqual({ kind: "retryable", reason: "host", afterSeconds: 1 });
  expect(mapper.state.calls).toHaveLength(0);
  const aborting = eventFixture(), during = new AbortController();
  aborting.state.fault = () => { during.abort(); return new Promise<Response>(() => {}); };
  expect(await aborting.provider.events.exportEvent(aborting.request, { signal: during.signal })).toEqual({ kind: "unknown", reason: "acceptance_ambiguous" });
  expect(aborting.storage.availability).toMatchObject({ busy: false, quarantined: false });
});

it("E06 shares the in-flight budget and permits withdrawal after an uncertain event without a new fence", async () => {
  const h = eventFixture(); let started!: () => void;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  h.state.fault = url => { if (url.endsWith("/api/events")) { started(); return new Promise<Response>(() => {}); } };
  const pending = h.provider.events.exportEvent(h.request); await inFlight;
  expect(await h.rebuild().consentPush.push(withdraw({ binding: h.binding }))).toMatchObject({ kind: "retryable", reason: "cooling" });
  expect(h.state.calls).toHaveLength(1);
  expect(await pending).toEqual({ kind: "unknown", reason: "acceptance_ambiguous" });
  h.state.fault = undefined;
  expect(h.ledger().entries).toEqual({});
  expect(await h.rebuild().consentPush.push(withdraw({ binding: h.binding }))).toMatchObject({ kind: "acknowledged", reconcileRequired: false });
  expect(h.effects()).toHaveLength(2);
});

it("E07 shares pacing and durable numeric/date/default cooling across events and consent", async () => {
  for (const retryAfter of ["2.4", new Date(8010).toUTCString(), "bad"]) {
    const h = eventFixture(); h.state.fault = () => new Response(null, { status: 429, headers: { "Retry-After": retryAfter } });
    const result = await h.provider.events.exportEvent(h.request);
    expect(result).toEqual({ kind: "retryable", reason: "cooling", afterSeconds: retryAfter === "2.4" ? 3 : retryAfter === "bad" ? 60 : 8 });
    h.state.fault = undefined;
    expect(await h.rebuild().consentPush.push(withdraw({ binding: h.binding }))).toMatchObject({ kind: "retryable", reason: "cooling" });
    expect(h.state.calls).toHaveLength(1);
    h.state.now = h.ledger().coolingUntil + 2;
    expect(await h.rebuild().consentPush.push(withdraw({ binding: h.binding }))).toMatchObject({ kind: "acknowledged" });
  }
  const h = eventFixture(); h.config.rateIntervalMs = 100;
  expect(await h.rebuild().events.exportEvent(h.request)).toEqual({ kind: "accepted" });
  expect(await h.rebuild().events.exportEvent(h.request)).toMatchObject({ kind: "retryable", reason: "cooling" });
  expect(h.state.calls).toHaveLength(1);
  const reverse = eventFixture(); reverse.state.fault = () => new Response(null, { status: 429, headers: { "Retry-After": "3" } });
  expect(await reverse.provider.consent.read(syncRequest("consent.read", { binding: reverse.binding }))).toMatchObject({ kind: "retryable", reason: "cooling" });
  reverse.state.fault = undefined;
  expect(await reverse.rebuild().events.exportEvent(reverse.request)).toMatchObject({ kind: "retryable", reason: "cooling" });
  expect(reverse.state.calls).toHaveLength(1);
});

it("E08 retains identical retry bytes and distinguishes genuine shared storage failure from event uncertainty", async () => {
  const h = eventFixture(); h.state.fault = () => Promise.reject(new Error("synthetic lost event response"));
  expect(await h.provider.events.exportEvent(h.request)).toMatchObject({ kind: "unknown" });
  h.state.now += 1000; h.state.fault = undefined;
  expect(await h.rebuild().events.exportEvent(h.request)).toEqual({ kind: "accepted" });
  expect(h.state.calls[1].body).toEqual(h.state.calls[0].body);
  const changed = { ...h.request, profileId: "foreign" };
  expect(await h.rebuild().events.exportEvent(changed)).toMatchObject({ kind: "refused" });
  expect(h.state.calls).toHaveLength(2);
  for (const fault of ["throw", "lost", "false"] as const) {
    const f = eventFixture(); let once = true;
    f.state.storageFault = phase => { if (once && phase === "cas") { once = false; return fault; } };
    expect(await f.provider.events.exportEvent(f.request), fault).toMatchObject(fault === "false" ? { kind: "retryable", reason: "host" } : { kind: "unknown", reason: "dispatch_unresolved" });
    expect(f.state.calls).toHaveLength(0);
    if (fault !== "false") expect(f.storage.availability.quarantined).toBe(true);
  }
});
