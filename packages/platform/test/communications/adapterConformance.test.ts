import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runCommunicationsAdapterConformance, type CommunicationsAdapterConformanceSubject } from "../../src/communications/testing/adapterConformance.js";
import type { SyncRequest, SyncResult } from "../../src/communications/contracts/marketingSync.js";
import { request, synthetic } from "./helpers/marketingSyncConformance.js";

function marketingSubject(plant?: Parameters<typeof synthetic>[0]): CommunicationsAdapterConformanceSubject {
  const profile = request("profile.sync"), erasure = request("erasure.request");
  const echo = (input: typeof profile | typeof erasure | ReturnType<typeof request>) => ({ binding: input.binding, operation: input.operation, subjectReference: input.subjectReference, requestId: input.requestId, generation: input.generation });
  const mutation = <O extends "profile.sync" | "erasure.request">(input: SyncRequest<O>) => ({ ...echo(input), kind: "acknowledged", receipt: { operation: input.operation, request: input }, journal: "confirmed" }) as SyncResult<O>;
  const refused = request("profile.sync", { binding: { ...profile.binding, account: "other" } });
  // An unauthenticated receipt is deliberately refused, even if structurally similar.
  const read = request("erasure.read", { payload: { receipt: { operation: "erasure.request", request: erasure } as never } });
  const completedRead = { ...read, requestId: "erasure.read:complete" };
  const completedExpected = { ...echo(completedRead), kind: "completed", receipt: completedRead.payload.receipt, journal: "confirmed",
    evidence: { readRequestId: completedRead.requestId, observedAtMs: 10, evidenceReference: "authenticated:provider-read", assurance: "provider_erasure_confirmed" },
  } as SyncResult<"erasure.read">;
  const consent = request("consent.read");
  const consentExpected = { ...echo(consent), kind: "completed", journal: "confirmed", value: {
    audience: consent.audience, observedAtMs: 10, remoteConsent: "subscribed", coverage: "complete", feedback: [
      { kind: "unsubscribe", outcome: "deny_permission", sourceReference: "negative:1", occurredAtMs: 1, audience: { kind: "audience", reference: "audience:opposite" } },
      { kind: "hard_bounce", outcome: "deny_delivery", sourceReference: "negative:2", occurredAtMs: 2, audience: { kind: "account-wide" } },
    ],
  } } as SyncResult<"consent.read">;
  return { kind: "marketing-sync", subjectId: "offline-sync", async create(input) {
    const h = synthetic(plant);
    if (input.requestId === completedRead.requestId) await h.provider.erasure.request(erasure);
    return { adapter: h.provider, readEffectCount: () => h.effects.length };
  }, fixtures: [
    { input: refused, expected: { ...echo(refused), operation: "profile.sync", kind: "refused", reason: "binding" }, expectedEffects: 0 },
    { input: profile, expected: mutation(profile), expectedEffects: 1, replay: true },
    { input: consent, expected: consentExpected, expectedEffects: 0 },
    { input: erasure, expected: mutation(erasure), expectedEffects: 1, replay: true },
    { input: read, expected: { ...echo(read), operation: "erasure.read", kind: "refused", reason: "provenance" }, expectedEffects: 0 },
    { input: completedRead, expected: completedExpected, expectedEffects: 0 },
  ] };
}

it("runs the documented red-to-green Node script through the public entry", () => {
  const example = fileURLToPath(new URL("../../../../docs/platform/communications-conformance.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [example], { encoding: "utf8", timeout: 10_000 });
  expect(output).toContain("COMMUNICATIONS_CONFORMANCE:email_fixture.");
  expect(output).toContain("Corrected offline adapter PASS");
});

it("runs existing offline marketing fixtures, including refusal, negative-only feedback and replay", async () => {
  const evidence = await runCommunicationsAdapterConformance([marketingSubject()]);
  expect(evidence.subjects[0].cases).toEqual(["profile.sync:refused", "profile.sync:acknowledged:replay", "consent.read:completed", "erasure.request:acknowledged:replay", "erasure.read:refused", "erasure.read:completed"]);
  expect(JSON.stringify(evidence)).not.toContain("synthetic@example.invalid");
});

it.each([
  ["binding", "capability_scope"], ["grant", "negative_feedback"], ["bounce", "negative_feedback"], ["ack-completed", "acceptance_not_completion"],
] as const)("refuses the existing %s defect", async (plant, code) => {
  await expect(runCommunicationsAdapterConformance([marketingSubject(plant)])).rejects.toThrow(`COMMUNICATIONS_CONFORMANCE:${code}.`);
});

it("requires subjects, refusal and replay witnesses instead of accepting empty proof", async () => {
  await expect(runCommunicationsAdapterConformance([])).rejects.toThrow("subject_required");
  const subject = marketingSubject();
  if (subject.kind !== "marketing-sync") throw new Error("test fixture kind");
  await expect(runCommunicationsAdapterConformance([{ ...subject, fixtures: [] }])).rejects.toThrow("sync_fixtures");
  await expect(runCommunicationsAdapterConformance([{ ...subject, fixtures: subject.fixtures.map(row => ({ ...row, replay: false })) }])).rejects.toThrow("replay_required");
});

it.each(["unsupported", "verification_pending"] as const)("checks declared %s refusals while preserving earlier binding refusal", async state => {
  const subject = marketingSubject();
  if (subject.kind !== "marketing-sync") throw new Error("test fixture kind");
  const fixtures = subject.fixtures.map(row => ({ ...row, replay: false, expectedEffects: 0, expected: {
    binding: row.input.binding, operation: row.input.operation, subjectReference: row.input.subjectReference,
    requestId: row.input.requestId, generation: row.input.generation, kind: "refused",
    reason: row.input.binding.account === "other" ? "binding" : state,
  } })) as typeof subject.fixtures;
  const unavailable = { ...subject, fixtures, create() {
    const h = synthetic();
    for (const operation of ["profile.sync", "consent.read", "erasure.request", "erasure.read"] as const) {
      Object.assign(h.provider.capabilities.operations, { [operation]: { state } });
    }
    return { adapter: h.provider, readEffectCount: () => h.effects.length };
  } };
  expect((await runCommunicationsAdapterConformance([unavailable])).subjects[0].cases).toHaveLength(fixtures.length);
  await expect(runCommunicationsAdapterConformance([{ ...unavailable, fixtures: subject.fixtures }])).rejects.toThrow("declared_capability");
});

it("rejects external mutations during a refused request or a replay", async () => {
  const subject = marketingSubject();
  if (subject.kind !== "marketing-sync") throw new Error("test fixture kind");
  for (const fault of ["refusal", "replay"] as const) {
    const bad = { ...subject, create() {
      const h = synthetic(); let extraEffects = 0, calls = 0;
      return { adapter: { ...h.provider, profiles: { async sync(input: SyncRequest<"profile.sync">) {
        const result = await h.provider.profiles.sync(input);
        if (fault === "refusal" && result.kind === "refused" || fault === "replay" && ++calls === 2) extraEffects++;
        return result;
      } } }, readEffectCount: () => h.effects.length + extraEffects };
    } };
    await expect(runCommunicationsAdapterConformance([bad])).rejects.toThrow("effect_count");
  }
});

it("bounds findings when adapters throw or return malformed values", async () => {
  const subject = marketingSubject();
  if (subject.kind !== "marketing-sync") throw new Error("test fixture kind");
  for (const failure of [() => { throw new Error("private-provider-secret"); }, () => null]) {
    const bad = { ...subject, create() { const h = synthetic(); return { adapter: { ...h.provider, profiles: { sync: async () => failure() as never } }, readEffectCount: () => 0 }; } };
    await expect(runCommunicationsAdapterConformance([bad])).rejects.toThrow("COMMUNICATIONS_CONFORMANCE:adapter_threw.");
    try { await runCommunicationsAdapterConformance([bad]); } catch (error) { expect(String(error)).not.toContain("private-provider-secret"); }
  }
});
