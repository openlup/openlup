import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import ts from "typescript";
import type { ConsentReadback, MarketingSyncProvider, NegativeFeedback, ProfileProjection, SyncAudience, SyncBinding, SyncCapabilities, SyncReceipt, SyncRequest, SyncResult } from "../../../src/communications/contracts/marketingSync.js";

type Operation = SyncRequest["operation"];
type Mutation = "profile.sync" | "erasure.request";
export type Plant = "binding" | "target" | "projection" | "consent" | "generation" | "tombstone" | "mapping" | "surface" | "scope" | "grant" | "bounce" | "case" | "receipt" | "ack-completed" | "absence-completed" | "generation-key" | "stale-replay" | "lost-admission" | "lost-record" | "expired-read" | "cooldown";
export const binding: SyncBinding = { account: "account:1", environment: "test", namespace: "namespace:1", mappingVersion: "v1" };
export const audience: SyncAudience = { kind: "audience", reference: "audience:1" };
const projection: ProfileProjection = { email: "synthetic@example.invalid", externalReference: "local:1", fields: { givenName: "Synthetic" }, properties: { segment: "example" } };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function request<O extends Operation>(operation: O, overrides: Partial<SyncRequest<O>> = {}): SyncRequest<O> {
  const payload = operation === "profile.sync" ? { projection: structuredClone(projection), consentEvidenceReference: "local-consent:1" } : operation === "erasure.request" ? { caseReference: "case:1", authorityReference: "authority:1" } : {};
  // Only the synthetic host owns this opaque subject. A production caller must validate its registry.
  return { binding, audience, subjectReference: "subject:1", requestId: operation + ":1", generation: 1, deadlineMs: 100, authorizationReference: "authorization:1", operation, payload, ...overrides } as SyncRequest<O>;
}

/** Test-only dialect. No SDK, environment, HTTP, exported host lifecycle or production adapter. */
export function synthetic(plant?: Plant, scope: SyncAudience = audience) {
  const state = {
    generation: 1, tombstone: false, now: 10, target: "owned:1", consent: "local-consent:1",
    projection: structuredClone(projection), matches: 1, owned: true, absenceVerified: true,
    mappingFails: false, admissionLost: false, recordFails: false, coolingUntil: 0, cooldownWriteFails: false,
    quarantined: false, complete: true, status: "evidence" as "evidence" | "404" | "unsupported",
    mutation: "acknowledged" as "accepted" | "acknowledged" | "unknown",
    afterAwait: () => {},
  };
  const effects: { operation: Mutation; target: string; projection?: ProfileProjection }[] = [];
  const mapping = new Map<string, string>();
  const journal = new Map<string, { semantic: string; result: SyncResult; request: SyncRequest }>();
  const receipts = new Set<SyncReceipt<Mutation>>();
  let unresolved = false;
  const capabilities: SyncCapabilities = { binding, audience: scope, operations: {
    "profile.sync": { state: "supported", evidenceReference: "synthetic:verified", maxRequestBytes: 4096, maxFeedbackItems: 10 },
    "consent.read": { state: "supported", evidenceReference: "synthetic:verified", maxRequestBytes: 4096, maxFeedbackItems: 10 },
    "erasure.request": { state: "supported", evidenceReference: "synthetic:verified", maxRequestBytes: 4096, maxFeedbackItems: 10 },
    "erasure.read": { state: "supported", evidenceReference: "synthetic:verified", maxRequestBytes: 4096, maxFeedbackItems: 10 },
  } };
  async function execute<O extends Operation>(input: SyncRequest<O>): Promise<SyncResult<O>> {
    const r: SyncRequest = structuredClone(input) as SyncRequest;
    Object.freeze(r.payload); Object.freeze(r);
    const echo = { binding: r.binding, operation: r.operation, subjectReference: r.subjectReference, requestId: r.requestId, generation: r.generation };
    const result = (value: object) => ({ ...echo, ...value }) as SyncResult<O>;
    const refuse = (reason: string) => result({ kind: "refused", reason });
    if (!r.requestId || !Number.isSafeInteger(r.generation) || r.generation < 0 || !Number.isFinite(r.deadlineMs)) return refuse("invalid_request");
    if (!equal(r.binding, binding) && plant !== "binding") return refuse("binding");
    if (r.subjectReference !== "subject:1") return refuse("identity_conflict");
    if (r.generation !== state.generation && plant !== "stale-replay") return refuse("stale");
    if (r.deadlineMs <= state.now && !(r.operation === "erasure.read" && plant === "expired-read")) return refuse("deadline");
    if (!equal(r.audience, scope)) return refuse("unsupported");
    const capability = capabilities.operations[r.operation];
    if (capability.state !== "supported") return refuse(capability.state);
    if (r.authorizationReference !== "authorization:1") return refuse("provenance");
    let original: SyncReceipt<"erasure.request"> | undefined;
    if (r.operation === "erasure.read") {
      original = r.payload.receipt;
      const saved = [...journal.values()].find(item => item.request.requestId === original?.request.requestId);
      if ((![...receipts].some(item => equal(item, original)) || !saved || !equal(saved.request, original.request) || original.operation !== "erasure.request") && plant !== "receipt") return refuse("provenance");
      if ((original.request.operation !== "erasure.request" || original.request.payload.caseReference !== "case:1") && plant !== "case") return refuse("provenance");
      if (original.request.subjectReference !== r.subjectReference || !equal(original.request.audience, r.audience) || !equal(original.request.binding, r.binding)) return refuse("provenance");
    }
    // Structured clone removes JS identity: validate serialized receipt against the private journal.
    const key = JSON.stringify([r.binding, r.operation, r.subjectReference, r.requestId, ...(plant === "generation-key" ? [r.generation] : [])]);
    const semantic = JSON.stringify([r.audience, r.payload]);
    const prior = journal.get(key);
    if (prior) return prior.semantic === semantic ? result({ ...prior.result, ...echo }) : refuse("invalid_request");
    if (unresolved && plant !== "lost-admission" && plant !== "lost-record") return result({ kind: "unknown", reason: "dispatch_unresolved" });
    if (state.quarantined || state.coolingUntil > state.now) return result({ kind: "retryable", reason: "cooling", afterSeconds: Math.max(1, Math.ceil((state.coolingUntil - state.now) / 1000)) });
    const snapshot = { target: state.target, projection: structuredClone(state.projection), consent: state.consent };
    await Promise.resolve(); state.afterAwait();
    if (r.generation !== state.generation && plant !== "generation") return refuse("stale");
    if (state.tombstone && r.operation === "profile.sync" && plant !== "tombstone") return refuse("restricted");
    if (r.operation === "profile.sync") {
      if (snapshot.target !== state.target && plant !== "target") return refuse("provenance");
      if ((!equal(snapshot.projection, state.projection) || !equal(r.payload.projection, state.projection)) && plant !== "projection") return refuse("provenance");
      if ((snapshot.consent !== state.consent || r.payload.consentEvidenceReference !== state.consent) && plant !== "consent") return refuse("provenance");
      if (!state.owned || state.matches > 1 || (!state.target && !state.absenceVerified)) return refuse("identity_conflict");
    }
    if (r.operation === "consent.read") {
      const scoped: SyncAudience = plant === "scope" ? { kind: "account-wide" } : { kind: "audience", reference: "audience:opposite" };
      const feedback = [{ kind: "unsubscribe", outcome: plant === "grant" ? "grant_permission" : "deny_permission", sourceReference: "negative:1", occurredAtMs: 1, audience: scoped }, { kind: "hard_bounce", outcome: plant === "bounce" ? "deny_permission" : "deny_delivery", sourceReference: "negative:2", occurredAtMs: 2, audience: { kind: "account-wide" } }] as unknown as NegativeFeedback[];
      const value: ConsentReadback = { audience: r.audience, observedAtMs: state.now, remoteConsent: "subscribed", feedback, coverage: state.complete ? "complete" : "partial" };
      return result({ kind: "completed", value, journal: "confirmed" });
    }
    if (r.operation === "erasure.read") {
      if (state.status === "unsupported") return refuse("unsupported");
      if (state.status === "404" && plant !== "absence-completed") return result({ kind: "acknowledged", receipt: original, journal: "confirmed" });
      return result({ kind: "completed", receipt: original, journal: "confirmed", evidence: { readRequestId: r.requestId, observedAtMs: state.now, evidenceReference: "authenticated:provider-read", assurance: "provider_erasure_confirmed" } });
    }
    const receipt = { operation: r.operation, request: r } as SyncReceipt<Mutation>;
    receipts.add(receipt);
    if (state.admissionLost) {
      unresolved = true;
      if (plant !== "lost-admission") return result({ kind: "unknown", reason: "dispatch_unresolved" });
    }
    effects.push({ operation: r.operation, target: snapshot.target || "created:1", ...(r.operation === "profile.sync" ? { projection: snapshot.projection } : {}) });
    if (r.operation === "erasure.request") state.tombstone = true;
    if (state.mappingFails || state.recordFails) {
      unresolved = true;
      if (plant !== "lost-record") state.quarantined = true;
      const failed = result({ kind: "unknown", reason: "record_failed", receipt });
      if (plant !== "lost-record") journal.set(key, { request: r, semantic, result: failed as SyncResult });
      return failed;
    }
    if (r.operation === "profile.sync" && plant !== "mapping") mapping.set(r.subjectReference, snapshot.target || "created:1");
    const outcome = result(state.mutation === "unknown" ? { kind: "unknown", reason: "acceptance_ambiguous", receipt } : { kind: plant === "ack-completed" ? "completed" : state.mutation, receipt, journal: "confirmed" });
    if (state.mutation === "unknown") unresolved = true;
    journal.set(key, { request: r, semantic, result: outcome as SyncResult });
    return outcome;
  }
  const dispatch = execute;
  const provider: MarketingSyncProvider = { capabilities, profiles: { sync: dispatch }, consent: { read: dispatch }, erasure: { request: dispatch, read: dispatch } };
  return { provider, state, effects, mapping, dispatch, surfacePlant: plant === "surface",
    cool(delayMs: number) { if (plant !== "cooldown") { state.coolingUntil = state.now + delayMs; if (state.cooldownWriteFails) state.quarantined = true; } },
  };
}
export type Harness = ReturnType<typeof synthetic>;
export type Factory = (plant?: Plant, scope?: SyncAudience) => Harness;

/** A registered row remains one case; each plant runs the same invariant baseline/fault/restored. */
export function conformanceCase(id: string, plants: readonly Plant[], scenario: (h: Harness, plant: Plant) => Promise<void>, factory: Factory) {
  it(id, async () => {
    for (const plant of plants) {
      const start = performance.now();
      await scenario(factory(), plant);
      let killed = false;
      try { await scenario(factory(plant), plant); }
      catch (error) {
        // Import/compile/setup exceptions cannot count as a killed plant.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("AssertionError");
        expect((error as Error).message).toContain(`${id}/${plant}`);
        killed = true;
      }
      expect(killed, `${id}/${plant} must fail its invariant assertion`).toBe(true);
      await scenario(factory(), plant);
      console.info(`${id}/${plant}: baseline PASS; invariant FAIL (plant killed); restored PASS; ${(performance.now() - start).toFixed(1)}ms`);
    }
  });
}

export const neutralExports = ["SyncBinding", "SyncAudience", "ProfileProjection", "SyncRequest", "NegativeFeedback", "ConsentReadback", "SyncFailure", "SyncReceipt", "SyncResult", "SyncCapabilities", "ProfileSyncPort", "ConsentReadPort", "ErasurePort", "MarketingSyncProvider"].sort();
export function publicSurface(planted = false) {
  const path = fileURLToPath(new URL("../../../src/communications/contracts/marketingSync.ts", import.meta.url));
  const source = readFileSync(path, "utf8") + (planted ? "\nexport type ProfileRead = unknown;\n" : "");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return file.statements.filter(s => ts.canHaveModifiers(s) && ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
    .map(s => (s as ts.InterfaceDeclaration).name.text).sort();
}
