import { describe, expect, it } from "vitest";
import type { MarketingAutomationClaim, MarketingAutomationObservation, MarketingAutomationProviderPort, MarketingAutomationScope, MarketingAutomationStorePort } from "../../src/communications/contracts/marketingAutomation.js";

// Synthetic reference composition: an executable contract for substitute providers,
// not an activated worker, remote-account test or local permission writer.
const scope: MarketingAutomationScope = { bindingId: "binding:1", accountReference: "account:1", audienceReference: "audience:1" };
const claim: MarketingAutomationClaim = { scope, effectId: "effect:1", idempotencyKey: "effect:1:v1", claimToken: "claim:1", generation: 1, deadlineMs: 100, attempt: 1, subjectReference: "subject:1" };
const sameScope = (a: MarketingAutomationScope, b: MarketingAutomationScope) => a.bindingId === b.bindingId && a.accountReference === b.accountReference && a.audienceReference === b.audienceReference;

function fixture(style: "first" | "second", outcome: "accepted" | "ambiguous" | "throttled" = "accepted") {
  const calls: string[] = [];
  const observations: MarketingAutomationObservation[] = [];
  let generation = 1;
  let restricted = false;
  let trigger = true;
  const accepted = new Map<string, MarketingAutomationObservation>();
  const valid = (c: MarketingAutomationClaim, now: number) => sameScope(c.scope, scope) && c.generation === generation && c.claimToken === "claim:1" && now < c.deadlineMs;
  const store: MarketingAutomationStorePort = {
    async claim(selected, now) { calls.push("claim"); return trigger && sameScope(selected, scope) && now < claim.deadlineMs ? claim : null; },
    async isCurrent(c, now) { calls.push("current"); return valid(c, now); },
    async settle(c, observation, now) { calls.push("settle"); if (!valid(c, now) || observation.observedAtMs > now || observation.generation !== c.generation || observation.effectId !== c.effectId) return false; observations.push(observation); return true; },
    async history(selected, effectId) { calls.push("history"); return sameScope(selected, scope) ? observations.filter(o => o.effectId === effectId) : []; },
  };
  const provider: MarketingAutomationProviderPort = {
    scope,
    async admit(c, now) { calls.push("admit"); return !restricted && valid(c, now) ? "admitted" : "refused"; },
    async apply(c, now) {
      calls.push("apply");
      if (restricted || !valid(c, now)) return { effectId: c.effectId, generation: c.generation, observedAtMs: now, status: "refused", reason: "restricted" };
      const prior = accepted.get(c.idempotencyKey);
      if (prior) return prior;
      const observation: MarketingAutomationObservation = { effectId: c.effectId, generation: c.generation, observedAtMs: now, ...(outcome === "accepted" ? { status: "accepted", remoteReference: style === "first" ? "remote:1" : "alternate:1" } : { status: outcome, retryAfterMs: 20 }) };
      if (outcome === "accepted") accepted.set(c.idempotencyKey, observation);
      return observation;
    },
    async observe(c) { calls.push("observe"); return accepted.get(c.idempotencyKey) ?? null; },
  };
  async function run(c = claim, now = 10) {
    if (!await store.isCurrent(c, now) || await provider.admit(c, now) !== "admitted") return false;
    const prior = await store.history(c.scope, c.effectId);
    const last = prior.at(-1);
    if (last?.status === "accepted") return true;
    if (last && (last.status === "ambiguous" || last.status === "throttled")) {
      if (now < last.observedAtMs + last.retryAfterMs) return false;
      if (last.status === "ambiguous") {
        const observed = await provider.observe(c, now);
        return observed ? store.settle(c, observed, now) : false;
      }
    }
    return store.settle(c, await provider.apply(c, now), now);
  }
  return { calls, store, provider, run, stale: () => { generation++; }, restrict: () => { restricted = true; }, noTrigger: () => { trigger = false; } };
}
for (const style of ["first", "second"] as const) describe(`marketing substitute ${style}`, () => {
  it("acceptance has persisted observation and replay never repeats the effect", async () => {
    const h = fixture(style); expect(await h.run()).toBe(true); expect(await h.run()).toBe(true);
    expect(h.calls).toEqual(["current", "admit", "history", "apply", "settle", "current", "admit", "history"]);
    expect(await h.store.history(scope, "effect:1")).toMatchObject([{ status: "accepted", effectId: "effect:1", generation: 1 }]);
  });
  it.each(["scope", "token", "generation", "deadline", "restricted"])("refuses %s before effects", async fault => {
    const h = fixture(style);
    if (fault === "restricted") h.restrict();
    const candidate = { ...claim, ...(fault === "scope" ? { scope: { ...scope, accountReference: "other" } } : fault === "token" ? { claimToken: "stale" } : fault === "generation" ? { generation: 0 } : {}) };
    expect(await h.run(candidate, fault === "deadline" ? 100 : 10)).toBe(false);
    expect(h.calls).toEqual(fault === "restricted" ? ["current", "admit"] : ["current"]);
  });
  it("refuses stale settlement and cross-scope history", async () => {
    const h = fixture(style); const observation = await h.provider.apply(claim, 10); h.stale();
    expect(await h.store.settle(claim, observation, 10)).toBe(false);
    expect(await h.store.history({ ...scope, audienceReference: "other" }, "effect:1")).toEqual([]);
    expect(await h.store.history(scope, "effect:1")).toEqual([]);
    const fresh = fixture(style); const prior = await fresh.provider.apply(claim, 10);
    expect(await fresh.store.settle(claim, prior, 100)).toBe(false);
  });
  it.each(["ambiguous", "throttled"] as const)("%s retains evidence/backoff without blind retry", async outcome => {
    const h = fixture(style, outcome); expect(await h.run()).toBe(true); expect(await h.run(claim, 15)).toBe(false);
    expect(await h.run(claim, 40)).toBe(outcome === "throttled");
    expect(h.calls.filter(c => c === "apply")).toHaveLength(outcome === "throttled" ? 2 : 1);
    expect(h.calls.includes("observe")).toBe(outcome === "ambiguous");
    expect((await h.store.history(scope, "effect:1")).map(item => item.status)).toEqual(outcome === "throttled" ? [outcome, outcome] : [outcome]);
  });
  it("no trigger gives no work; retained observations have only opaque references", async () => {
    const h = fixture(style); h.noTrigger(); expect(await h.store.claim(scope, 10)).toBeNull(); expect(h.calls).toEqual(["claim"]);
    await h.run();
    const history = await h.store.history(scope, "effect:1");
    expect(Object.keys(history[0]).sort()).toEqual(["effectId", "generation", "observedAtMs", "remoteReference", "status"]);
    expect(h.calls).not.toContain("permission");
  });
});
