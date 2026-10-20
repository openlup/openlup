import { expect } from "vitest";
import { audience, binding, conformanceCase, neutralExports, publicSurface, request, synthetic, type Factory, type Harness, type Plant } from "./helpers/marketingSyncConformance.js";

// Reusable, provider-agnostic rows; later adapters inject their own offline factory/controls.
function suite(factory: Factory) {
  const row = (id: string, plants: Plant[], scenario: (h: Harness, plant: Plant) => Promise<void>) => conformanceCase(id, plants, scenario, factory);
  row("S01", ["binding"], async h => {
    const r = await h.provider.profiles.sync(request("profile.sync", { binding: { ...binding, account: "foreign" } }));
    expect(r, "S01/binding").toMatchObject({ kind: "refused", reason: "binding" });
    expect(h.effects).toEqual([]);
    for (const operation of ["profile.sync", "consent.read", "erasure.request", "erasure.read"] as const) {
      h.provider.capabilities.operations[operation].state = "verification_pending";
      expect(await h.dispatch(request(operation))).toMatchObject({ kind: "refused", reason: "verification_pending" });
      h.provider.capabilities.operations[operation].state = "unsupported";
      expect(await h.dispatch(request(operation))).toMatchObject({ kind: "refused", reason: "unsupported" });
    }
    const account = factory(undefined, { kind: "account-wide" });
    expect(await account.dispatch(request("profile.sync"))).toMatchObject({ kind: "refused", reason: "unsupported" });
    expect(await account.dispatch(request("profile.sync", { audience: { kind: "account-wide" } }))).toMatchObject({ kind: "acknowledged" });
  });
  row("S02", ["target", "projection", "consent"], async (h, plant) => {
    h.state.afterAwait = () => {
      if (plant === "target") h.state.target = "foreign:2";
      if (plant === "projection") h.state.projection = { ...h.state.projection, fields: { givenName: "Substituted" } };
      if (plant === "consent") h.state.consent = "provider-negative:1";
    };
    expect(await h.provider.profiles.sync(request("profile.sync")), `S02/${plant}`).toMatchObject({ kind: "refused", reason: "provenance" });
    expect(h.effects).toEqual([]);
  });
  row("S03", ["generation", "tombstone"], async (h, plant) => {
    h.state.afterAwait = () => { if (plant === "generation") h.state.generation++; else h.state.tombstone = true; };
    expect(await h.provider.profiles.sync(request("profile.sync")), `S03/${plant}`).toMatchObject({ kind: "refused", reason: plant === "generation" ? "stale" : "restricted" });
    expect(h.effects).toEqual([]);
  });
  row("S04", ["mapping"], async h => {
    h.state.target = ""; h.state.matches = 0;
    expect(await h.provider.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "acknowledged", journal: "confirmed" });
    expect(h.mapping.get("subject:1"), "S04/mapping").toBe("created:1");
    h.state.target = "created:1";
    expect(await h.provider.profiles.sync(request("profile.sync", { requestId: "update:2" }))).toMatchObject({ kind: "acknowledged" });
    expect(h.effects.map(e => e.target)).toEqual(["created:1", "created:1"]);
    for (const fault of ["duplicate", "foreign", "unchecked"] as const) {
      const f = factory(); f.state.matches = fault === "duplicate" ? 2 : 0; f.state.owned = fault !== "foreign"; f.state.target = ""; f.state.absenceVerified = fault !== "unchecked";
      expect(await f.provider.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "refused", reason: "identity_conflict" }); expect(f.effects).toEqual([]);
    }
  });
  row("S05", ["surface"], async h => {
    // The factory's plant is applied to a virtual source overlay, never the worktree.
    expect(publicSurface(h.surfacePlant), "S05/surface").toEqual(neutralExports);
    expect(Object.keys(h.provider.profiles)).toEqual(["sync"]);
    const r = request("profile.sync");
    h.state.afterAwait = () => { (r.payload.projection.fields as { givenName: string }).givenName = "Caller mutation"; };
    expect(await h.provider.profiles.sync(r)).toMatchObject({ kind: "acknowledged" });
    expect(h.effects[0].projection?.fields.givenName).toBe("Synthetic");
    expect(h.provider).not.toHaveProperty("history"); expect(h.provider).not.toHaveProperty("membership");
  });
  row("S06", ["scope"], async h => {
    const r = await h.provider.consent.read(request("consent.read"));
    expect(r.kind).toBe("completed"); if (r.kind !== "completed") return;
    expect(r.value.audience).toEqual(audience);
    expect(r.value.feedback[0].audience, "S06/scope").toEqual({ kind: "audience", reference: "audience:opposite" });
    expect(r.value.feedback[1].audience).toEqual({ kind: "account-wide" });
    expect(r.value).not.toHaveProperty("membership");
    h.state.complete = false;
    expect(await h.provider.consent.read(request("consent.read", { requestId: "partial:2" }))).toMatchObject({ value: { coverage: "partial" } });
  });
  row("S07", ["grant", "bounce"], async (h, plant) => {
    const r = await h.provider.consent.read(request("consent.read"));
    expect(r.kind).toBe("completed"); if (r.kind !== "completed") return;
    expect(r.value.remoteConsent).toBe("subscribed");
    expect(r.value.feedback[plant === "grant" ? 0 : 1].outcome, `S07/${plant}`).toBe(plant === "grant" ? "deny_permission" : "deny_delivery");
    for (const f of r.value.feedback) expect(f.sourceReference).toMatch(/^negative:/);
    expect(r.value).not.toHaveProperty("localConsent");
  });
  row("S08", ["case", "receipt"], async (h, plant) => {
    const initial = request("erasure.request", plant === "case" ? { payload: { caseReference: "case:other", authorityReference: "authority:1" } } : {});
    const r = await h.provider.erasure.request(initial);
    expect(r.kind).toBe("acknowledged"); if (r.kind !== "acknowledged") return;
    const receipt = plant === "receipt" ? { ...r.receipt, request: { ...r.receipt.request, requestId: "foreign" } } : r.receipt;
    expect(await h.provider.erasure.read(request("erasure.read", { payload: { receipt } })), `S08/${plant}`).toMatchObject({ kind: "refused", reason: "provenance" });
    expect(h.effects).toHaveLength(1);
  });
  row("S09", ["ack-completed", "absence-completed"], async (h, plant) => {
    const r = await h.provider.erasure.request(request("erasure.request"));
    expect(r.kind, `S09/${plant}`).toBe("acknowledged"); if (r.kind !== "acknowledged") return;
    h.state.status = "404";
    expect(await h.provider.erasure.read(request("erasure.read", { payload: { receipt: r.receipt } })), `S09/${plant}`).toMatchObject({ kind: "acknowledged" });
    h.state.status = "evidence";
    expect(await h.provider.erasure.read(request("erasure.read", { requestId: "status:2", payload: { receipt: r.receipt } }))).toMatchObject({ kind: "completed", evidence: { assurance: "provider_erasure_confirmed", readRequestId: "status:2" } });
    h.state.status = "unsupported";
    expect(await h.provider.erasure.read(request("erasure.read", { requestId: "status:3", payload: { receipt: r.receipt } }))).toMatchObject({ kind: "refused", reason: "unsupported" });
    for (const kind of ["accepted", "unknown"] as const) {
      const f = factory(); f.state.mutation = kind;
      expect(await f.provider.profiles.sync(request("profile.sync"))).toMatchObject(kind === "unknown" ? { kind, reason: "acceptance_ambiguous" } : { kind, journal: "confirmed" });
    }
  });
  row("S10", ["generation-key", "stale-replay", "lost-admission", "lost-record"], async (h, plant) => {
    const r = request("profile.sync");
    if (plant === "lost-admission") h.state.admissionLost = true;
    if (plant === "lost-record") h.state.recordFails = true;
    const first = await h.provider.profiles.sync(r);
    if (plant === "lost-admission" || plant === "lost-record") {
      const effectsBeforeReconciliation = plant === "lost-admission" ? 0 : 1;
      expect(h.effects.length, `S10/${plant} initial dispatch fence`).toBe(effectsBeforeReconciliation);
      expect(first, `S10/${plant} initial classification`).toMatchObject({ kind: "unknown", reason: plant === "lost-admission" ? "dispatch_unresolved" : "record_failed" });
      h.state.admissionLost = false; h.state.recordFails = false;
      const blocked = await h.provider.profiles.sync(request("profile.sync", { requestId: "different:2" }));
      expect(h.effects.length, `S10/${plant} new-key dispatch fence`).toBe(effectsBeforeReconciliation);
      expect(blocked, `S10/${plant} unresolved fence classification`).toMatchObject({ kind: "unknown", reason: "dispatch_unresolved" });
      return;
    }
    expect(first.kind).toBe("acknowledged");
    h.state.generation = 2;
    if (plant === "stale-replay") {
      expect(await h.provider.profiles.sync(r), "S10/stale-replay").toMatchObject({ kind: "refused", reason: "stale" }); return;
    }
    const replay = await h.provider.profiles.sync({ ...r, generation: 2, deadlineMs: 200 });
    expect(h.effects, "S10/generation-key").toHaveLength(1);
    expect(replay).toMatchObject({ generation: 2, receipt: { request: { generation: 1, deadlineMs: 100 } } });
    expect(await h.provider.profiles.sync({ ...r, generation: 2, payload: { ...r.payload, consentEvidenceReference: "changed" } })).toMatchObject({ kind: "refused", reason: "invalid_request" });
  });
  row("S11", ["expired-read"], async h => {
    const r = await h.provider.erasure.request(request("erasure.request"));
    expect(r.kind).toBe("acknowledged"); if (r.kind !== "acknowledged") return;
    h.state.now = 110; h.state.generation = 2;
    expect(await h.provider.erasure.read(request("erasure.read", { generation: 2, payload: { receipt: r.receipt } })), "S11/expired-read").toMatchObject({ kind: "refused", reason: "deadline" });
    const fresh = request("erasure.read", { requestId: "fresh:2", generation: 2, deadlineMs: 200, payload: { receipt: r.receipt } });
    expect(await h.provider.erasure.read(fresh)).toMatchObject({ kind: "completed", receipt: { request: { generation: 1, deadlineMs: 100 } } });
    expect(await h.provider.erasure.read({ ...fresh, authorizationReference: "expired" })).toMatchObject({ kind: "refused", reason: "provenance" });
    expect(await h.provider.profiles.sync(request("profile.sync", { generation: 2, deadlineMs: 200 }))).toMatchObject({ kind: "refused", reason: "restricted" });
    expect(h.effects).toHaveLength(1);
  });
  row("S12", ["cooldown"], async h => {
    h.state.cooldownWriteFails = true; h.cool(1501);
    expect(await h.provider.profiles.sync(request("profile.sync")), "S12/cooldown").toMatchObject({ kind: "retryable", reason: "cooling", afterSeconds: 2 });
    h.state.now = 5000;
    expect(await h.provider.erasure.request(request("erasure.request", { deadlineMs: 6000 }))).toMatchObject({ kind: "retryable", reason: "cooling" });
    expect(h.effects).toEqual([]);
    const f = factory(); f.state.mappingFails = true;
    expect(await f.provider.profiles.sync(request("profile.sync"))).toMatchObject({ kind: "unknown", reason: "record_failed" });
    expect(await f.provider.profiles.sync(request("profile.sync", { requestId: "new:2" }))).toMatchObject({ kind: "unknown", reason: "dispatch_unresolved" });
    expect(f.effects).toHaveLength(1);
  });
}
suite(synthetic);
