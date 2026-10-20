import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import ts from "typescript";
import type { ConsentPushPort, ConsentPushRequest, ConsentPushResult, ConsentReadback, MarketingSyncProvider, NegativeFeedback, ProfileProjection, SyncAudience, SyncBinding, SyncCapabilities, SyncReceipt, SyncRequest, SyncResult } from "../../../src/communications/contracts/marketingSync.js";

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
export function conformanceCase<P extends string, H>(id: string, plants: readonly P[], scenario: (h: H, plant: P) => Promise<void>, factory: (plant?: P) => H) {
  it(id, async () => {
    for (const plant of plants) {
      const start = performance.now();
      await scenario(factory(), plant);
      let killed = false, failedAssertion = "";
      try { await scenario(factory(plant), plant); }
      catch (error) {
        // Import/compile/setup exceptions cannot count as a killed plant.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("AssertionError");
        expect((error as Error).message).toContain(`${id}/${plant}`);
        killed = true; failedAssertion = (error as Error).message.split("\n")[0];
      }
      expect(killed, `${id}/${plant} must fail its invariant assertion`).toBe(true);
      await scenario(factory(), plant);
      console.info(`${id}/${plant}: baseline PASS; invariant FAIL (plant killed at ${failedAssertion}); restored PASS; ${(performance.now() - start).toFixed(1)}ms`);
    }
  });
}

export const neutralExports = ["ConsentPushRequest", "ConsentPushResult", "ConsentPushPort", "SyncBinding", "SyncAudience", "ProfileProjection", "SyncRequest", "NegativeFeedback", "ConsentReadback", "SyncFailure", "SyncReceipt", "SyncResult", "SyncCapabilities", "ProfileSyncPort", "ConsentReadPort", "ErasurePort", "MarketingSyncProvider"].sort();
export function publicSurface(planted = false) {
  const path = fileURLToPath(new URL("../../../src/communications/contracts/marketingSync.ts", import.meta.url));
  const source = readFileSync(path, "utf8") + (planted ? "\nexport type ProfileRead = unknown;\n" : "");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return file.statements.filter(s => ts.canHaveModifiers(s) && ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
    .map(s => (s as ts.InterfaceDeclaration).name.text).sort();
}

const authorityVariants = ["foreign:1", "provider:subscribed", "grant:other-subject", "grant:other-audience", "grant:other-purpose"] as const;
const flowVariants = ["Added-to-list", "backfill", "consent-flow", "DOI-mail", "other:profile-consent-flow", "other:segment", "other:backfill"] as const;
const suppressionVariants = ["UNSUBSCRIBE", "SPAM_REPORT", "USER_SUPPRESSED", "coverage-unknown", "appears-before-effect"] as const;
export type PushPlant = `missing-ref:${"absent" | "empty" | "blank"}` | `authority:${typeof authorityVariants[number] | "revoked-grant" | "revoked-withdraw" | "wrong-direction-grant" | "wrong-direction-withdraw" | "all-purposes"}` |
  "remote-grant" | "broaden-grant" | "second-audience" | "unverified" | `flow:${typeof flowVariants[number]}` |
  `suppression-clear:${typeof suppressionVariants[number]}` | `push-binding:${keyof SyncBinding}` |
  "push-stale" | "push-generation-key" | `lost-intent:${"same-key" | "new-key"}` | "push-completed" |
  "hide-race" | "hide-race-replay" | "early-read" | `insufficient-read:${"partial" | "unsupported"}` | `insufficient-read-no-grant:${"partial" | "unsupported"}` |
  `pending-withdrawal:${"audience" | "account-wide"}` | "skip-unknown" | "withdraw-as-grant" |
  "global-widening" | "old-grant-start" | "delay-withdrawal" | "ack-grant-settled" | "account-wide-uncertain-scan";
export function pushRequest(overrides: Partial<ConsentPushRequest> = {}): ConsentPushRequest {
  // The synthetic registry, rather than a public constructor, owns this branded reference.
  return { ...request("profile.sync"), operation: "consent.push", audience,
    payload: { action: "grant", consentEvidenceReference: "grant:1" }, ...overrides } as ConsentPushRequest;
}

/** Offline subject model with an unrelated profile entry, injectable into shared CP rows. */
export function syntheticPush(plant?: PushPlant, grantEffect: "audience" | "account-wide" = "audience") {
  const state = {
    generation: 1, now: 10, erased: false, localGranted: false, remote: "unknown" as ConsentReadback["remoteConsent"],
    authority: true, allPurposes: true, supportedGlobal: true, safeListOnly: true, identity: true,
    armed: "" as string, suppression: "" as string, suppressionCovered: true,
    earlierGrants: 0 as number | null, readCoverage: "complete" as ConsentReadback["coverage"], pendingWithdrawal: undefined as SyncAudience | undefined,
    lostIntent: false, recordFails: false, journalFails: false, coolingUntil: 0, quarantined: false,
    unrelatedUncertain: undefined as undefined | { subjectReference: string; operation: "profile.sync"; kind: "unknown"; reason: "acceptance_ambiguous" },
    mutation: "acknowledged" as "accepted" | "acknowledged" | "unknown", afterAwait: () => {},
  };
  const operations = structuredClone(synthetic().provider.capabilities.operations);
  const capabilities: ConsentPushPort["capabilities"] = { binding, audience, operations: { ...operations,
    "consent.push": { ...operations["profile.sync"], grantEffect },
  } };
  const effects: { action: "grant" | "withdraw"; audience: SyncAudience; requestId: string; evidence: string }[] = [];
  const journal = new Map<string, { semantic: string; result: ConsentPushResult }>();
  let fenced = false, race = false, fencedKey = "";
  const withdrawalFences = new Set<string>();
  const overlaps = (a: SyncAudience, b: SyncAudience) => a.kind === "account-wide" || b.kind === "account-wide" || equal(a, b);
  async function push(input: ConsentPushRequest): Promise<ConsentPushResult> {
    const r = structuredClone(input);
    Object.freeze(r.binding); Object.freeze(r.audience); Object.freeze(r.payload); Object.freeze(r);
    const echo = { binding: r.binding, operation: r.operation, subjectReference: r.subjectReference, requestId: r.requestId, generation: r.generation };
    const result = (value: object) => ({ ...echo, ...value }) as ConsentPushResult;
    const refuse = (reason: string) => result({ kind: "refused", reason });
    if (!r.requestId || !Number.isSafeInteger(r.generation) || r.generation < 0 || !Number.isFinite(r.deadlineMs) ||
      r.operation !== "consent.push" || !["grant", "withdraw"].includes(r.payload.action)) return refuse("invalid_request");
    if (!equal(r.binding, binding) && !(["account", "environment", "namespace", "mappingVersion"] as const)
      .some(coordinate => plant === `push-binding:${coordinate}` && r.binding[coordinate] !== binding[coordinate])) return refuse("binding");
    if (r.subjectReference !== "subject:1" || r.authorizationReference !== "authorization:1") return refuse("provenance");
    if (r.generation !== state.generation && !(plant === "old-grant-start" && r.payload.action === "grant")) return refuse("stale");
    if (r.deadlineMs <= state.now) return refuse("deadline");
    if (!r.payload.consentEvidenceReference?.trim() && plant !== `missing-ref:${r.payload.consentEvidenceReference === undefined ? "absent" : r.payload.consentEvidenceReference ? "blank" : "empty"}`) return refuse("invalid_request");
    if (r.payload.action === "grant" && r.audience.kind === "account-wide" && plant !== "broaden-grant") return refuse("invalid_request");
    const capability = capabilities.operations["consent.push"];
    if ((!capability || capability.state !== "supported") && !(plant === "unverified" && capability?.state === "verification_pending")) return refuse(capability?.state ?? "unsupported");
    if (r.audience.kind === "account-wide" && !state.supportedGlobal) return refuse("unsupported");
    const key = JSON.stringify([r.binding, r.operation, r.subjectReference, r.requestId, ...(plant === "push-generation-key" ? [r.generation] : [])]);
    const semantic = JSON.stringify([r.audience, r.payload]);
    const prior = journal.get(key);
    if (prior) return prior.semantic === semantic ? result({ ...prior.result, ...echo,
      ...((prior.result.kind === "accepted" || prior.result.kind === "acknowledged") ? { reconcileRequired: plant === "hide-race-replay" && race ? false : prior.result.reconcileRequired || race } : {}) }) : refuse("invalid_request");
    const blocked = r.payload.action === "withdraw" ? withdrawalFences.has(key) || (plant === "delay-withdrawal" && fenced) : fenced;
    if (blocked && !(plant === "lost-intent:same-key" && key === fencedKey) && !(plant === "lost-intent:new-key" && key !== fencedKey)) return result({ kind: "unknown", reason: "dispatch_unresolved" });
    if ((r.payload.action === "grant" && state.quarantined) || plant === "account-wide-uncertain-scan" && state.quarantined && state.unrelatedUncertain || state.coolingUntil > state.now) return result({ kind: "retryable", reason: "cooling", afterSeconds: Math.max(1, Math.ceil((state.coolingUntil - state.now) / 1000)) });
    const evidence = r.payload.consentEvidenceReference;
    const expected = r.payload.action === "grant" ? "grant:1" : "withdraw:1";
    if (evidence?.trim() && !["grant:1", "withdraw:1"].includes(evidence) && plant !== `authority:${evidence}`) return refuse("provenance");
    if (["grant:1", "withdraw:1"].includes(evidence) && evidence !== expected && plant !== `authority:wrong-direction-${r.payload.action}`) return refuse("restricted");
    if (r.audience.kind === "audience" && !equal(r.audience, audience) && plant !== "second-audience") return refuse("provenance");
    const authorized = () => (state.authority || plant === `authority:revoked-${r.payload.action}`) &&
      (r.audience.kind !== "account-wide" || state.allPurposes || plant === "authority:all-purposes");
    if (!authorized()) return refuse("restricted");
    const suppressionAtRead = state.suppression;
    await Promise.resolve(); state.afterAwait();
    if (r.generation !== state.generation && plant !== "push-stale" && !(plant === "old-grant-start" && r.payload.action === "grant")) return refuse("stale");
    if (r.deadlineMs <= state.now) return refuse("deadline");
    if (!authorized()) return refuse("restricted");
    if (!state.identity) return refuse("identity_conflict");
    if (r.payload.action === "grant") {
      if (state.erased) return refuse("restricted");
      if (state.pendingWithdrawal && overlaps(state.pendingWithdrawal, r.audience) && plant !== `pending-withdrawal:${state.pendingWithdrawal.kind}`) return refuse("restricted");
      const armedEffect = state.armed && (capability.grantEffect === "account-wide" || !state.armed.startsWith("other:"));
      if (armedEffect && plant !== `flow:${state.armed}`) return refuse("restricted");
      const suppressionVariant = !state.suppressionCovered ? "coverage-unknown" : !suppressionAtRead && state.suppression ? "appears-before-effect" : state.suppression;
      if ((state.suppression || !state.suppressionCovered) && plant !== `suppression-clear:${suppressionVariant}`) return refuse("restricted");
    } else {
      if (plant === "withdraw-as-grant" && !state.localGranted) return refuse("restricted");
      if (plant === "skip-unknown" && state.remote === "unknown") return refuse("restricted");
      if (plant === "delay-withdrawal" && state.earlierGrants !== 0) return result({ kind: "unknown", reason: "dispatch_unresolved" });
      if (!state.safeListOnly && r.audience.kind === "audience" && plant !== "global-widening") return refuse("restricted");
    }
    if (state.lostIntent) {
      if (r.payload.action === "grant") { fenced = true; fencedKey = key; state.earlierGrants = null; }
      else { withdrawalFences.add(key); state.pendingWithdrawal = r.audience; }
      return result({ kind: "unknown", reason: "dispatch_unresolved" });
    }
    const receipt = { operation: "consent.push", request: r } as Extract<ConsentPushResult, { kind: "accepted" | "acknowledged" }>["receipt"];
    effects.push({ action: r.payload.action, audience: plant === "global-widening" && !state.safeListOnly ? { kind: "account-wide" } : r.audience,
      requestId: r.requestId, evidence });
    // Only subject:1 + the configured audience can admit grants in this model.
    // Count our own dispatches too; replay returns from the private journal above.
    // Acceptance/acknowledgement does not settle a grant, even with confirmed recording.
    if (r.payload.action === "grant" && state.earlierGrants !== null && !(plant === "ack-grant-settled" && state.mutation === "acknowledged")) state.earlierGrants++;
    if (r.payload.action === "withdraw") {
      state.pendingWithdrawal = r.audience;
      race ||= state.earlierGrants !== 0;
    }
    const outcome = result(state.recordFails && r.payload.action === "grant" ? { kind: "unknown", reason: "record_failed", receipt } : state.mutation === "unknown" ?
      { kind: "unknown", reason: "acceptance_ambiguous", receipt } : {
        kind: plant === "push-completed" ? "completed" : state.mutation, receipt,
        journal: state.recordFails || state.journalFails || state.quarantined ? "unknown" : "confirmed", reconcileRequired: race && !(plant === "hide-race" && state.mutation === "acknowledged"),
      });
    if (state.recordFails || state.journalFails || state.mutation === "unknown") {
      if (r.payload.action === "grant") { fenced = true; fencedKey = key; state.earlierGrants = null; }
      else withdrawalFences.add(key);
    }
    if (r.payload.action === "grant" && (state.recordFails || state.journalFails)) state.quarantined = true;
    journal.set(key, { semantic, result: outcome });
    return outcome;
  }
  const port: ConsentPushPort = { capabilities, push };
  // Readback models the HOST's existing reconciliation. It has no dispatch/retry authority.
  function read(): { value: ConsentReadback; reconcileRequired: boolean } {
    if (plant === "remote-grant" && state.remote === "subscribed") state.localGranted = true;
    const ignoreCoverage = plant === `${race ? "insufficient-read" : "insufficient-read-no-grant"}:${state.readCoverage}`;
    const unresolved = (race && state.earlierGrants !== 0 && plant !== "early-read") ||
      ((race || !!state.pendingWithdrawal) && state.readCoverage !== "complete" && !ignoreCoverage);
    if (!unresolved && state.remote !== "unknown" && state.remote !== "pending") {
      race = false;
      if (state.remote === "unsubscribed") state.pendingWithdrawal = undefined;
    }
    return { value: { audience, observedAtMs: state.now, remoteConsent: unresolved ? "unknown" : state.remote, feedback: [], coverage: state.readCoverage }, reconcileRequired: unresolved || race || !!state.pendingWithdrawal };
  }
  return { port, state, effects, read };
}
export type PushHarness = ReturnType<typeof syntheticPush>;
export type PushFactory = (plant?: PushPlant, grantEffect?: "audience" | "account-wide") => PushHarness;

/** Both real and synthetic CP04/KP04 run this subject-isolation and cooling pair. */
export async function assertMultiSubjectWithdrawal(fresh: (cooling: boolean) => Promise<{
  withdraw: () => Promise<ConsentPushResult>; effects: () => readonly unknown[];
}>, label: string) {
  for (const cooling of [false, true]) {
    const h = await fresh(cooling), count = h.effects().length;
    const value = await h.withdraw();
    expect(value, `${label}/multi-subject ${cooling ? "provider cooling" : "withdrawal bypasses unrelated uncertainty"}`).toMatchObject(
      cooling ? { kind: "retryable", reason: "cooling" } : { kind: "acknowledged", reconcileRequired: true, journal: "unknown" });
    if (value.kind === "retryable") expect(Number.isFinite(value.afterSeconds) && value.afterSeconds > 0, `${label}/multi-subject finite provider cooling`).toBe(true);
    expect(h.effects().length - count, `${label}/multi-subject withdrawal effects`).toBe(cooling ? 0 : 1);
  }
}

/** Reused by real adapters, including immutable capability declarations. */
export async function assertGrantEffectControls(fresh: () => {
  port: ConsentPushPort; request: ConsentPushRequest; effects: () => readonly unknown[];
  arm: (flow: string) => void;
}, label: string) {
  for (const armed of ["safe", ...flowVariants] as const) {
    const h = fresh();
    const effect = h.port.capabilities.operations["consent.push"].grantEffect;
    expect(["audience", "account-wide"], `${label}/declared grant effect`).toContain(effect);
    if (armed !== "safe") h.arm(armed);
    const allowed = armed === "safe" || armed.startsWith("other:") && effect === "audience";
    expect(await h.port.push(h.request), `${label}/${armed}/${effect} effect-scoped admission`).toMatchObject(
      allowed ? { kind: "acknowledged", reconcileRequired: false } : { kind: "refused", reason: "restricted" });
    expect(h.effects(), `${label}/${armed}/${effect} effect-scoped dispatch`).toHaveLength(allowed ? 1 : 0);
  }
}

// Four registrations; variants and baseline/plant/restored executions stay inside each row.
// P2 injects the real adapter factory into these same rows, rather than a second synthetic dialect.
export function consentPushSuite(factory: PushFactory) {
  const row = (id: string, plants: PushPlant[], scenario: (fresh: (effect?: "audience" | "account-wide") => ReturnType<PushFactory>, label: string) => Promise<void>) =>
    conformanceCase<PushPlant, (effect?: "audience" | "account-wide") => ReturnType<PushFactory>>(id, plants, (fresh, plant) => scenario(fresh, `${id}/${plant}`), plant => effect => factory(plant, effect));
  row("CP01", ["missing-ref:absent", "missing-ref:empty", "missing-ref:blank", ...authorityVariants.map(value => `authority:${value}` as const),
    "authority:revoked-grant", "authority:revoked-withdraw", "authority:wrong-direction-grant", "authority:wrong-direction-withdraw", "authority:all-purposes", "remote-grant", "broaden-grant", "second-audience"], async (fresh, label) => {
    const valid = fresh();
    expect(await valid.port.push(pushRequest()), `${label}/local authority positive`).toMatchObject({ kind: "acknowledged" });
    expect(valid.effects, `${label}/one subject purpose audience`).toEqual([{ action: "grant", audience, requestId: "profile.sync:1", evidence: "grant:1" }]);
    for (const evidence of [undefined, "", " ", ...authorityVariants]) {
      const h = fresh();
      const r = evidence === undefined ? pushRequest() : pushRequest({ payload: { action: "grant", consentEvidenceReference: evidence } });
      if (evidence === undefined) Reflect.deleteProperty(r.payload, "consentEvidenceReference");
      const result = await h.port.push(r);
      expect(h.effects, `${label}/invalid authority zero effect: ${evidence}`).toEqual([]);
      expect(result, `${label}/authority classification: ${evidence}`).toMatchObject({ kind: "refused", reason: evidence?.trim() ? "provenance" : "invalid_request" });
    }
    for (const action of ["grant", "withdraw"] as const) {
      const h = fresh(); h.state.authority = false;
      const r = action === "grant" ? pushRequest() : pushRequest({ payload: { action: "withdraw", consentEvidenceReference: "withdraw:1" } });
      expect(await h.port.push(r), `${label}/revoked local authority`).toMatchObject({ kind: "refused", reason: "restricted" });
      expect(h.effects, `${label}/revoked zero effect`).toEqual([]);
    }
    for (const action of ["grant", "withdraw"] as const) {
      const h = fresh();
      const r = action === "grant" ? pushRequest({ payload: { action: "grant", consentEvidenceReference: "withdraw:1" } }) : pushRequest({ payload: { action: "withdraw", consentEvidenceReference: "grant:1" } });
      expect(await h.port.push(r), `${label}/genuine local evidence wrong direction ${action}`).toMatchObject({ kind: "refused", reason: "restricted" });
      expect(h.effects, `${label}/wrong-direction zero effect`).toEqual([]);
    }
    for (const action of ["grant", "withdraw"] as const) {
      const h = factory(); h.state.afterAwait = () => { h.state.authority = false; };
      const r = action === "grant" ? pushRequest() : pushRequest({ payload: { action: "withdraw", consentEvidenceReference: "withdraw:1" } });
      expect(await h.port.push(r), `${label}/post-await authority`).toMatchObject({ kind: "refused", reason: "restricted" });
      expect(h.effects, `${label}/post-await authority zero effect`).toEqual([]);
    }
    const remote = fresh(); remote.state.remote = "subscribed";
    expect(remote.read().value.remoteConsent, `${label}/remote subscribed observation`).toBe("subscribed");
    expect(remote.state.localGranted, `${label}/remote never grants locally`).toBe(false);
    const globalGrant = fresh();
    expect(await globalGrant.port.push(pushRequest({ audience: { kind: "account-wide" } })), `${label}/account-wide grant invalid`).toMatchObject({ kind: "refused", reason: "invalid_request" });
    expect(globalGrant.effects, `${label}/no broadened grant`).toEqual([]);
    const second = fresh();
    expect(await second.port.push(pushRequest({ audience: { kind: "audience", reference: "audience:2" } })), `${label}/second audience has no substituted authority`).toMatchObject({ kind: "refused", reason: "provenance" });
    for (const allPurposes of [false, true]) {
      const h = fresh(); h.state.allPurposes = allPurposes;
      expect(await h.port.push(pushRequest({ audience: { kind: "account-wide" }, payload: { action: "withdraw", consentEvidenceReference: "withdraw:1" } })), `${label}/all-purpose withdrawal ${allPurposes}`).toMatchObject(allPurposes ? { kind: "acknowledged" } : { kind: "refused", reason: "restricted" });
      expect(h.effects, `${label}/all-purpose authority effects`).toHaveLength(allPurposes ? 1 : 0);
    }
  });
  row("CP02", ["unverified", ...flowVariants.map(value => `flow:${value}` as const), ...suppressionVariants.map(value => `suppression-clear:${value}` as const)], async (fresh, label) => {
    for (const effect of ["audience", "account-wide"] as const) {
      await assertGrantEffectControls(() => {
        const h = fresh(effect);
        return { port: h.port, request: pushRequest(), effects: () => h.effects,
          arm: (flow: string) => { h.state.armed = flow; } };
      }, label);
    }
    for (const state of ["unsupported", "verification_pending", "absent"] as const) {
      const h = fresh();
      if (state === "absent") Reflect.deleteProperty(h.port.capabilities.operations, "consent.push");
      else h.port.capabilities.operations["consent.push"].state = state;
      const result = await h.port.push(pushRequest());
      expect(h.effects, `${label}/${state} zero-grant-effect`).toEqual([]);
      expect(result, `${label}/${state} capability`).toMatchObject({ kind: "refused", reason: state === "absent" ? "unsupported" : state });
    }
    for (const armed of flowVariants) {
      const h = fresh("account-wide"); h.state.armed = armed;
      const result = await h.port.push(pushRequest());
      expect(h.effects, `${label}/${armed} zero-grant-effect`).toEqual([]);
      expect(result, `${label}/${armed} no-trigger refusal`).toMatchObject({ kind: "refused", reason: "restricted" });
    }
    for (const suppression of suppressionVariants) {
      const h = fresh();
      if (suppression === "coverage-unknown") h.state.suppressionCovered = false;
      else if (suppression === "appears-before-effect") h.state.afterAwait = () => { h.state.suppression = "UNSUBSCRIBE"; };
      else h.state.suppression = suppression;
      const result = await h.port.push(pushRequest());
      expect(h.effects, `${label}/${suppression} zero-grant-effect`).toEqual([]);
      expect(result, `${label}/${suppression} restricted`).toMatchObject({ kind: "refused", reason: "restricted" });
    }
  });
  row("CP03", ["push-binding:account", "push-binding:environment", "push-binding:namespace", "push-binding:mappingVersion",
    "push-stale", "push-generation-key", "lost-intent:same-key", "lost-intent:new-key", "push-completed"], async (fresh, label) => {
    for (const coordinate of ["account", "environment", "namespace", "mappingVersion"] as const) {
      const h = fresh();
      expect(await h.port.push(pushRequest({ binding: { ...binding, [coordinate]: "foreign" } })), `${label}/${coordinate} binding refusal`).toMatchObject({ kind: "refused", reason: "binding" });
      expect(h.effects, `${label}/${coordinate} zero effect`).toEqual([]);
    }
    const stale = fresh(); stale.state.afterAwait = () => { stale.state.generation++; };
    expect(await stale.port.push(pushRequest()), `${label}/post-await stale`).toMatchObject({ kind: "refused", reason: "stale" });
    expect(stale.effects, `${label}/stale zero effect`).toEqual([]);
    const replay = fresh(); const original = pushRequest();
    const first = await replay.port.push(original);
    expect(first, `${label}/acknowledgement never completed`).toMatchObject({ kind: "acknowledged", journal: "confirmed", reconcileRequired: false });
    expect(await replay.port.push(original), `${label}/same generation replay`).toEqual(first);
    expect(replay.effects, `${label}/same generation one dispatch`).toHaveLength(1);
    replay.state.generation = 2;
    expect(await replay.port.push(original), `${label}/stale checked before replay`).toMatchObject({ kind: "refused", reason: "stale" });
    const current = { ...original, generation: 2, deadlineMs: 200 };
    const result = await replay.port.push(current);
    expect(replay.effects, `${label}/advanced-current-generation one dispatch`).toHaveLength(1);
    expect(result, `${label}/current echo original receipt and evidence`).toMatchObject({ generation: 2, receipt: { request: original } });
    for (const change of [
      { audience: { kind: "audience", reference: "changed" } as const },
      { payload: { action: "withdraw", consentEvidenceReference: "withdraw:1" } as const },
      { payload: { action: "grant", consentEvidenceReference: "changed" } as const },
    ]) {
      expect(await replay.port.push({ ...current, ...change } as ReturnType<typeof pushRequest>), `${label}/changed semantic replay ${JSON.stringify(change)}`).toMatchObject({ kind: "refused", reason: "invalid_request" });
      expect(replay.effects, `${label}/changed semantic replay zero additional effects ${JSON.stringify(change)}`).toHaveLength(1);
    }
    for (const loss of ["lostIntent", "recordFails"] as const) {
      const h = fresh(); h.state[loss] = true;
      expect(await h.port.push(pushRequest()), `${label}/${loss} unresolved intent`).toMatchObject({ kind: "unknown", reason: loss === "lostIntent" ? "dispatch_unresolved" : "record_failed" });
      const count = loss === "lostIntent" ? 0 : 1;
      expect(h.effects, `${label}/${loss} initial fence`).toHaveLength(count);
      h.state[loss] = false;
      await h.port.push(pushRequest());
      expect(await h.port.push(pushRequest({ requestId: "new-key" })), `${label}/${loss} new-key fence`).toMatchObject({ kind: "unknown", reason: "dispatch_unresolved" });
      expect(h.effects, `${label}/${loss} no redispatch`).toHaveLength(count);
    }
    for (const mutation of ["accepted", "acknowledged", "unknown"] as const) {
      const h = fresh(); h.state.mutation = mutation; h.state.journalFails = true;
      expect(await h.port.push(pushRequest()), `${label}/${mutation} journal uncertainty`).toMatchObject(mutation === "unknown" ? { kind: "unknown", reason: "acceptance_ambiguous" } : { kind: mutation, journal: "unknown", reconcileRequired: false });
    }
    const cooling = fresh(); cooling.state.coolingUntil = 1511;
    expect(await cooling.port.push(pushRequest()), `${label}/finite positive cooling`).toMatchObject({ kind: "retryable", reason: "cooling", afterSeconds: 2 });
    expect(cooling.effects, `${label}/cooling zero effect`).toEqual([]);
  });
  row("CP04", ["hide-race", "hide-race-replay", "early-read", "insufficient-read:partial", "insufficient-read:unsupported", "insufficient-read-no-grant:partial", "insufficient-read-no-grant:unsupported", "pending-withdrawal:audience", "pending-withdrawal:account-wide",
    "skip-unknown", "withdraw-as-grant", "global-widening", "old-grant-start", "delay-withdrawal", "ack-grant-settled", "account-wide-uncertain-scan"], async (fresh, label) => {
    const withdrawal = pushRequest({ requestId: "withdraw:1", payload: { action: "withdraw", consentEvidenceReference: "withdraw:1" } });
    await assertMultiSubjectWithdrawal(async cooling => {
      const h = fresh();
      h.state.unrelatedUncertain = { subjectReference: "subject:A", operation: "profile.sync", kind: "unknown", reason: "acceptance_ambiguous" };
      h.state.journalFails = true;
      expect(await h.port.push(pushRequest()), `${label}/multi-subject grant journal unknown`).toMatchObject({ kind: "acknowledged", journal: "unknown" });
      h.state.journalFails = false;
      if (cooling) h.state.coolingUntil = 6010;
      return { withdraw: () => h.port.push(withdrawal), effects: () => h.effects };
    }, label);
    // Pinned CB2-F1: grant uncertainty never queues a withdrawal behind the grant.
    for (const fault of ["acceptance_ambiguous", "record_failed", "dispatch_unresolved", "partial-persistence"] as const) {
      for (const mutation of ["accepted", "acknowledged"] as const) {
        const h = fresh();
        h.state.mutation = fault === "acceptance_ambiguous" ? "unknown" : mutation;
        h.state.recordFails = fault === "record_failed";
        h.state.lostIntent = fault === "dispatch_unresolved";
        h.state.journalFails = fault === "partial-persistence";
        expect(await h.port.push(pushRequest()), `${label}/${fault} grant uncertainty`).toMatchObject(
          fault === "partial-persistence" ? { kind: mutation, journal: "unknown" } : { kind: "unknown", reason: fault });
        h.state.mutation = mutation; h.state.lostIntent = false;
        // Leave persistence faults active: withdrawal must acknowledge honestly even then.
        const result = await h.port.push(withdrawal);
        expect(result, `${label}/${fault} withdrawal bypasses grant fence`).toMatchObject({
          kind: mutation, reconcileRequired: true, journal: fault === "record_failed" || fault === "partial-persistence" ? "unknown" : "confirmed",
        });
        const actions = fault === "dispatch_unresolved" ? ["withdraw"] : ["grant", "withdraw"];
        expect(h.effects.map(effect => effect.action), `${label}/${fault} immediate withdrawal`).toEqual(actions);
        expect(await h.port.push(withdrawal), `${label}/${fault} withdrawal replay`).toEqual(result);
        expect(h.effects.map(effect => effect.action), `${label}/${fault} no duplicate withdrawal`).toEqual(actions);
      }
    }
    for (const fault of ["lostIntent", "recordFails", "journalFails", "ambiguous"] as const) {
      const h = fresh();
      if (fault === "ambiguous") h.state.mutation = "unknown";
      else h.state[fault] = true;
      const result = await h.port.push(withdrawal);
      expect(result, `${label}/${fault} withdrawal uncertainty`).toMatchObject(
        fault === "lostIntent" ? { kind: "unknown", reason: "dispatch_unresolved" } : fault === "ambiguous" ? { kind: "unknown", reason: "acceptance_ambiguous" } : { kind: "acknowledged", journal: "unknown" });
      h.state.lostIntent = false; h.state.recordFails = false; h.state.journalFails = false; h.state.mutation = "acknowledged";
      const count = fault === "lostIntent" ? 0 : 1;
      expect(h.effects, `${label}/${fault} withdrawal dispatch count`).toHaveLength(count);
      expect(await h.port.push(withdrawal), `${label}/${fault} unresolved withdrawal same-key fence`).toEqual(result);
      expect(h.effects, `${label}/${fault} withdrawal never double dispatches`).toHaveLength(count);
      expect(await h.port.push(pushRequest({ requestId: "after-unresolved-withdrawal:grant" })), `${label}/${fault} unresolved withdrawal still blocks grants`).toMatchObject({ kind: "refused", reason: "restricted" });
      expect(h.effects, `${label}/${fault} unresolved withdrawal zero grant effect`).toHaveLength(count);
      expect(await h.port.push({ ...withdrawal, requestId: "withdraw:2" }), `${label}/${fault} new withdrawal key can dispatch`).toMatchObject({ kind: "acknowledged" });
      expect(h.effects, `${label}/${fault} new withdrawal effect`).toHaveLength(count + 1);
    }
    const cooling = fresh(); cooling.state.mutation = "unknown";
    await cooling.port.push(pushRequest());
    cooling.state.mutation = "acknowledged"; cooling.state.coolingUntil = 1511;
    const cooled = await cooling.port.push(withdrawal);
    expect(cooled, `${label}/withdrawal respects account cooling despite grant ambiguity`).toMatchObject({ kind: "retryable", reason: "cooling", afterSeconds: 2 });
    if (cooled.kind === "retryable") expect(Number.isFinite(cooled.afterSeconds), `${label}/finite withdrawal retry delay`).toBe(true);
    expect(cooling.effects.map(effect => effect.action), `${label}/account cooling zero withdrawal effect`).toEqual(["grant"]);
    cooling.state.now = 1511;
    expect(await cooling.port.push({ ...withdrawal, deadlineMs: 2000 }), `${label}/host retries withdrawal after account cooling`).toMatchObject({ kind: "acknowledged", reconcileRequired: true });
    expect(cooling.effects.map(effect => effect.action), `${label}/withdrawal after cooling`).toEqual(["grant", "withdraw"]);
    const unsettled = fresh(); unsettled.state.earlierGrants = null;
    expect(await unsettled.port.push(withdrawal), `${label}/null grant settlement starts unresolved race`).toMatchObject({ kind: "acknowledged", reconcileRequired: true });
    unsettled.state.remote = "unsubscribed";
    expect(unsettled.read(), `${label}/null grant settlement cannot confirm early read`).toMatchObject({ value: { remoteConsent: "unknown" }, reconcileRequired: true });
    unsettled.state.earlierGrants = 0;
    expect(unsettled.read(), `${label}/known settlement and fresh read close null race`).toMatchObject({ value: { remoteConsent: "unsubscribed" }, reconcileRequired: false });
    for (const mutation of ["accepted", "acknowledged"] as const) {
      const h = fresh(); h.state.mutation = mutation;
      // An earlier accepted grant is NOT assumed cancelled by the withdrawal.
      expect(await h.port.push(pushRequest()), `${label}/earlier admitted grant`).toMatchObject({ kind: mutation });
      h.state.earlierGrants = 2;
      const result = await h.port.push(withdrawal);
      expect(h.effects.map(e => e.action), `${label}/immediate withdrawal despite unknown consent and earlier grants`).toEqual(["grant", "withdraw"]);
      expect(result, `${label}/unsettled grant requires UNKNOWN reconciliation`).toMatchObject({ kind: mutation, reconcileRequired: true });
      expect(await h.port.push(withdrawal), `${label}/replay preserves unresolved race`).toMatchObject({ reconcileRequired: true });
      h.state.remote = "unsubscribed";
      expect(h.read(), `${label}/pre-settlement read cannot close race`).toMatchObject({ value: { remoteConsent: "unknown" }, reconcileRequired: true });
      h.state.earlierGrants = 1;
      expect(h.read(), `${label}/ALL earlier grants must settle`).toMatchObject({ value: { remoteConsent: "unknown" }, reconcileRequired: true });
      h.state.earlierGrants = null;
      expect(h.read(), `${label}/unknown settlement cannot close race`).toMatchObject({ value: { remoteConsent: "unknown" }, reconcileRequired: true });
      h.state.earlierGrants = 0;
      for (const coverage of ["partial", "unsupported"] as const) {
        h.state.readCoverage = coverage;
        expect(h.read(), `${label}/${coverage} insufficient readback cannot close race`).toMatchObject({ value: { remoteConsent: "unknown", coverage }, reconcileRequired: true });
      }
      h.state.readCoverage = "complete";
      for (const remote of ["pending", "unknown"] as const) {
        h.state.remote = remote;
        expect(h.read().reconcileRequired, `${label}/${remote} stays unresolved`).toBe(true);
      }
      h.state.remote = "subscribed";
      const readback = h.read();
      expect(readback.value.remoteConsent, `${label}/post-settlement read`).toBe("subscribed");
      expect(h.effects, `${label}/zero adapter retries after read`).toHaveLength(2);
      // Only this HOST scenario reissues, using the same family and a new request ID.
      if (readback.value.remoteConsent === "subscribed") await h.port.push({ ...withdrawal, requestId: "host-reconcile:2" });
      expect(h.effects.map(e => e.requestId), `${label}/HOST new requestId withdrawal`).toEqual(["profile.sync:1", "withdraw:1", "host-reconcile:2"]);
      h.state.remote = "unsubscribed";
      expect(h.read(), `${label}/settled readback closes race`).toMatchObject({ value: { remoteConsent: "unsubscribed" }, reconcileRequired: false });
    }
    for (const coverage of ["partial", "unsupported"] as const) {
      const h = fresh();
      expect(await h.port.push(withdrawal), `${label}/ordinary withdrawal accepted`).toMatchObject({ kind: "acknowledged", reconcileRequired: false });
      h.state.remote = "unsubscribed"; h.state.readCoverage = coverage;
      expect(h.read(), `${label}/no-earlier-grant ${coverage} read cannot confirm withdrawal`).toMatchObject({ value: { remoteConsent: "unknown", coverage }, reconcileRequired: true });
      const grant = pushRequest({ requestId: "after-read:grant" });
      expect(await h.port.push(grant), `${label}/insufficient confirmation keeps grant restricted`).toMatchObject({ kind: "refused", reason: "restricted" });
      expect(h.effects.map(effect => effect.action), `${label}/unconfirmed withdrawal zero-grant-effect`).toEqual(["withdraw"]);
      h.state.readCoverage = "complete";
      expect(h.read(), `${label}/sufficient ordinary withdrawal readback`).toMatchObject({ value: { remoteConsent: "unsubscribed" }, reconcileRequired: false });
      expect(await h.port.push(grant), `${label}/confirmed withdrawal permits fresh local grant`).toMatchObject({ kind: "acknowledged" });
      expect(h.effects.map(effect => effect.action), `${label}/confirmed withdrawal positive effects`).toEqual(["withdraw", "grant"]);
    }
    for (const scope of [audience, { kind: "account-wide" } as const]) {
      const h = fresh(); h.state.pendingWithdrawal = scope;
      const result = await h.port.push(pushRequest());
      expect(h.effects, `${label}/pending or unconfirmed withdrawal zero-grant-effect`).toEqual([]);
      expect(result, `${label}/pending withdrawal restricted`).toMatchObject({ kind: "refused", reason: "restricted" });
    }
    const old = fresh(); old.state.generation = 2;
    const oldResult = await old.port.push(pushRequest());
    expect(old.effects, `${label}/old grant cannot start after withdrawal generation`).toEqual([]);
    expect(oldResult, `${label}/old grant stale`).toMatchObject({ kind: "refused", reason: "stale" });
    for (const safeListOnly of [true, false]) {
      const h = fresh(); h.state.safeListOnly = safeListOnly;
      const result = await h.port.push(withdrawal);
      expect(h.effects, `${label}/list-only scope never global fallback`).toEqual(safeListOnly ? [{ action: "withdraw", audience, requestId: "withdraw:1", evidence: "withdraw:1" }] : []);
      expect(result, `${label}/safe list scope`).toMatchObject(safeListOnly ? { kind: "acknowledged", reconcileRequired: false } : { kind: "refused", reason: "restricted" });
    }
    for (const supportedGlobal of [true, false]) {
      const h = fresh(); h.state.supportedGlobal = supportedGlobal;
      expect(await h.port.push(pushRequest({ audience: { kind: "account-wide" }, payload: { action: "withdraw", consentEvidenceReference: "withdraw:1" } })), `${label}/explicit global withdrawal`).toMatchObject(supportedGlobal ? { kind: "acknowledged" } : { kind: "refused", reason: "unsupported" });
      expect(h.effects, `${label}/global support effects`).toHaveLength(supportedGlobal ? 1 : 0);
    }
    for (const mutation of ["accepted", "acknowledged"] as const) {
      for (const scope of [audience, { kind: "account-wide" } as const]) {
        const h = fresh(); h.state.mutation = mutation;
        const grant = pushRequest();
        const admitted = await h.port.push(grant);
        expect(admitted, `${label}/own grant ${mutation} with confirmed journal`).toMatchObject({ kind: mutation, journal: "confirmed" });
        expect(await h.port.push(grant), `${label}/own grant replay`).toEqual(admitted);
        expect(await h.port.push({ ...withdrawal, audience: scope }), `${label}/grant ${mutation} by this port, then withdrawal → reconcileRequired:true`).toMatchObject({ kind: mutation, reconcileRequired: true });
        expect(h.effects.map(effect => effect.action), `${label}/own grant replay never redispatches`).toEqual(["grant", "withdraw"]);
        h.state.remote = "unsubscribed";
        expect(h.read(), `${label}/own grant early read is not settlement`).toMatchObject({ value: { remoteConsent: "unknown" }, reconcileRequired: true });
        // Inject settlement evidence; only the subsequent consent read closes the race.
        h.state.earlierGrants = 0;
        expect(h.read(), `${label}/own grant settlement and fresh read close race`).toMatchObject({ value: { remoteConsent: "unsubscribed" }, reconcileRequired: false });
        expect(await h.port.push({ ...withdrawal, audience: scope, requestId: "after-settlement:withdraw" }), `${label}/settled own grant no longer conflicts`).toMatchObject({ kind: mutation, reconcileRequired: false });
      }
    }
    const identity = fresh(); identity.state.identity = false;
    expect(await identity.port.push(withdrawal), `${label}/withdrawal still requires identity`).toMatchObject({ kind: "refused", reason: "identity_conflict" });
  });
}
