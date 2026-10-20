import { afterAll, beforeAll, expect } from "vitest";
import { assertGrantEffectControls, conformanceCase } from "../helpers/marketingSyncConformance.js";
import { binding, cleanupPlants, fixture, planted, preparePlants, pushRequest, request, withdraw } from "./harness.js";

const names = ["missing-ref", "binding", "generation", "generation-key", "lost-admission", "push-completed", "unverified", "no-trigger", "suppression-clearing", "global-widening", "hide-race", "pending-withdrawal", "skip-withdrawal", "early-read", "body-import", "flow-endpoint", "import-endpoint", "suppression-endpoint", "extra-profile", "extra-payload-keys", "grant-fenced-withdrawal", "cooldown", "withdraw-as-grant", "old-grant-start", "delay-withdrawal", "withdraw-redispatch", "substituted-authority", "remote-grant", "broadened-grant", "suppression-present", "suppression-unknown", "suppression-at-effect", "rejected-job"];
beforeAll(() => preparePlants(names)); afterAll(cleanupPlants);
const row = (id: string, plants: string[], scenario: (h: ReturnType<typeof planted>, plant: string) => Promise<void>) => conformanceCase(id, plants, scenario, planted);
row("CP01", ["missing-ref", "substituted-authority", "remote-grant", "broadened-grant"], async (h, plant) => {
  if (plant === "missing-ref") {
    expect(await h.provider.consentPush.push(pushRequest({ payload: { action: "grant", consentEvidenceReference: "" } })), "CP01/missing-ref").toMatchObject({ kind: "refused", reason: "invalid_request" });
    expect(h.effects()).toEqual([]);
  } else if (plant === "substituted-authority" || plant === "broadened-grant") {
    const evidence = { ...h.localEvidence.get("grant:1")!, ...(plant === "substituted-authority" ? { subjectReference: "foreign-subject" } : { audience: { kind: "audience" as const, reference: "second-audience" } }) };
    h.localEvidence.set("foreign:1", evidence);
    expect(await h.provider.consentPush.push(pushRequest({ payload: { action: "grant", consentEvidenceReference: "foreign:1" } })), `CP01/${plant}`).toMatchObject({ kind: "refused", reason: "provenance" });
    expect(h.effects(), `CP01/${plant} zero grant effect`).toEqual([]);
  } else {
    const remote = fixture(h.factory, { audience: { kind: "account-wide" } });
    const read = await remote.provider.consent.read(request("consent.read", { audience: { kind: "account-wide" } }));
    expect(read).toMatchObject({ kind: "completed", value: { remoteConsent: "subscribed" } });
    if (read.kind === "completed") expect(read.value, "CP01/remote-grant").not.toHaveProperty("localConsent");
  }
  for (const evidence of ["provider:subscribed", "foreign:1", "grant:other-subject", "grant:other-purpose", "grant:other-audience"]) {
    const f = fixture(h.factory); expect(await f.provider.consentPush.push(pushRequest({ payload: { action: "grant", consentEvidenceReference: evidence } })), `CP01/${evidence}`).toMatchObject({ kind: "refused", reason: "provenance" }); expect(f.effects()).toEqual([]);
  }
  const grant = fixture(h.factory); expect(await grant.provider.consentPush.push(pushRequest())).toMatchObject({ kind: "acknowledged", reconcileRequired: false });
  expect(await fixture(h.factory).provider.consentPush.push(pushRequest({ audience: { kind: "account-wide" } }))).toMatchObject({ kind: "refused", reason: "invalid_request" });
  for (const action of ["grant", "withdraw"] as const) {
    const f = fixture(h.factory); f.localEvidence.get(action === "grant" ? "grant:1" : "withdraw:1")!.current = false;
    expect(await f.provider.consentPush.push(action === "grant" ? pushRequest() : withdraw()), `CP01/revoked/${action}`).toMatchObject({ kind: "refused", reason: "restricted" });
  }
});
row("CP02", ["unverified", "no-trigger", "suppression-present", "suppression-unknown", "suppression-at-effect"], async (h, plant) => {
  expect(h.provider.consentPush.capabilities.operations["consent.push"].grantEffect).toBe("account-wide");
  expect(Object.isFrozen(h.provider.consentPush.capabilities.operations["consent.push"])).toBe(true);
  await assertGrantEffectControls(() => {
    const f = fixture(h.factory); let port = f.provider.consentPush;
    return { get port() { return port; }, request: pushRequest(), effects: f.effects,
      arm: () => {
        f.config.verification!.noTrigger.accountWideGrant = false;
        // Reconstruct from host verification; the adapter's declared capabilities stay frozen.
        port = f.rebuild().consentPush;
      } };
  }, `CP02/${plant}`);
  if (plant === "unverified") {
    const f = fixture(h.factory, { pending: true });
    expect(f.provider.consentPush.capabilities.operations["consent.push"].state, "CP02/unverified").toBe("verification_pending");
    expect(await f.provider.consentPush.push(pushRequest())).toMatchObject({ kind: "refused", reason: "verification_pending" }); expect(f.state.calls).toEqual([]);
  } else if (plant === "no-trigger") {
    for (const armed of ["Added-to-list", "backfill", "consent-flow", "other-audience-profile-flow", "other-audience-segment", "other-audience-backfill"]) {
      const f = fixture(h.factory, { verification: { noTrigger: { profile: true, accountWideGrant: false, doi: true } } });
      await f.provider.consentPush.push(pushRequest()); expect(f.effects(), `CP02/no-trigger ${armed} zero grant effect`).toEqual([]);
    }
  } else {
    const f = fixture(h.factory, { verification: { suppressionSafeAtEffect: plant !== "suppression-at-effect" } });
    const m = f.state.remote.data.attributes.subscriptions.email.marketing;
    if (plant === "suppression-unknown") delete m.suppression;
    else if (plant === "suppression-present") m.suppression = [{ reason: "UNSUBSCRIBE" }];
    else f.state.fault = (_url, init) => {
      if (!init.method || init.method === "GET") {
        const clearSnapshot = structuredClone(f.state.remote);
        m.suppression = [{ reason: "USER_SUPPRESSED" }];
        return Response.json(clearSnapshot);
      }
    };
    await f.provider.consentPush.push(pushRequest());
    expect(f.effects(), `CP02/${plant} zero grant effect`).toEqual([]);
  }
  expect(await fixture(h.factory).provider.consentPush.push(pushRequest())).toMatchObject({ kind: "acknowledged" });
});
row("CP03", ["binding", "generation", "generation-key", "lost-admission", "push-completed"], async (h, plant) => {
  if (plant === "binding") {
    for (const coordinate of ["account", "environment", "namespace", "mappingVersion"] as const) expect(await h.provider.consentPush.push(pushRequest({ binding: { ...binding, [coordinate]: "foreign" } })), "CP03/binding").toMatchObject({ kind: "refused", reason: "binding" });
  } else if (plant === "generation") {
    let n = 0; h.state.afterAwait = () => { if (++n === 2) h.state.subject.generation++; };
    expect(await h.provider.consentPush.push(pushRequest()), "CP03/generation").toMatchObject({ kind: "refused", reason: "stale" });
  } else if (plant === "lost-admission") {
    let once = true; h.state.storageFault = (phase, next) => { if (once && phase === "cas" && next?.includes('"phase":"dispatched"')) { once = false; return "lost"; } };
    expect(await h.provider.consentPush.push(pushRequest()), "CP03/lost-admission").toMatchObject({ kind: "unknown", reason: "dispatch_unresolved" });
    expect(h.effects()).toEqual([]); h.state.storageFault = undefined;
    await h.rebuild().consentPush.push(pushRequest({ requestId: "new" })); expect(h.effects()).toEqual([]);
  } else {
    const original = pushRequest(); const first = await h.provider.consentPush.push(original);
    expect(first, `CP03/${plant}`).toMatchObject({ kind: "acknowledged", reconcileRequired: false });
    h.state.subject.generation = 2;
    expect(await h.provider.consentPush.push(original)).toMatchObject({ kind: "refused", reason: "stale" });
    const current = { ...original, generation: 2, deadlineMs: 200000 };
    const replay = await h.rebuild().consentPush.push(current);
    expect(h.effects(), `CP03/${plant}`).toHaveLength(1);
    expect(replay).toMatchObject({ generation: 2, receipt: { request: original } });
    for (const delta of [{ audience: { kind: "audience", reference: "changed" } }, { payload: { action: "withdraw", consentEvidenceReference: "withdraw:1" } }, { payload: { action: "grant", consentEvidenceReference: "changed" } }]) {
      expect(await h.provider.consentPush.push({ ...current, ...delta } as never)).toMatchObject({ kind: "refused", reason: "invalid_request" });
    }
  }
});
row("CP04", ["hide-race", "pending-withdrawal", "skip-withdrawal", "early-read", "withdraw-as-grant", "old-grant-start", "delay-withdrawal"], async (h, plant) => {
  if (plant === "skip-withdrawal") h.state.fault = (_url, init) => init.method === "POST" ? new Response(null, { status: 500 }) : undefined;
  const first = await h.provider.consentPush.push(pushRequest());
  expect(first.kind).toBe(plant === "skip-withdrawal" ? "unknown" : "acknowledged"); h.state.fault = undefined;
  if (plant === "withdraw-as-grant") h.localEvidence.get("grant:1")!.current = false;
  const w = await h.provider.consentPush.push(withdraw());
  expect(h.effects().map(c => c.method), `CP04/${plant} immediate withdrawal`).toEqual(["POST", "DELETE"]);
  if (plant === "hide-race") expect(w, "CP04/hide-race").toMatchObject({ kind: "acknowledged", reconcileRequired: true });
  if (plant === "pending-withdrawal") {
    expect(await h.provider.consentPush.push(pushRequest({ requestId: "grant:second" })), "CP04/pending-withdrawal").toMatchObject({ kind: "refused", reason: "restricted" });
    expect(h.effects()).toHaveLength(2);
  }
  if (plant === "early-read" || plant === "old-grant-start") {
    const reader = fixture(h.factory, { audience: { kind: "account-wide" } });
    reader.state.now = h.state.now; reader.config.storage = h.storage; reader.config.subjectMapper = h.config.subjectMapper;
    reader.state.remote.data.attributes.subscriptions.email.marketing.consent = "UNSUBSCRIBED";
    const global = reader.rebuild();
    expect(await global.consent.read(request("consent.read", { audience: { kind: "account-wide" } })), `CP04/${plant}`).toMatchObject({ kind: "completed", value: { remoteConsent: "unknown" } });
    reader.settlements.set(pushRequest().requestId, { binding, subjectReference: "subject:1", requestId: pushRequest().requestId, source: "provider-read", evidenceReference: "offline:provider-job-settled", settledAtMs: 1 });
    reader.state.remote.data.attributes.subscriptions.email.marketing.consent = plant === "old-grant-start" ? "UNSUBSCRIBED" : "SUBSCRIBED";
    expect(await global.consent.read(request("consent.read", { audience: { kind: "account-wide" }, requestId: "after-settlement" }))).toMatchObject({ kind: "completed", value: { remoteConsent: plant === "old-grant-start" ? "unsubscribed" : "subscribed" } });
    if (plant === "old-grant-start") {
      h.state.now = reader.state.now; h.state.subject.generation = 2;
      const stale = await h.provider.consentPush.push(pushRequest({ requestId: "old-grant:start" }));
      expect(h.effects(), "CP04/old-grant-start zero old grant HTTP").toHaveLength(2);
      expect(stale).toMatchObject({ kind: "refused", reason: "stale" }); return;
    }
    // HOST reconciliation issues a new request; the adapter has issued no automatic effect.
    expect(h.effects()).toHaveLength(2); h.state.now = reader.state.now;
    expect(await h.provider.consentPush.push(withdraw({ requestId: "host:reissue" }))).toMatchObject({ kind: "acknowledged" }); expect(h.effects()).toHaveLength(3);
  }
});
row("KP01", ["body-import", "flow-endpoint", "import-endpoint", "suppression-endpoint", "extra-profile", "extra-payload-keys"], async (h, plant) => {
  expect(await h.provider.consentPush.push(pushRequest())).toMatchObject({ kind: "acknowledged" });
  const call = h.effects()[0];
  expect(call.url, `KP01/${plant} exact permitted endpoint`).toBe("https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs");
  expect(Object.keys(call.body), `KP01/${plant} exact envelope keys`).toEqual(["data"]);
  expect(Object.keys(call.body.data), `KP01/${plant} exact data keys`).toEqual(["type", "attributes", "relationships"]);
  expect(call.body.data.type).toBe("profile-subscription-bulk-create-job");
  expect(Object.keys(call.body.data.attributes), `KP01/${plant} exact attribute keys`).toEqual(["profiles"]);
  expect(call.body.data.attributes.profiles, `KP01/${plant} exact singleton`).toEqual({ data: [{ type: "profile", id: "owned_1", attributes: { email: "synthetic@example.invalid", subscriptions: { email: { marketing: { consent: "SUBSCRIBED" } } } } }] });
  expect(call.body.data.relationships).toEqual({ list: { data: { type: "list", id: "LIST1" } } });
  expect(JSON.stringify(call.body)).not.toMatch(/consented_at|grant:1|sms|tracking/);
  for (const seen of h.state.calls) expect(new URL(seen.url).pathname, "KP01/no flow/import/suppression endpoint").not.toMatch(/flows|campaigns|senders|profile-import|suppression|events/);
});
row("KP02", ["suppression-clearing", "no-trigger", "global-widening"], async (h, plant) => {
  const flags = plant === "global-widening" ? { safeListRemoval: false } : plant === "no-trigger" ? { noTrigger: { profile: true, accountWideGrant: false, doi: true } } : { suppressionSafeAtEffect: false };
  const f = fixture(h.factory, { verification: flags });
  const r = await f.provider.consentPush.push(plant === "global-widening" ? withdraw() : pushRequest());
  expect(f.effects(), `KP02/${plant} zero unsafe effect`).toEqual([]); expect(r).toMatchObject({ kind: "refused", reason: "restricted" });
  const doi = fixture(undefined, { verification: { noTrigger: { profile: true, accountWideGrant: true, doi: false } } });
  expect(await doi.provider.consentPush.push(pushRequest())).toMatchObject({ kind: "refused", reason: "restricted" }); expect(doi.effects()).toEqual([]);
  for (const allPurposes of [false, true]) {
    const global = fixture(undefined, { audience: { kind: "account-wide" } }); global.localEvidence.get("withdraw:1")!.allPurposes = allPurposes;
    expect(await global.provider.consentPush.push(withdraw({ audience: { kind: "account-wide" } }))).toMatchObject(allPurposes ? { kind: "acknowledged" } : { kind: "refused", reason: "restricted" });
    if (allPurposes) { expect(global.effects()[0].url).toContain("profile-subscription-bulk-delete-jobs"); expect(global.effects()[0].body.data).not.toHaveProperty("relationships"); }
  }
});
row("KP03", ["cooldown"], async h => {
  h.state.fault = (_url, init) => init.method === "POST" ? new Response(null, { status: 429, headers: { "Retry-After": "60" } }) : undefined;
  expect(await h.provider.consentPush.push(pushRequest())).toMatchObject({ kind: "retryable", reason: "cooling" });
  h.state.fault = undefined; const calls = h.state.calls.length;
  const cooled = await h.rebuild().consentPush.push(withdraw());
  expect(cooled, "KP03/cooldown withdrawal respects account cooling").toMatchObject({ kind: "retryable", reason: "cooling", afterSeconds: 60 });
  if (cooled.kind === "retryable") expect(Number.isFinite(cooled.afterSeconds)).toBe(true);
  expect(h.state.calls, "KP03/cooldown zero withdrawal HTTP").toHaveLength(calls);

  expect(await h.rebuild().consentPush.push(pushRequest({ requestId: "fresh" })), "KP03/cooldown").toMatchObject({ kind: "retryable", reason: "cooling" }); expect(h.state.calls).toHaveLength(calls);
  const lostCooling = fixture(h.factory);
  lostCooling.state.fault = (_url, init) => init.method === "POST" ? new Response(null, { status: 429, headers: { "Retry-After": "60" } }) : undefined;
  lostCooling.state.storageFault = (phase, next) => phase === "cas" && JSON.parse(next!).coolingUntil > 0 ? "false" : undefined;
  expect(await lostCooling.provider.consentPush.push(pushRequest())).toMatchObject({ kind: "retryable", reason: "cooling", afterSeconds: 60 });
  lostCooling.state.fault = undefined; lostCooling.state.storageFault = undefined;
  const lostCalls = lostCooling.state.calls.length;
  expect(await lostCooling.rebuild().consentPush.push(withdraw()), "KP03/cooldown lost persistence retains provider cooling").toMatchObject({ kind: "retryable", reason: "cooling", afterSeconds: 60 });
  expect(lostCooling.state.calls, "KP03/cooldown lost persistence zero withdrawal HTTP").toHaveLength(lostCalls);
  const ambiguous = fixture(h.factory);
  ambiguous.state.fault = (_url, init) => init.method === "POST" ? new Response(null, { status: 500 }) : undefined;
  expect(await ambiguous.provider.consentPush.push(pushRequest())).toMatchObject({ kind: "unknown", reason: "acceptance_ambiguous" });
  ambiguous.state.fault = () => new Response(null, { status: 429, headers: { "Retry-After": "60" } });
  expect(await ambiguous.provider.consentPush.push(withdraw()), "KP03/cooldown cooling despite grant ambiguity").toMatchObject({ kind: "retryable", reason: "cooling", afterSeconds: 60 });
  ambiguous.state.fault = undefined;
  const beforeRetry = ambiguous.state.calls.length;
  const waiting = await ambiguous.rebuild().consentPush.push(withdraw());
  expect(waiting, "KP03/cooldown withdrawal stays account cooled").toMatchObject({ kind: "retryable", reason: "cooling", afterSeconds: 60 });
  if (waiting.kind === "retryable") expect(Number.isFinite(waiting.afterSeconds)).toBe(true);
  expect(ambiguous.state.calls, "KP03/cooldown no withdrawal HTTP during cooling").toHaveLength(beforeRetry);
  ambiguous.state.now += 61000;
  expect(await ambiguous.rebuild().consentPush.push(withdraw()), "KP03/cooldown host retries after provider cooling").toMatchObject({ kind: "acknowledged", reconcileRequired: true });
  expect(ambiguous.effects().map(c => c.method)).toEqual(["POST", "DELETE"]);
  for (const mode of ["date-429", "timeout", "500", "redirect", "non-json"] as const) {
    const f = fixture(); f.state.fault = (_url, init) => {
      if (init.method !== "POST") return;
      if (mode === "timeout") return new Promise<Response>(() => {});
      if (mode === "non-json") return new Response("html", { status: 200 });
      return new Response(null, { status: mode === "date-429" ? 429 : mode === "500" ? 500 : 302, headers: { "Retry-After": new Date(80000).toUTCString() } });
    };
    expect(await f.provider.consentPush.push(pushRequest())).toMatchObject(mode === "date-429" ? { kind: "retryable", reason: "cooling" } : { kind: "unknown", reason: "acceptance_ambiguous" });
    const effects = f.effects().length; f.state.fault = undefined;
    await f.rebuild().consentPush.push(pushRequest({ requestId: "new" })); expect(f.effects()).toHaveLength(effects);
  }
});
row("KP04", ["grant-fenced-withdrawal", "rejected-job", "push-completed", "hide-race", "skip-withdrawal", "pending-withdrawal", "withdraw-redispatch"], async (h, plant) => {
  for (const fault of ["acceptance_ambiguous", "dispatch_unresolved", "record_failed", "ack-record_failed", "partial-persistence", "missing-admission"] as const) {
    const f = fixture(h.factory);
    if (fault === "acceptance_ambiguous" || fault === "record_failed") f.state.fault = (_url, init) => init.method === "POST" ? new Response(null, { status: 500 }) : undefined;
    if (fault !== "acceptance_ambiguous") {
      let once = true;
      f.state.storageFault = (phase, next) => {
        const marker = (fault === "dispatch_unresolved" || fault === "missing-admission") ? '"phase":"dispatched"' : fault === "record_failed" ? '"kind":"unknown"' : '"kind":"acknowledged"';
        if (once && phase === "cas" && next?.includes(marker)) { once = false; return fault === "missing-admission" ? "throw" : fault === "partial-persistence" || fault === "dispatch_unresolved" ? "lost" : "false"; }
      };
    }
    expect(await f.provider.consentPush.push(pushRequest()), `KP04/${plant}/${fault} grant uncertainty`).toMatchObject(
      fault === "acceptance_ambiguous" ? { kind: "unknown", reason: fault } : (fault === "dispatch_unresolved" || fault === "missing-admission") ? { kind: "unknown", reason: "dispatch_unresolved" } : fault === "record_failed" ? { kind: "unknown", reason: "record_failed" } : { kind: "acknowledged", journal: "unknown" });
    f.state.fault = undefined;
    // Keep withdrawal recording broken too: its accepted wire effect must remain honest.
    if (fault === "record_failed") f.state.storageFault = (phase, next) => phase === "cas" && next?.includes('"action":"withdraw"') && next.includes('"kind":"acknowledged"') ? "false" : undefined;
    const w = withdraw();
    const result = await f.rebuild().consentPush.push(w);
    expect(result, `KP04/${plant}/${fault} withdrawal bypasses grant fence`).toMatchObject({ kind: "acknowledged", reconcileRequired: true,
      journal: fault === "acceptance_ambiguous" ? "confirmed" : "unknown" });
    expect(f.effects().map(c => c.method), `KP04/${plant}/${fault} immediate withdrawal`).toEqual((fault === "dispatch_unresolved" || fault === "missing-admission") ? ["DELETE"] : ["POST", "DELETE"]);
    f.state.storageFault = undefined;
    const count = f.effects().length;
    await f.rebuild().consentPush.push(w);
    expect(f.effects(), `KP04/${plant}/${fault} same-key withdrawal never redispatches`).toHaveLength(count);
  }
  if (plant === "rejected-job") {
    for (const status of [400, 429]) {
      const f = fixture(h.factory); f.state.fault = (_url, init) => init.method === "POST" ? new Response(null, { status, headers: { "Retry-After": "1" } }) : undefined;
      expect(await f.provider.consentPush.push(pushRequest())).toMatchObject({ kind: status === 400 ? "refused" : "retryable" });
      f.state.fault = undefined; f.state.now += 2000;
      expect(await f.provider.consentPush.push(withdraw()), `KP04/rejected-job ${status}`).toMatchObject({ kind: "acknowledged", reconcileRequired: false });
      const reader = fixture(h.factory, { audience: { kind: "account-wide" } }); reader.config.storage = f.storage; reader.state.now = f.state.now;
      expect(await reader.rebuild().consent.read(request("consent.read", { audience: { kind: "account-wide" } }))).toMatchObject({ kind: "completed", value: { remoteConsent: "subscribed" } });
    }
    return;
  }
  if (plant === "skip-withdrawal") h.state.fault = (_url, init) => init.method === "POST" ? new Response(null, { status: 500 }) : undefined;
  const g = await h.provider.consentPush.push(pushRequest());
  expect(g.kind, `KP04/${plant}`).toBe(plant === "skip-withdrawal" ? "unknown" : "acknowledged");
  h.state.fault = undefined;
  const r = await h.provider.consentPush.push(withdraw());
  expect(h.effects(), `KP04/${plant} immediate withdrawal`).toHaveLength(2);
  expect(r, `KP04/${plant}`).toMatchObject({ kind: "acknowledged", reconcileRequired: true });
  expect(await h.provider.consentPush.push(pushRequest({ requestId: "forbidden" })), `KP04/${plant}`).toMatchObject({ kind: "refused", reason: "restricted" });
  for (const global of [false, true]) {
    const f = fixture(h.factory, global ? { audience: { kind: "account-wide" } } : {});
    const scope = global ? { kind: "account-wide" as const } : f.config.audience;
    f.state.fault = (_url, init) => init.method !== "GET" ? new Response(null, { status: 503 }) : undefined;
    const original = withdraw({ audience: scope });
    expect(await f.provider.consentPush.push(original)).toMatchObject({ kind: "unknown", reason: "acceptance_ambiguous" });
    f.state.fault = undefined; const count = f.state.calls.length;
    expect(await f.rebuild().consentPush.push(original), "KP04/own unresolved withdrawal same-key replay").toMatchObject({ kind: "unknown", reason: "acceptance_ambiguous" });
    const replay = await f.rebuild().consentPush.push({ ...original, requestId: "new-withdrawal" });
    expect(f.state.calls, "KP04/withdraw-redispatch zero additional HTTP").toHaveLength(count);
    expect(replay, "KP04/own unresolved withdrawal fence").toMatchObject({ kind: "unknown", reason: "dispatch_unresolved" });
  }
  const known = fixture(); let once = true;
  known.state.storageFault = (phase, next) => { if (once && phase === "cas" && next?.includes('"kind":"acknowledged"')) { once = false; return "false"; } };
  expect(await known.provider.consentPush.push(pushRequest())).toMatchObject({ kind: "acknowledged", journal: "unknown" });
  const count = known.effects().length; known.state.storageFault = undefined;
  await known.rebuild().consentPush.push(pushRequest({ requestId: "no-redispatch" })); expect(known.effects()).toHaveLength(count);
});
