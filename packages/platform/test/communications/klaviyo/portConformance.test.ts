import { afterAll, beforeAll, expect } from "vitest";
import { conformanceCase, neutralExports, publicSurface } from "../helpers/marketingSyncConformance.js";
import { audience, binding, cleanupPlants, fixture, planted, preparePlants, request } from "./harness.js";
import type { SyncRequest } from "../../../src/communications/contracts/marketingSync.js";

const names = ["binding", "target", "projection", "consent", "generation", "tombstone", "mapping", "surface", "scope", "grant", "bounce", "case", "receipt", "ack-completed", "absence-completed", "generation-key", "lost-admission", "lost-record", "expired-read", "cooldown", "pacing", "read-quarantine", "read-fact", "read-generation", "record-quarantine", "host-availability"];
beforeAll(() => preparePlants(names)); afterAll(cleanupPlants);
const row = (id: string, plants: string[], scenario: (h: ReturnType<typeof planted>, plant: string) => Promise<void>) => conformanceCase(id, plants, scenario, planted);
row("S01", ["binding"], async h => {
  expect(await h.provider.profiles.sync(request("profile.sync", { binding: { ...binding, account: "foreign" } })), "S01/binding").toMatchObject({ kind: "refused", reason: "binding" });
  expect(h.effects(), "S01/binding zero effects").toEqual([]);
  const pending = planted(undefined, { pending: true });
  for (const operation of ["profile.sync", "consent.read", "erasure.request"] as const) {
    const r = request(operation);
    const result = operation === "profile.sync" ? await pending.provider.profiles.sync(r as SyncRequest<"profile.sync">) : operation === "consent.read" ? await pending.provider.consent.read(r as SyncRequest<"consent.read">) : await pending.provider.erasure.request(r as SyncRequest<"erasure.request">);
    expect(result).toMatchObject({ kind: "refused", reason: operation === "erasure.request" ? "unsupported" : "verification_pending" });
  }
  expect(pending.state.calls).toEqual([]);
});
row("S02", ["target", "projection", "consent"], async (h, plant) => {
  let r = request("profile.sync");
  if (plant === "target") {
    let n = 0; h.state.afterAwait = () => { if (++n === 2) h.state.subject.id = "foreign_2"; };
  } else if (plant === "projection") h.localEvidence.get("local-consent:1")!.projection!.fields = { givenName: "Foreign" };
  else r = { ...r, payload: { ...r.payload, consentEvidenceReference: "provider-negative:1" } };
  expect(await h.provider.profiles.sync(r), `S02/${plant}`).toMatchObject({ kind: "refused", reason: "provenance" });
  expect(h.effects()).toEqual([]);
});
row("S03", ["generation", "tombstone", "read-generation"], async (h, plant) => {
  if (plant === "read-generation") {
    h.state.storageFault = (phase, next) => { if (phase === "cas" && next?.includes('"kind":"completed"')) { h.state.subject.generation = 2; return "false"; } };
    expect(await h.provider.consent.read(request("consent.read")), "S03/read-generation").toMatchObject({ kind: "refused", reason: "stale" }); return;
  }
  let n = 0; h.state.afterAwait = () => { if (++n === 2) { if (plant === "generation") h.state.subject.generation++; else h.state.subject.erased = true; } };
  expect(await h.provider.profiles.sync(request("profile.sync")), `S03/${plant}`).toMatchObject({ kind: "refused", reason: plant === "generation" ? "stale" : "restricted" });
  expect(h.effects()).toEqual([]);
});
row("S04", ["mapping", "pacing"], async (h, plant) => {
  if (plant === "pacing") {
    const f = fixture(h.factory); f.state.subject.id = undefined;
    delete f.config.rateIntervalMs; delete f.config.timeoutMs; f.config.now = Date.now;
    f.authorizations.get("authorization:profile.sync")!.expiresAtMs = Date.now() + 3000;
    const value = await f.rebuild().profiles.sync(request("profile.sync", { deadlineMs: Date.now() + 3000 }));
    expect(value, "S04/pacing").toMatchObject({ kind: "acknowledged", journal: "confirmed" });
    expect(f.effects()).toHaveLength(1); return;
  }
  h.state.subject.id = undefined;
  expect(await h.provider.profiles.sync(request("profile.sync")), "S04/mapping create positive").toMatchObject({ kind: "acknowledged", journal: "confirmed" });
  expect(Object.values(h.ledger().mappings), "S04/mapping").toEqual(["created_1"]);
  expect(await h.rebuild().profiles.sync(request("profile.sync", { requestId: "update:2" }))).toMatchObject({ kind: "acknowledged" });
  expect(h.effects().map(c => c.method)).toEqual(["POST", "PATCH"]);
});
row("S05", ["surface"], async (h, plant) => {
  expect(publicSurface(), "S05/neutral unchanged").toEqual(neutralExports);
  expect(Object.keys(await import("../../../src/communications/klaviyo/index.js"))).toEqual(["createKlaviyoMarketingAdapter"]);
  expect(h.surface, "S05/surface").toEqual(["createKlaviyoMarketingAdapter"]);
  // Factory module exports are checked directly by the source mutant's added enumerable export.
  const r = request("profile.sync"); let n = 0;
  h.state.afterAwait = () => { if (++n === 2) (r.payload.projection.fields as { givenName: string }).givenName = "Caller changed"; };
  expect(await h.provider.profiles.sync(r), "S05/snapshot").toMatchObject({ kind: "acknowledged" });
  expect(h.effects()[0].body.data.attributes.first_name).toBe("Synthetic");
  expect(h.provider).not.toHaveProperty("history"); expect(h.provider).not.toHaveProperty("membership");
});
row("S06", ["scope"], async h => {
  const m = h.state.remote.data.attributes.subscriptions.email.marketing;
  m.list_suppressions = [{ reason: "UNSUBSCRIBE", list_id: "LIST2", timestamp: "2026-01-01T00:00:00Z" }];
  m.suppression = [{ reason: "HARD_BOUNCE" }];
  const r = await h.provider.consent.read(request("consent.read"));
  expect(r.kind).toBe("completed"); if (r.kind !== "completed") return;
  expect(r.value.audience).toEqual(audience); expect(r.value.remoteConsent).toBe("unknown");
  expect(r.value.feedback[1].audience, "S06/scope").toEqual({ kind: "audience", reference: "audience:opposite" });
  expect(r.value.feedback[0].audience).toEqual({ kind: "account-wide" }); expect(r.value).not.toHaveProperty("membership");
});
row("S07", ["grant", "bounce"], async (h, plant) => {
  h.state.remote.data.attributes.subscriptions.email.marketing.suppression = [{ reason: "HARD_BOUNCE" }];
  const r = await h.provider.consent.read(request("consent.read"));
  expect(r.kind).toBe("completed"); if (r.kind !== "completed") return;
  if (plant === "grant") expect(r.value, "S07/grant").not.toHaveProperty("localConsent");
  else expect(r.value.feedback[0].outcome, "S07/bounce").toBe("deny_delivery");
  expect(r.value.feedback[0].sourceReference).toMatch(/^negative:/);
});
row("S08", ["case", "receipt"], async (_h, plant) => {
  const active = fixture(_h.factory, { audience: { kind: "account-wide" } });
  // Profile receipts and arbitrary serialized deletion receipts are refused before capability/HTTP.
  if (plant === "receipt") {
    const forged = { operation: "erasure.request", request: request("erasure.request") };
    expect(await active.provider.erasure.read(request("erasure.read", { audience: { kind: "account-wide" }, payload: { receipt: { ...forged, request: { ...forged.request, audience: { kind: "account-wide" } } } as never } })), "S08/receipt").toMatchObject({ kind: "refused", reason: "provenance" });
  } else {
    // A real account-scoped instance is created by this row's factory below.
    const r = await active.provider.erasure.request(request("erasure.request", { audience: { kind: "account-wide" }, payload: { caseReference: "case:other", authorityReference: "authority:1" } }));
    expect(r, "S08/case").toMatchObject({ kind: "refused", reason: "provenance" });
  }
});
row("S09", ["ack-completed", "absence-completed"], async (h, plant) => {
  const r = await h.provider.profiles.sync(request("profile.sync"));
  expect(r, `S09/${plant}`).toMatchObject({ kind: "acknowledged" });
  const erasure = fixture(h.factory, { audience: { kind: "account-wide" } });
  const a = await erasure.provider.erasure.request(request("erasure.request", { audience: { kind: "account-wide" } }));
  expect(a.kind).toBe("acknowledged");
  if (a.kind === "acknowledged") {
    // Read never guesses a deletion status, even from a valid original receipt.
    const forged = request("erasure.read", { audience: { kind: "account-wide" }, payload: { receipt: a.receipt } });
    expect(await erasure.provider.erasure.read(forged), `S09/${plant}`).toMatchObject({ kind: "refused", reason: "unsupported" });
  }
});
row("S10", ["generation-key", "generation", "lost-admission", "lost-record"], async (h, plant) => {
  const r = request("profile.sync");
  if (plant === "lost-record") {
    let once = true; h.state.storageFault = (phase, next) => { if (once && phase === "cas" && next?.includes('"kind":"acknowledged"')) { once = false; return "false"; } };
    expect(await h.provider.profiles.sync(r)).toMatchObject({ kind: "acknowledged", journal: "unknown" });
    h.state.storageFault = undefined;
    await h.rebuild().profiles.sync({ ...r, requestId: "new-key" });
    expect(h.effects(), "S10/lost-record").toHaveLength(1); return;
  }
  if (plant === "lost-admission") {
    let once = true; h.state.storageFault = (phase, next) => { if (once && phase === "cas" && next?.includes('"phase":"dispatched"')) { once = false; return "lost"; } };
    expect(await h.provider.profiles.sync(r), "S10/lost-admission").toMatchObject({ kind: "unknown", reason: "dispatch_unresolved" });
    expect(h.effects()).toHaveLength(0); h.state.storageFault = undefined;
    expect(await h.rebuild().profiles.sync({ ...r, requestId: "fresh" })).toMatchObject({ kind: "unknown", reason: "dispatch_unresolved" }); return;
  }
  const first = await h.provider.profiles.sync(r); expect(first.kind).toBe("acknowledged");
  h.state.subject.generation = 2;
  if (plant === "generation") { expect(await h.provider.profiles.sync(r), "S10/generation").toMatchObject({ kind: "refused", reason: "stale" }); return; }
  const replay = await h.rebuild().profiles.sync({ ...r, generation: 2, deadlineMs: 200000 });
  expect(h.effects(), "S10/generation-key").toHaveLength(1);
  expect(replay).toMatchObject({ generation: 2, receipt: { request: { generation: 1, deadlineMs: 100000 } } });
  expect(await h.provider.profiles.sync({ ...r, generation: 2, payload: { ...r.payload, consentEvidenceReference: "different" } })).toMatchObject({ kind: "refused", reason: "invalid_request" });
});
row("S11", ["generation", "expired-read"], async (h, plant) => {
  h.authorizations.get("authorization:consent.read")!.expiresAtMs = 200000;
  if (plant === "expired-read") {
    h.state.now = 110000;
    expect(await h.provider.consent.read(request("consent.read")), "S11/expired-read").toMatchObject({ kind: "refused", reason: "deadline" });
    expect(h.state.calls).toEqual([]); return;
  }
  h.state.subject.generation = 2;
  expect(await h.provider.consent.read(request("consent.read")), "S11/generation").toMatchObject({ kind: "refused", reason: "stale" });
  h.state.now = 110000;
  expect(await h.provider.consent.read(request("consent.read", { generation: 2 }))).toMatchObject({ kind: "refused", reason: "deadline" });
  h.authorizations.get("authorization:consent.read")!.expiresAtMs = 200000;
  expect(await h.provider.consent.read(request("consent.read", { generation: 2, deadlineMs: 200000, requestId: "fresh" }))).toMatchObject({ kind: "completed" });
});
row("S12", ["cooldown", "read-quarantine", "read-fact", "record-quarantine", "host-availability"], async (h, plant) => {
  if (plant === "host-availability") {
    for (const operation of ["consent.read", "profile.sync", "erasure.request"] as const) for (const outage of ["get", "cas"] as const) {
      const f = fixture(h.factory, { audience: { kind: "account-wide" } }); let committed = false;
      f.state.storageFault = (action, next) => {
        if (committed && action === outage) return "throw";
        if (!committed && action === "cas" && next?.includes(operation === "consent.read" ? '"kind":"completed"' : '"kind":"acknowledged"') && next.includes('"quarantined":false')) { committed = true; return "lost"; }
      };
      const r = request(operation, { audience: { kind: "account-wide" } });
      const result = operation === "consent.read" ? await f.provider.consent.read(r as never) : operation === "profile.sync" ? await f.provider.profiles.sync(r as never) : await f.provider.erasure.request(r as never);
      expect(result, `S12/host-availability ${operation}/${outage} fact`).toMatchObject({ kind: operation === "consent.read" ? "completed" : "acknowledged", journal: "unknown" });
      f.state.storageFault = undefined; const count = f.state.calls.length;
      await f.rebuild().consent.read(request("consent.read", { audience: { kind: "account-wide" }, requestId: "after-outage" }));
      expect(f.state.calls, `S12/host-availability ${operation}/${outage} reconstructed zero IO`).toHaveLength(count);
      // Explicit HOST repair verifies the stored release and restores availability.
      const stored = f.ledger(); stored.quarantined = false; stored.slot = false;
      f.values.set([...f.values.keys()][0], JSON.stringify(stored)); f.storage.availability.quarantined = false;
      expect(await f.rebuild().consent.read(request("consent.read", { audience: { kind: "account-wide" }, requestId: "host-repaired" }))).toMatchObject({ kind: "completed", journal: "confirmed" });
      // A host restart defaults unavailable until reconciliation, even with healthy bytes.
      f.storage.availability.quarantined = true; const repairedCount = f.state.calls.length;
      await f.rebuild().consent.read(request("consent.read", { audience: { kind: "account-wide" }, requestId: "restart" }));
      expect(f.state.calls).toHaveLength(repairedCount);
    }
    return;
  }
  if (plant === "record-quarantine") {
    for (const operation of ["consent.read", "profile.sync"] as const) for (const phase of ["record", "release"] as const) for (const fault of ["lost", "wrong", "throw"] as const) {
      const f = fixture(h.factory); let once = true, armed = false;
      f.state.storageFault = (action, next) => {
        if (once && action === "cas" && next?.includes(operation === "consent.read" ? '"kind":"completed"' : '"kind":"acknowledged"') && next.includes(phase === "record" ? '"quarantined":true' : '"quarantined":false')) {
          if (fault === "lost") { once = false; return "lost"; } armed = true;
        } else if (armed && action === "get") { armed = false; once = false; return fault === "wrong" ? "wrong" : "throw"; }
      };
      const value = operation === "consent.read" ? await f.provider.consent.read(request("consent.read")) : await f.provider.profiles.sync(request("profile.sync"));
      expect(value, `S12/record-quarantine ${operation}/${phase}/${fault} factual result`).toMatchObject({ kind: operation === "consent.read" ? "completed" : "acknowledged", journal: "unknown" });
      f.state.storageFault = undefined; const count = f.state.calls.length;
      await f.rebuild().profiles.sync(request("profile.sync", { requestId: "fresh-after-uncertainty" }));
      expect(f.state.calls, `S12/record-quarantine ${operation}/${phase}/${fault} no reconstructed effect`).toHaveLength(count);
    }
    return;
  }
  if (plant === "read-quarantine" || plant === "read-fact") {
    let once = true;
    h.state.storageFault = (phase, next) => {
      if (plant === "read-fact" && once && phase === "get" && h.state.calls.length > 0) { once = false; return "throw"; }
      if (plant === "read-quarantine" && once && phase === "cas" && next?.includes('"kind":"completed"')) { once = false; return "false"; }
    };
    expect(await h.provider.consent.read(request("consent.read")), `S12/${plant}`).toMatchObject({ kind: "completed", journal: "unknown" });
    h.state.storageFault = undefined; const count = h.state.calls.length;
    await h.rebuild().profiles.sync(request("profile.sync"));
    expect(h.state.calls, `S12/${plant} durable quarantine`).toHaveLength(count); return;
  }
  h.state.fault = () => new Response(null, { status: 429, headers: { "Retry-After": "60" } });
  expect(await h.provider.consent.read(request("consent.read"))).toMatchObject({ kind: "retryable", reason: "cooling", afterSeconds: 60 });
  h.state.fault = undefined; const calls = h.state.calls.length;
  expect(await h.rebuild().profiles.sync(request("profile.sync")), "S12/cooldown").toMatchObject({ kind: "retryable", reason: "cooling" });
  expect(h.state.calls).toHaveLength(calls);
});
