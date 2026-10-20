import { expect, it } from "vitest";
import { binding, fixture, request } from "./harness.js";
import type { SyncRequest } from "../../../src/communications/contracts/marketingSync.js";

it("H01 singleton create/update, exact ownership, lookup conflicts and no-trigger", async () => {
  const h = fixture(); h.state.subject.id = undefined;
  expect(await h.provider.profiles.sync(request("profile.sync")), "H01/create").toMatchObject({ kind: "acknowledged", journal: "confirmed" });
  expect(h.effects()[0]).toMatchObject({ method: "POST", body: { data: { type: "profile", attributes: { email: "synthetic@example.invalid", external_id: "local:1", first_name: "Synthetic", properties: { segment: "example" } } } } });
  expect(await h.rebuild().profiles.sync(request("profile.sync", { requestId: "update" })), "H01/update").toMatchObject({ kind: "acknowledged" });
  const update = h.effects()[1]; expect(update.method).toBe("PATCH"); expect(update.body.data).toMatchObject({ id: "created_1" });
  expect(update.body.data.attributes).not.toHaveProperty("email"); expect(update.body.data.attributes).not.toHaveProperty("external_id");
  for (const conflict of ["duplicate", "foreign", "pagination", "unavailable"] as const) {
    const f = fixture(); f.state.subject.id = undefined;
    f.state.matches = conflict === "duplicate" ? 2 : conflict === "foreign" ? 1 : 0;
    if (conflict === "foreign") f.state.remote.data.attributes.external_id = "foreign";
    if (conflict === "pagination") f.state.lookupNext = true;
    if (conflict === "unavailable") f.state.fault = () => new Response(null, { status: 503 });
    expect(await f.provider.profiles.sync(request("profile.sync")), `H01/${conflict}`).toMatchObject(conflict === "unavailable" ? { kind: "retryable", reason: "provider" } : { kind: "refused", reason: "identity_conflict" });
    expect(f.effects(), `H01/${conflict} zero effect`).toEqual([]);
  }
  const owned = fixture(); owned.state.subject.ownedProperties = [];
  expect(await owned.provider.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "refused", reason: "identity_conflict" });
  const unsafe = fixture(undefined, { verification: { noTrigger: { profile: false, accountWideGrant: true, doi: true } } });
  expect(await unsafe.provider.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "refused", reason: "restricted" }); expect(unsafe.state.calls).toEqual([]);
  const found = fixture(); found.state.subject.id = undefined; found.state.matches = 1;
  expect(await found.provider.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "acknowledged" }); expect(found.effects()[0].method).toBe("PATCH");
});
it("H02 malformed/oversize inputs and redirect/non-JSON ambiguity", async () => {
  for (const value of [null, [], request("consent.read")]) {
    const h = fixture();
    expect(await h.provider.profiles.sync(value as never), "H02/null-array-operation mismatch").toMatchObject({ kind: "refused", reason: value && !Array.isArray(value) ? "binding" : "invalid_request" });
    expect(h.state.calls).toEqual([]);
  }
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const cyclicFixture = fixture();
  expect(await cyclicFixture.provider.profiles.sync({ ...request("profile.sync"), payload: cyclic } as never), "H02/cyclic schema").toMatchObject({ kind: "refused", reason: "invalid_request" });
  for (const change of [ { extra: true }, { generation: -1 }, { generation: Infinity }, { requestId: "" }, { subjectReference: "" }, { deadlineMs: NaN }, { payload: [] }, { operation: "profile.read" }, { payload: { projection: {}, consentEvidenceReference: "x" } } ]) {
    const h = fixture(); const r = { ...request("profile.sync"), ...change } as unknown as SyncRequest<"profile.sync">;
    expect(await h.provider.profiles.sync(r), `H02/${JSON.stringify(change)}`).toMatchObject({ kind: "refused", reason: "invalid_request" }); expect(h.state.calls).toEqual([]);
  }
  for (const properties of [{ array: [] }, { nested: {} }, { finite: NaN }, { big: "x".repeat(70000) }]) {
    const h = fixture(); const r = request("profile.sync");
    expect(await h.provider.profiles.sync({ ...r, payload: { ...r.payload, projection: { ...r.payload.projection, properties: properties as never } } })).toMatchObject({ kind: "refused", reason: "invalid_request" }); expect(h.state.calls).toEqual([]);
  }
  for (const mode of ["redirect", "html", "bad-json", "oversize"] as const) for (const mutation of [false, true]) {
    const h = fixture(); h.state.fault = (_url, init) => {
      if ((init.method !== "GET") !== mutation) return;
      return mode === "redirect" ? new Response(null, { status: 302, headers: { Location: "https://foreign.invalid" } }) : mode === "html" ? new Response("html") : new Response(mode === "oversize" ? " ".repeat(1048577) : "{", { headers: { "Content-Type": "application/json" } });
    };
    const r = mutation ? await h.provider.profiles.sync(request("profile.sync")) : await h.provider.consent.read(request("consent.read"));
    expect(r, `H02/${mode}/${mutation}`).toMatchObject(mutation ? { kind: "unknown", reason: "acceptance_ambiguous" } : { kind: "retryable", reason: "provider" });
    for (const call of h.state.calls) { expect(call.redirect).toBe("manual"); expect(call.url).toMatch(/^https:\/\/a\.klaviyo\.com\//); }
  }
});
it("H03 bounded current negative facts, partial coverage and exact scopes", async () => {
  const h = fixture(undefined, { audience: { kind: "account-wide" } });
  const m = h.state.remote.data.attributes.subscriptions.email.marketing;
  m.consent = "SUBSCRIBED";
  for (const [raw, kind, outcome] of [["UNSUBSCRIBE", "unsubscribe", "deny_permission"], ["SPAM_REPORT", "complaint", "deny_permission"], ["USER_SUPPRESSED", "manual_block", "deny_permission"], ["HARD_BOUNCE", "hard_bounce", "deny_delivery"], ["INVALID_EMAIL", "invalid_address", "deny_delivery"]]) {
    m.suppression = [{ reason: raw, timestamp: "not-time" }];
    const r = await h.provider.consent.read(request("consent.read", { audience: { kind: "account-wide" }, requestId: raw }));
    expect(r, `H03/${raw}`).toMatchObject({ kind: "completed", value: { remoteConsent: "subscribed", feedback: [{ kind, outcome, occurredAtMs: null, audience: { kind: "account-wide" } }] } });
    if (r.kind === "completed") expect(r.value).not.toHaveProperty("localConsent");
  }
  for (const reason of ["unknown-source", "unmapped-list", "missing-array", "truncated"] as const) {
    const f = fixture(); const marketing = f.state.remote.data.attributes.subscriptions.email.marketing;
    if (reason === "unknown-source") marketing.suppression = [{ reason: "POSITIVE_OPT_IN" }];
    if (reason === "unmapped-list") marketing.list_suppressions = [{ reason: "UNSUBSCRIBE", list_id: "FOREIGN" }];
    if (reason === "missing-array") delete marketing.suppression;
    if (reason === "truncated") marketing.suppression = Array.from({ length: 65 }, () => ({ reason: "UNSUBSCRIBE" }));
    const r = await f.provider.consent.read(request("consent.read")); expect(r, `H03/${reason}`).toMatchObject({ kind: "completed", value: { coverage: "partial", remoteConsent: "unknown" } });
    if (r.kind === "completed") expect(r.value.feedback.length).toBeLessThanOrEqual(64);
    expect(f.state.calls).toHaveLength(1);
  }
  const absent = fixture(); absent.state.fault = () => new Response(null, { status: 404 });
  expect(await absent.provider.consent.read(request("consent.read"))).toMatchObject({ kind: "completed", value: { coverage: "partial", remoteConsent: "unknown" } });
});
it("H04 credential/capability binding, scopes and finite construction bounds", async () => {
  const h = fixture(); h.config.resolveCredential = () => ({ binding: { ...binding, namespace: "foreign" }, key: "synthetic" });
  expect(await h.provider.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "refused", reason: "binding" }); expect(h.state.calls).toEqual([]);
  const unverified = fixture(undefined, { verification: { scopes: [] } });
  expect(await unverified.provider.consent.read(request("consent.read"))).toMatchObject({ kind: "refused", reason: "verification_pending" }); expect(unverified.state.calls).toEqual([]);
  for (const value of [0, -1, NaN, Infinity, 0.5]) expect(() => h.factory({ ...h.config, maxRequestBytes: value }), `H04/bound ${value}`).toThrow("Invalid adapter configuration");
  expect(() => h.factory({ ...h.config, verification: { ...h.config.verification!, binding: { ...binding, account: "foreign" } } })).toThrow("Invalid verification binding");
  const c = fixture(); await c.provider.consent.read(request("consent.read"));
  expect(c.state.calls[0].headers).toMatchObject({ revision: "2026-07-15", Authorization: "Klaviyo-API-Key synthetic-key", Accept: "application/vnd.api+json" });
});
it("H05 definitive rejections, singleton deletion and no invented status API", async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const h = fixture(undefined, { audience: { kind: "account-wide" } }); h.state.fault = (_url, init) => init.method === "POST" ? new Response(null, { status }) : undefined;
    expect(await h.provider.erasure.request(request("erasure.request", { audience: { kind: "account-wide" } })), `H05/${status}`).toMatchObject({ kind: "refused", reason: status === 409 ? "identity_conflict" : "provider_refusal" });
    expect(h.effects()).toHaveLength(1);
  }
  const h = fixture(undefined, { audience: { kind: "account-wide" } });
  const r = await h.provider.erasure.request(request("erasure.request", { audience: { kind: "account-wide" } }));
  expect(r).toMatchObject({ kind: "acknowledged", journal: "confirmed" });
  expect(h.effects()[0]).toMatchObject({ method: "POST", body: { data: { type: "data-privacy-deletion-job", attributes: { profile: { data: { id: "owned_1", type: "profile", attributes: {} } } } } } });
  if (r.kind === "acknowledged") expect(await h.provider.erasure.read(request("erasure.read", { audience: { kind: "account-wide" }, payload: { receipt: structuredClone(r.receipt) } }))).toMatchObject({ kind: "refused", reason: "unsupported" });
  expect(h.state.calls).toHaveLength(1);
  expect(await h.provider.profiles.sync(request("profile.sync", { audience: { kind: "account-wide" } }))).toMatchObject({ kind: "refused", reason: "restricted" });
});
it("H06 numeric + HTTP-date Retry-After, read retries and mutation timeout/5xx fence", async () => {
  for (const delay of ["2.4", new Date(8010).toUTCString(), "bad"]) {
    const h = fixture(); h.state.fault = () => new Response(null, { status: 429, headers: { "Retry-After": delay } });
    const r = await h.provider.consent.read(request("consent.read")); expect(r).toMatchObject({ kind: "retryable", reason: "cooling" });
    if (r.kind === "retryable") expect(r.afterSeconds, `H06/${delay}`).toBe(delay === "2.4" ? 3 : delay === "bad" ? 60 : 8);
    h.state.fault = undefined; const count = h.state.calls.length;
    expect(await h.rebuild().consent.read(request("consent.read", { requestId: "new" }))).toMatchObject({ kind: "retryable", reason: "cooling" }); expect(h.state.calls).toHaveLength(count);
  }
  for (const fault of ["500", "timeout", "network"] as const) for (const mutation of [false, true]) {
    const h = fixture(undefined, { audience: { kind: "account-wide" } });
    h.state.fault = () => fault === "500" ? new Response(null, { status: 500 }) : fault === "network" ? Promise.reject(Error("synthetic only")) : new Promise<Response>(() => {});
    const r = mutation ? await h.provider.erasure.request(request("erasure.request", { audience: { kind: "account-wide" } })) : await h.provider.consent.read(request("consent.read", { audience: { kind: "account-wide" } }));
    expect(r, `H06/${fault}/${mutation}`).toMatchObject(mutation ? { kind: "unknown", reason: "acceptance_ambiguous" } : { kind: "retryable", reason: "provider" });
    const before = h.state.calls.length; h.state.fault = undefined;
    if (mutation) { await h.rebuild().erasure.request(request("erasure.request", { audience: { kind: "account-wide" }, requestId: "another" })); expect(h.state.calls).toHaveLength(before); }
    else expect(await h.provider.consent.read(request("consent.read", { audience: { kind: "account-wide" }, requestId: "retry" }))).toMatchObject({ kind: "completed" });
  }
});
it("H07 atomic admission, partial/wrong/false writes and cooldown/release quarantine", async () => {
  for (const fault of ["throw", "lost", "false", "wrong"] as const) {
    const h = fixture(undefined, { audience: { kind: "account-wide" } }); let once = true;
    h.state.storageFault = (phase, next) => {
      if (once && phase === "cas" && next?.includes('"phase":"dispatched"')) { once = false; if (fault !== "wrong") return fault; }
      else if (!once && fault === "wrong" && phase === "get") { h.state.storageFault = undefined; return "wrong"; }
    };
    const r = await h.provider.erasure.request(request("erasure.request", { audience: { kind: "account-wide" } }));
    expect(r, `H07/admission/${fault}`).toMatchObject(fault === "false" ? { kind: "retryable", reason: "host" } : { kind: "unknown", reason: "dispatch_unresolved" }); expect(h.effects()).toEqual([]);
  }
  for (const fault of ["lost", "false", "throw"] as const) {
    const h = fixture(undefined, { audience: { kind: "account-wide" } }); let once = true;
    h.state.storageFault = (phase, next) => { if (once && phase === "cas" && next?.includes('"kind":"acknowledged"')) { once = false; return fault; } };
    expect(await h.provider.erasure.request(request("erasure.request", { audience: { kind: "account-wide" } })), `H07/known acceptance/${fault}`).toMatchObject({ kind: "acknowledged", journal: "unknown" });
    const calls = h.state.calls.length; h.state.storageFault = undefined;
    await h.provider.erasure.request(request("erasure.request", { audience: { kind: "account-wide" }, requestId: "another" })); expect(h.state.calls).toHaveLength(calls);
  }
  for (const corruption of ["echo", "completed-write"] as const) {
    const f = fixture();
    await f.provider.profiles.sync(request("profile.sync"));
    const [key, raw] = [...f.values.entries()][0]; const ledger = JSON.parse(raw), saved = Object.values(ledger.entries).find((e: unknown) => (e as { result?: { kind: string } }).result?.kind === "acknowledged") as { result: Record<string, unknown> };
    if (corruption === "echo") saved.result.requestId = "foreign";
    else saved.result.kind = "completed";
    f.values.set(key, JSON.stringify(ledger)); const count = f.state.calls.length;
    expect(await f.rebuild().profiles.sync(request("profile.sync")), `H07/corrupt journal ${corruption}`).toMatchObject({ kind: "unknown", reason: "record_failed" }); expect(f.state.calls).toHaveLength(count);
  }
  const release = fixture(undefined, { audience: { kind: "account-wide" } }); let failed = false;
  release.state.storageFault = (phase, next) => { if (!failed && phase === "cas" && release.state.calls.length > 0 && next?.includes('"slot":false')) { failed = true; return "false"; } };
  expect(await release.provider.erasure.request(request("erasure.request", { audience: { kind: "account-wide" } })), "H07/release known acceptance").toMatchObject({ kind: "acknowledged", journal: "unknown" });
  release.state.storageFault = undefined;
  expect(await release.rebuild().consent.read(request("consent.read", { audience: { kind: "account-wide" } })), "H07/durable release quarantine").toMatchObject({ kind: "retryable", reason: "cooling" });
  const cooling = fixture(); cooling.state.fault = () => new Response(null, { status: 429, headers: { "Retry-After": "600" } });
  cooling.state.storageFault = (phase, next) => phase === "cas" && next?.includes('"coolingUntil":600012') ? "throw" : undefined;
  const r = await cooling.provider.consent.read(request("consent.read")); expect(r).toMatchObject({ kind: "retryable", reason: "cooling" });
  expect(await cooling.provider.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "retryable", reason: "cooling" });
});
it("H08 legacy one-executor apply/observe, exact claim association, newsletter refusal", async () => {
  const h = fixture(); const r = request("profile.sync");
  const scope = { bindingId: binding.namespace, accountReference: binding.account, audienceReference: "audience:1" };
  const claim = { scope, effectId: "effect:1", idempotencyKey: r.requestId, claimToken: "token:1", generation: 1, deadlineMs: r.deadlineMs, attempt: 1, subjectReference: r.subjectReference };
  h.config.legacy = { scope, claims: new Map([[claim.effectId, { claim, request: r }]]) };
  const adapter = h.rebuild(); expect(await adapter.observe(claim, h.state.now)).toBeNull();
  expect(await adapter.admit(claim, h.state.now)).toBe("admitted"); expect(h.state.calls).toEqual([]);
  expect(await adapter.apply(claim, h.state.now)).toMatchObject({ status: "accepted", remoteReference: "owned_1" });
  const before = h.state.calls.length; expect(await adapter.observe(claim, h.state.now)).toMatchObject({ status: "accepted" });
  await adapter.apply(claim, h.state.now); expect(h.state.calls).toHaveLength(before);
  expect(await adapter.admit({ ...claim, claimToken: "forged" }, h.state.now)).toBe("refused");
  expect(await adapter.apply({ ...claim, idempotencyKey: "changed" }, h.state.now)).toMatchObject({ status: "refused", reason: "scope" });
  h.state.storageFault = phase => phase === "get" ? "throw" : undefined;
  expect(await adapter.observe(claim, h.state.now), "H08/uncertain observation is closed").toMatchObject({ status: "ambiguous" });
  expect(await adapter.apply(claim, h.state.now), "H08/host failure is closed").toMatchObject({ status: "throttled" });
  h.state.storageFault = undefined;
  for (const mode of ["throttle", "ambiguous", "unverified"] as const) {
    const f = fixture(undefined, { pending: mode === "unverified" }); f.config.legacy = h.config.legacy;
    f.state.fault = (_url, init) => mode === "throttle" ? new Response(null, { status: 429, headers: { "Retry-After": "3" } }) : mode === "ambiguous" && init.method === "PATCH" ? new Response(null, { status: 503 }) : undefined;
    expect(await f.rebuild().apply(claim, f.state.now), `H08/${mode} bridge`).toMatchObject(mode === "throttle" ? { status: "throttled", retryAfterMs: 3000 } : mode === "ambiguous" ? { status: "ambiguous" } : { status: "refused", reason: "unsupported" });
  }
  expect(Object.values(adapter.newsletter.capabilities)).toEqual(Array(9).fill(false));
  expect(await adapter.newsletter.sync({} as never)).toMatchObject({ status: "skipped" }); expect(await adapter.newsletter.reconcile!()).toMatchObject({ status: "skipped" }); expect(h.state.calls).toHaveLength(before);
});
