import type { ConsentPushPort, ConsentPushRequest, ConsentPushResult, ConsentReadback, MarketingSyncProvider, NegativeFeedback, ProfileProjection, SyncAudience, SyncBinding, SyncRequest, SyncResult } from "../contracts/marketingSync.js";
import type { MarketingAutomationClaim, MarketingAutomationObservation, MarketingAutomationProviderPort, MarketingAutomationScope } from "../contracts/marketingAutomation.js";
import type { NewsletterSyncProviderPort } from "../contracts/newsletter.js";
import { consentCommand } from "./consentPush.js";

// Retain the cause when a grant admission CAS throws before any journal bytes
// survive. Shared host availability keeps it across adapter reconstruction;
// a fresh host process still starts quarantined for explicit reconciliation.
const grantQuarantines = new WeakMap<object, Map<string, string>>();
const providerCooling = new WeakMap<object, number>();
const REVISION = "2026-07-15";
const ORIGIN = "https://a.klaviyo.com";
type Request = SyncRequest | ConsentPushRequest;
type Result = SyncResult | ConsentPushResult;
type Operation = Request["operation"];
type Failure = Extract<Result, { kind: "refused" | "retryable" | "unknown" }>;
type Reason = Extract<Failure, { kind: "refused" }>["reason"];
type Subject = {
  binding: SyncBinding; subjectReference: string; generation: number; erased: boolean;
  id?: string; email: string; externalReference: string;
  ownedFields: readonly (keyof ProfileProjection["fields"])[]; ownedProperties: readonly string[];
};
type LocalEvidence = {
  binding: SyncBinding; subjectReference: string; audience: SyncAudience; purpose: string;
  action: "profile" | "grant" | "withdraw" | "erase"; current: boolean;
  projection?: ProfileProjection; caseReference?: string; authorityReference?: string; allPurposes?: boolean;
};
type Authorization = { binding: SyncBinding; subjectReference: string; audience: SyncAudience;
  operation: Operation; expiresAtMs: number };
type Verification = {
  binding: SyncBinding; audience: SyncAudience; evidenceReference: string; revision: string;
  operations: readonly Exclude<Operation, "erasure.read">[]; scopes: readonly string[];
  noTrigger: { profile: boolean; accountWideGrant: boolean; doi: boolean };
  safeCreate: boolean; safeListRemoval: boolean; suppressionSafeAtEffect: boolean;
  negativeSourcesComplete: boolean; listMappings: Readonly<Record<string, SyncAudience>>;
};
type Entry = { request: Request; semantic: string; target: Subject; result?: Result;
  phase: "admitted" | "dispatched" | "settled"; remoteId?: string; grantSettled?: boolean };
type Ledger = { version: 1; coolingUntil: number; nextAt: number; slot: boolean; quarantined: boolean;
  entries: Record<string, Entry>; mappings: Record<string, string>; tombstones: string[];
  withdrawals: Record<string, { owner: string; audience: SyncAudience; earlier: string[]; resolved: boolean }> };
type Storage = {
  /** Shared plain mutable record for this account/environment, independent of CAS failure.
   * Start quarantined after host restart; only explicit host reconciliation clears it.
   * Every adapter namespace/instance uses the same record. Never reset it at construction. */
  availability: { account: string; environment: string; busy: boolean; quarantined: boolean };
  /** Shared across every adapter for the account. false proves no commit; throws may have committed. */
  get(key: string): Promise<string | null>;
  compareAndSwap(key: string, expected: string | null, value: string): Promise<boolean>;
};
type Configuration = {
  binding: SyncBinding; audience: SyncAudience;
  /** Synchronous current host registry lookup; never parses an opaque subject reference. */
  subjectMapper(subjectReference: string): Subject | undefined;
  resolveCredential(): { binding: SyncBinding; key: string } | undefined;
  authorizations: ReadonlyMap<string, Authorization>; localEvidence: ReadonlyMap<string, LocalEvidence>;
  storage: Storage; verification?: Verification;
  /** Private authenticated settlement facts from the host's existing reconciliation journal. */
  grantSettlements?: ReadonlyMap<string, { binding: SyncBinding; subjectReference: string; requestId: string;
    source: "provider-read"; evidenceReference: string; settledAtMs: number }>;
  fetch?: typeof fetch; now?: () => number;
  maxRequestBytes?: number; maxResponseBytes?: number; maxFeedbackItems?: number;
  timeoutMs?: number; rateIntervalMs?: number;
  legacy?: { scope: MarketingAutomationScope; claims: ReadonlyMap<string, { claim: MarketingAutomationClaim; request: Request }> };
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512 && ![...value].some(c => c.charCodeAt(0) < 32);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(value);
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const copy = <T>(value: T): T => freeze(structuredClone(value));
const exact = (value: unknown, keys: string[]) => Object.keys(object(value)).sort().join() === [...keys].sort().join();
const validBinding = (b: unknown) => exact(b, ["account", "environment", "namespace", "mappingVersion"]) && Object.values(object(b)).every(text);
const validAudience = (a: unknown) => object(a).kind === "account-wide" ? exact(a, ["kind"]) : object(a).kind === "audience" && exact(a, ["kind", "reference"]) && text(object(a).reference);
const overlaps = (a: SyncAudience, b: SyncAudience) => a.kind === "account-wide" || b.kind === "account-wide" || equal(a, b);
const keyOf = (r: Request) => canonical([r.binding, r.operation, r.subjectReference, r.requestId]);
const subjectKey = (r: Request) => canonical([r.binding, r.subjectReference]);
const semantic = (r: Request) => canonical([r.audience, r.payload]);
const echo = (r: Pick<Request, "binding" | "operation" | "subjectReference" | "requestId" | "generation">) => ({ binding: r.binding, operation: r.operation, subjectReference: r.subjectReference, requestId: r.requestId, generation: r.generation });
function result(r: Pick<Request, "binding" | "operation" | "subjectReference" | "requestId" | "generation">, value: object): Result { return copy({ ...value, ...echo(r) }) as Result; }
const refused = (r: Request, reason: Reason) => result(r, { kind: "refused", reason });
const retry = (r: Request, reason: "cooling" | "host" | "provider", afterSeconds = 1) => result(r, { kind: "retryable", reason, afterSeconds });
const unknown = (r: Request, reason: "dispatch_unresolved" | "acceptance_ambiguous" | "record_failed", receipt?: unknown) => result(r, { kind: "unknown", reason, ...(receipt ? { receipt } : {}) });
function validRequest(r: Request, max: number): boolean {
  if (!exact(r, ["binding", "audience", "subjectReference", "requestId", "generation", "deadlineMs", "authorizationReference", "operation", "payload"]) ||
    !validBinding(r.binding) || !validAudience(r.audience) || !text(r.subjectReference) || !text(r.requestId) || !text(r.authorizationReference) ||
    !Number.isSafeInteger(r.generation) || r.generation < 0 || !Number.isFinite(r.deadlineMs) || bytes(r) > max) return false;
  const p = r.payload;
  switch (r.operation) {
    case "profile.sync": {
      const v = p as SyncRequest<"profile.sync">["payload"];
      if (!exact(p, ["projection", "consentEvidenceReference"]) || !text(v.consentEvidenceReference) || !exact(v.projection, ["email", "externalReference", "fields", "properties"])) return false;
      const q = v.projection;
      return text(q.email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.email) && text(q.externalReference) && q.fields !== null && !Array.isArray(q.fields) && typeof q.fields === "object" &&
        Object.entries(q.fields).every(([k, value]) => ["givenName", "familyName", "locale"].includes(k) && text(value)) &&
        q.properties !== null && typeof q.properties === "object" && !Array.isArray(q.properties) && Object.entries(q.properties).every(([k, value]) => text(k) &&
          (typeof value === "string" && value.length <= 512 || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)));
    }
    case "consent.read": return exact(p, []);
    case "erasure.request": return exact(p, ["caseReference", "authorityReference"]) && Object.values(p).every(text);
    case "erasure.read": return exact(p, ["receipt"]) && object(object(p).receipt).operation === "erasure.request";
    case "consent.push": return exact(p, ["action", "consentEvidenceReference"]) && text(object(p).consentEvidenceReference) &&
      (r.payload.action === "grant" && r.audience.kind === "audience" || r.payload.action === "withdraw");
    default: return false;
  }
}
function validEntry(entry: Entry): boolean {
  if (!validRequest(entry.request, Number.MAX_SAFE_INTEGER) || entry.semantic !== semantic(entry.request) ||
    !["admitted", "dispatched", "settled"].includes(entry.phase) || !equal(entry.target.binding, entry.request.binding) ||
    entry.target.subjectReference !== entry.request.subjectReference) return false;
  if (!entry.result) return entry.phase !== "settled";
  const value = entry.result;
  if (!equal(echo(value), echo(entry.request))) return false;
  const receipt = "receipt" in value ? value.receipt : undefined;
  if (receipt && (!["profile.sync", "erasure.request", "consent.push"].includes(entry.request.operation) || !equal(receipt.request, entry.request) || receipt.operation !== entry.request.operation)) return false;
  switch (value.kind) {
    case "refused": return ["invalid_request", "binding", "provenance", "stale", "deadline", "unsupported", "verification_pending", "restricted", "identity_conflict", "provider_refusal"].includes(value.reason);
    case "retryable": return ["cooling", "host", "provider"].includes(value.reason) && Number.isFinite(value.afterSeconds) && value.afterSeconds > 0;
    case "unknown": return ["dispatch_unresolved", "acceptance_ambiguous", "record_failed"].includes(value.reason);
    case "accepted": case "acknowledged": return !!receipt && ["profile.sync", "erasure.request", "consent.push"].includes(entry.request.operation) &&
      ["confirmed", "unknown"].includes(value.journal) && (entry.request.operation !== "consent.push" || "reconcileRequired" in value && typeof value.reconcileRequired === "boolean");
    case "completed": {
      if (value.operation !== "consent.read" || !["confirmed", "unknown"].includes(value.journal)) return false;
      const v = value.value;
      return equal(v.audience, entry.request.audience) && Number.isFinite(v.observedAtMs) && ["complete", "partial", "unsupported"].includes(v.coverage) &&
        ["subscribed", "unsubscribed", "pending", "never_subscribed", "unknown"].includes(v.remoteConsent) && Array.isArray(v.feedback) && v.feedback.every(f =>
          validAudience(f.audience) && text(f.sourceReference) && (f.occurredAtMs === null || Number.isFinite(f.occurredAtMs)) &&
          (["hard_bounce", "invalid_address"].includes(f.kind) ? f.outcome === "deny_delivery" : ["unsubscribe", "complaint", "manual_block"].includes(f.kind) && f.outcome === "deny_permission"));
    }
    default: return false;
  }
}
function emptyLedger(): Ledger { return { version: 1, coolingUntil: 0, nextAt: 0, slot: false, quarantined: false, entries: {}, mappings: {}, tombstones: [], withdrawals: {} }; }
function parseLedger(raw: string | null): Ledger {
  if (raw === null) return emptyLedger();
  const v = JSON.parse(raw) as Ledger;
  if (v.version !== 1 || !Number.isFinite(v.coolingUntil) || !Number.isFinite(v.nextAt) || typeof v.quarantined !== "boolean" ||
    !v.entries || Array.isArray(v.entries) || !v.mappings || !Array.isArray(v.tombstones) || !v.withdrawals || typeof v.slot !== "boolean" || !Object.values(v.entries).every(validEntry)) throw new Error("journal");
  return v;
}
function profileAttributes(p: ProfileProjection, creating: boolean) {
  const names = { givenName: "first_name", familyName: "last_name", locale: "locale" };
  return { ...(creating ? { email: p.email, external_id: p.externalReference } : {}),
    ...Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [names[k as keyof typeof names], v])), properties: p.properties };
}
function profileData(body: unknown, target: Subject, projection?: ProfileProjection): string | null {
  const d = object(object(body).data), a = object(d.attributes);
  if (d.type !== "profile" || !id(d.id) || (target.id && d.id !== target.id) || a.email !== target.email || a.external_id !== target.externalReference) return null;
  if (projection) {
    const wanted = profileAttributes(projection, false);
    for (const [k, v] of Object.entries(wanted)) {
      if (k === "properties") { for (const [name, value] of Object.entries(object(v))) if (!equal(object(a.properties)[name], value)) return null; }
      else if (!equal(a[k], v)) return null;
    }
  }
  return d.id;
}
function consentValue(body: unknown, target: Subject, audience: SyncAudience, verification: Verification, now: number, max: number): ConsentReadback | null {
  if (!profileData(body, target)) return null;
  const m = object(object(object(object(object(object(body).data).attributes).subscriptions).email).marketing);
  const states: Record<string, ConsentReadback["remoteConsent"]> = { SUBSCRIBED: "subscribed", UNSUBSCRIBED: "unsubscribed", NEVER_SUBSCRIBED: "never_subscribed", PENDING: "pending" };
  let complete = verification.negativeSourcesComplete && Array.isArray(m.suppression) && Array.isArray(m.list_suppressions) && typeof m.can_receive_email_marketing === "boolean" && typeof m.consent === "string" && m.consent in states;
  const feedback: NegativeFeedback[] = [];
  const kinds = { UNSUBSCRIBE: "unsubscribe", SPAM_REPORT: "complaint", SPAM_COMPLAINT: "complaint", USER_SUPPRESSED: "manual_block", HARD_BOUNCE: "hard_bounce", INVALID_EMAIL: "invalid_address" } as const;
  function add(reason: keyof typeof kinds, timestamp: unknown, scope: SyncAudience, source: string) {
    if (feedback.length >= max) { complete = false; return; }
    const kind = kinds[reason];
    feedback.push(copy({ kind, outcome: kind === "hard_bounce" || kind === "invalid_address" ? "deny_delivery" : "deny_permission",
      sourceReference: source, occurredAtMs: typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : null, audience: scope }) as NegativeFeedback);
  }
  if (m.consent === "UNSUBSCRIBED") add("UNSUBSCRIBE", m.consent_timestamp, { kind: "account-wide" }, `negative:${target.id}:consent`);
  for (const [source, values] of [["global", m.suppression], ["list", m.list_suppressions]] as const) {
    if (!Array.isArray(values)) continue;
    // Current-state arrays are bounded by the response rail; no history, metrics discovery or pagination.
    for (const [n, value] of values.entries()) {
      const item = object(value);
      if (typeof item.reason !== "string" || !Object.hasOwn(kinds, item.reason)) { complete = false; continue; }
      const scope = source === "global" ? { kind: "account-wide" } as const : typeof item.list_id === "string" ? verification.listMappings[item.list_id] : undefined;
      if (!scope || !validAudience(scope)) { complete = false; continue; }
      add(item.reason as keyof typeof kinds, item.timestamp, scope, `negative:${target.id}:${source}:${n}`);
    }
  }
  if (m.can_receive_email_marketing === false && feedback.length === 0) complete = false;
  return copy({ audience, observedAtMs: now, remoteConsent: audience.kind === "account-wide" ? states[String(m.consent)] ?? "unknown" : "unknown",
    feedback, coverage: complete ? "complete" : "partial" });
}

/** Opt-in Node adapter; owner TEST evidence is required before any bound operation is enabled. */
export function createKlaviyoMarketingAdapter(input: Configuration): MarketingSyncProvider & MarketingAutomationProviderPort & { readonly consentPush: ConsentPushPort; readonly newsletter: NewsletterSyncProviderPort } {
  const binding = copy(input.binding), audience = copy(input.audience), now = input.now ?? Date.now;
  const maxRequestBytes = input.maxRequestBytes ?? 65536, maxResponseBytes = input.maxResponseBytes ?? 1048576;
  const maxFeedbackItems = input.maxFeedbackItems ?? 64, timeoutMs = input.timeoutMs ?? 10000, rateIntervalMs = input.rateIntervalMs ?? 100;
  if (!validBinding(binding) || !validAudience(audience) || ![maxRequestBytes, maxResponseBytes, maxFeedbackItems, timeoutMs, rateIntervalMs].every(positive)) throw new Error("Invalid adapter configuration");
  const verification = input.verification ? copy(input.verification) : undefined;
  if (verification && (!equal(verification.binding, binding) || !equal(verification.audience, audience) || verification.revision !== REVISION || !text(verification.evidenceReference))) throw new Error("Invalid verification binding");
  const operationScopes: Record<Exclude<Operation, "erasure.read">, string[]> = {
    "profile.sync": ["profiles:read", "profiles:write"], "consent.read": ["profiles:read"], "erasure.request": ["data-privacy:write"],
    "consent.push": ["profiles:read", "subscriptions:write", "lists:write"],
  };
  const capability = (operation: Exclude<Operation, "erasure.read">) => verification?.operations.includes(operation) && operationScopes[operation].every(s => verification.scopes.includes(s))
    ? { state: "supported" as const, evidenceReference: verification.evidenceReference, maxRequestBytes, maxFeedbackItems }
    : { state: "verification_pending" as const };
  const capabilities: ConsentPushPort["capabilities"] = copy({ binding, audience, operations: {
    "profile.sync": capability("profile.sync"), "consent.read": capability("consent.read"),
    "erasure.request": audience.kind === "account-wide" ? capability("erasure.request") : { state: "unsupported" },
    "erasure.read": { state: "unsupported" }, "consent.push": { ...capability("consent.push"), grantEffect: "account-wide" },
  } });
  const accountKey = canonical(["communications-adapter", binding.account, binding.environment]);
  const availability = input.storage.availability;
  if (!availability || availability.account !== binding.account || availability.environment !== binding.environment ||
    !["busy", "quarantined"].every(k => { const d = Object.getOwnPropertyDescriptor(availability, k); return d?.writable && typeof d.value === "boolean"; })) throw new Error("Invalid account availability record");
  if (!availability.quarantined) grantQuarantines.delete(availability);
  let quarantine = false;
  let activeRequest: Request | undefined;
  const closeAccount = () => {
    quarantine = true; availability.quarantined = true;
    if (activeRequest?.operation === "consent.push" && activeRequest.payload.action === "grant") {
      const grants = grantQuarantines.get(availability) ?? new Map<string, string>();
      grants.set(keyOf(activeRequest), subjectKey(activeRequest)); grantQuarantines.set(availability, grants);
    } else grantQuarantines.delete(availability);
  };
  const load = async () => {
    let raw: string | null;
    try { raw = await input.storage.get(accountKey); } catch { closeAccount(); throw new Error("storage"); }
    try {
      const ledger = parseLedger(raw);
      ledger.coolingUntil = Math.max(ledger.coolingUntil, providerCooling.get(availability) ?? 0);
      return { raw, ledger };
    } catch { closeAccount(); throw new Error("journal"); }
  };
  async function quarantineAccount(affectedKey?: string): Promise<void> {
    closeAccount();
    // An error reply may follow a committed CAS. Write the existing quarantine bit
    // against the actual latest bytes, rather than trusting the failed writer's copy.
      try {
        const raw = await input.storage.get(accountKey), ledger = parseLedger(raw);
        ledger.quarantined = true;
        const saved = affectedKey ? ledger.entries[affectedKey]?.result : undefined;
        if (affectedKey && saved && (saved.kind === "accepted" || saved.kind === "acknowledged" || saved.kind === "completed")) ledger.entries[affectedKey].result = result(ledger.entries[affectedKey].request, { ...saved, journal: "unknown" });
        await input.storage.compareAndSwap(accountKey, raw, canonical(ledger));
      } catch { /* A retained slot/dispatch fence stays unavailable until host repair. */ }
  }
  async function persist(raw: string | null, ledger: Ledger, affectedKey?: string): Promise<"saved" | "conflict" | "uncertain"> {
    try {
      const next = canonical(ledger);
      if (!await input.storage.compareAndSwap(accountKey, raw, next)) return "conflict";
      if (await input.storage.get(accountKey) !== next) { await quarantineAccount(affectedKey); return "uncertain"; }
      return "saved";
    } catch { await quarantineAccount(affectedKey); return "uncertain"; }
  }
  // Only this subject's uncertain entries constrain its withdrawal. Known grant
  // quarantine is bypassable across subjects; unclassified host faults stay closed.
  function bypassGrantFence(r: Request, ledger: Ledger): boolean {
    if (r.operation !== "consent.push" || r.payload.action !== "withdraw") return false;
    const uncertain = Object.entries(ledger.entries).filter(([key, e]) => key !== keyOf(r) && subjectKey(e.request) === subjectKey(r)).map(([, e]) => e).filter(e => e.phase !== "settled" ||
      e.result?.kind === "unknown" || e.result && "journal" in e.result && e.result.journal === "unknown");
    const causes = grantQuarantines.get(availability);
    if ((quarantine || availability.quarantined) && !causes?.size) return false;
    return (uncertain.length > 0 || !!causes?.size) &&
      uncertain.every(e => e.request.operation === "consent.push" && e.request.payload.action === "grant");
  }
  async function releaseSlot(r?: Request): Promise<boolean> {
    try {
      const release = await load();
      if ((quarantine || availability.quarantined) && (!r || !bypassGrantFence(r, release.ledger))) return false;
      release.ledger.slot = false;
      if (await persist(release.raw, release.ledger) === "saved") return true;
    } catch { /* The durable slot stays held until host repair. */ }
    await quarantineAccount(); return false;
  }
  function current(r: Request, snapshot?: Subject): Subject | Reason {
    const s = input.subjectMapper(r.subjectReference);
    if (!s || s.subjectReference !== r.subjectReference || !equal(s.binding, binding)) return "identity_conflict";
    if (s.generation !== r.generation) return "stale";
    if (r.deadlineMs <= now()) return "deadline";
    if (s.erased && (r.operation === "profile.sync" || r.operation === "consent.push" && r.payload.action === "grant")) return "restricted";
    if (snapshot && !equal(s, snapshot)) return "provenance";
    return copy(s);
  }
  function authority(r: Request, target: Subject): Reason | undefined {
    const auth = input.authorizations.get(r.authorizationReference);
    if (!auth || !equal(auth.binding, binding) || auth.subjectReference !== r.subjectReference || !equal(auth.audience, r.audience) || auth.operation !== r.operation) return "provenance";
    if (auth.expiresAtMs <= now()) return "deadline";
    if (r.operation === "consent.read" || r.operation === "erasure.read") return;
    const ref = r.operation === "erasure.request" ? r.payload.authorityReference : r.payload.consentEvidenceReference;
    const local = input.localEvidence.get(ref);
    if (!local || !equal(local.binding, binding) || local.subjectReference !== r.subjectReference || !equal(local.audience, r.audience) || !text(local.purpose)) return "provenance";
    const action = r.operation === "profile.sync" ? "profile" : r.operation === "erasure.request" ? "erase" : r.payload.action;
    if (!local.current || local.action !== action) return "restricted";
    if (r.operation === "profile.sync") {
      if (!equal(local.projection, r.payload.projection)) return "provenance";
      if (r.payload.projection.email !== target.email || r.payload.projection.externalReference !== target.externalReference ||
        Object.keys(r.payload.projection.fields).some(k => !target.ownedFields.includes(k as keyof ProfileProjection["fields"])) ||
        Object.keys(r.payload.projection.properties).some(k => !target.ownedProperties.includes(k))) return "identity_conflict";
      if (!verification?.noTrigger.profile) return "restricted";
    }
    if (r.operation === "erasure.request" && (local.caseReference !== r.payload.caseReference || local.authorityReference !== r.payload.authorityReference)) return "provenance";
    if (r.operation === "consent.push") {
      if (r.payload.action === "withdraw" && r.audience.kind === "account-wide" && !local.allPurposes) return "restricted";
      if (r.payload.action === "grant" && (!verification?.noTrigger.accountWideGrant || !verification.noTrigger.doi || !verification.suppressionSafeAtEffect)) return "restricted";
      if (r.payload.action === "withdraw" && r.audience.kind === "audience" && !verification?.safeListRemoval) return "restricted";
    }
  }
  async function http(r: Request, method: string, path: string, body: unknown, guard: () => Reason | undefined): Promise<{ status: number; body?: unknown; failure?: Result; slotHeld?: boolean }> {
    if (body !== undefined && bytes(body) > maxRequestBytes) return { status: 0, failure: refused(r, "invalid_request") };
    const mutation = method !== "GET";
    const ambiguous = () => mutation ? unknown(r, "acceptance_ambiguous", { operation: r.operation, request: r }) : retry(r, "provider");
    let loaded: Awaited<ReturnType<typeof load>>;
    try { loaded = await load(); } catch { closeAccount(); return { status: 0, failure: retry(r, "host") }; }
    let { raw, ledger } = loaded;
    // Pace the remaining HTTP steps of this operation without retrying a mutation.
    // Provider cooldown and occupied/quarantined slots still return immediately.
    const delay = ledger.nextAt - now();
    if (!quarantine && !availability.quarantined && !ledger.quarantined && !ledger.slot && ledger.coolingUntil <= now() && delay > 0 && delay < Math.min(timeoutMs, r.deadlineMs - now())) {
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      try { ({ raw, ledger } = await load()); } catch { closeAccount(); return { status: 0, failure: retry(r, "host") }; }
    }
    if ((!bypassGrantFence(r, ledger) && (quarantine || availability.quarantined || ledger.quarantined || ledger.slot)) || ledger.coolingUntil > now() || ledger.nextAt > now()) return { status: 0, failure: retry(r, "cooling", Math.max(1, Math.ceil((Math.max(ledger.coolingUntil, ledger.nextAt) - now()) / 1000))) };
    if (mutation && (r.operation === "profile.sync" || r.operation === "consent.push" && r.payload.action === "grant") && ledger.tombstones.includes(subjectKey(r))) return { status: 0, failure: refused(r, "restricted") };
    if (mutation && r.operation === "consent.push" && r.payload.action === "grant" && Object.values(ledger.withdrawals).some(w => w.owner === subjectKey(r) && !w.resolved && overlaps(w.audience, r.audience))) return { status: 0, failure: refused(r, "restricted") };
    const before = guard(); if (before) return { status: 0, failure: refused(r, before) };
    ledger.nextAt = now() + rateIntervalMs; ledger.slot = true;
    const saved = await persist(raw, ledger);
    if (saved !== "saved") return { status: 0, failure: saved === "conflict" ? retry(r, "host") : unknown(r, "dispatch_unresolved") };
    async function transfer(): Promise<{ status: number; body?: unknown; failure?: Result }> {
    const controller = new AbortController();
    const remaining = Math.min(timeoutMs, r.deadlineMs - now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, remaining); });
    try {
      if (remaining <= 0) return { status: 0, failure: refused(r, "deadline") };
      const recheck = guard(); if (recheck) return { status: 0, failure: refused(r, recheck) };
      if (availability.quarantined && !bypassGrantFence(r, ledger) || !availability.busy) return { status: 0, failure: retry(r, "cooling") };
      let credential: ReturnType<Configuration["resolveCredential"]>;
      try { credential = input.resolveCredential(); } catch { return { status: 0, failure: retry(r, "host") }; }
      if (!credential || !equal(credential.binding, binding) || !text(credential.key) || /\s/.test(credential.key)) return { status: 0, failure: refused(r, "binding") };
      const response = await Promise.race([(input.fetch ?? fetch)(ORIGIN + path, {
        method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: "manual",
        headers: { Authorization: `Klaviyo-API-Key ${credential.key}`, revision: REVISION, Accept: "application/vnd.api+json",
          ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }) },
      }), abort]);
      if (response.status === 429) {
        const value = response.headers.get("retry-after");
        const parsed = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value ? (Date.parse(value) - now()) / 1000 : NaN;
        const afterSeconds = Number.isFinite(parsed) && parsed >= 0 && Number.isFinite(now() + Math.ceil(parsed) * 1000) ? Math.max(1, Math.ceil(parsed)) : 60;
        // A lost cooldown write must never turn the withdrawal exemption into
        // permission to ignore an observed account-level provider rate limit.
        providerCooling.set(availability, Math.max(providerCooling.get(availability) ?? 0, now() + afterSeconds * 1000));
        try {
          const next = await load(); next.ledger.coolingUntil = Math.max(next.ledger.coolingUntil, now() + afterSeconds * 1000);
          if (await persist(next.raw, next.ledger) !== "saved") closeAccount();
        } catch { closeAccount(); }
        await response.body?.cancel().catch(() => {});
        return { status: 429, failure: retry(r, "cooling", afterSeconds) };
      }
      if (response.status >= 400 && response.status < 500) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 404 && !mutation) return { status: 404 };
        return { status: response.status, failure: refused(r, response.status === 409 ? "identity_conflict" : "provider_refusal") };
      }
      if (response.status >= 300) { await response.body?.cancel().catch(() => {}); return { status: response.status, failure: ambiguous() }; }
      if (response.status === 202 || response.status === 204) { await response.body?.cancel().catch(() => {}); return { status: response.status }; }
      if (!/^application\/(?:vnd\.api\+json|json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel().catch(() => {}); return { status: response.status, failure: ambiguous() }; }
      const reader = response.body?.getReader();
      if (!reader) return { status: response.status, failure: ambiguous() };
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const chunk = await Promise.race([reader.read(), abort]);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxResponseBytes) { await reader.cancel(); return { status: response.status, failure: ambiguous() }; }
        chunks.push(chunk.value);
      }
      const combined = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)) };
    } catch { return { status: 0, failure: ambiguous() }; }
    finally {
      clearTimeout(timeout);
      if (r.operation !== "consent.read") await releaseSlot(r);
    }
    }
    const answer = await transfer();
    return { ...answer, ...(r.operation === "consent.read" ? { slotHeld: true } : {}) };
  }
  async function execute(original: Request, ownsAvailability: boolean): Promise<Result> {
    // Snapshot validation precedes every await, credential lookup and provider call.
    let r: Request;
    try { r = copy(original); if (!validRequest(r, maxRequestBytes)) return refused(r, "invalid_request"); }
    catch { return refused(original, "invalid_request"); }
    if (!equal(r.binding, binding)) return refused(r, "binding");
    const initial = current(r); if (typeof initial === "string") return refused(r, initial);
    const key = keyOf(r), owner = subjectKey(r);
    let loaded: Awaited<ReturnType<typeof load>>;
    try { loaded = await load(); } catch (error) { closeAccount(); return error instanceof Error && error.message === "journal" ? unknown(r, "record_failed") : retry(r, "host"); }
    let { raw, ledger } = loaded;
    // Receipt provenance precedes capability refusal, including deserialized receipts.
    if (r.operation === "erasure.read") {
      const receipt = r.payload.receipt;
      if (!receipt?.request || !validRequest(receipt.request, maxRequestBytes)) return refused(r, "provenance");
      const prior = ledger.entries[keyOf(receipt.request)];
      if (receipt.operation !== "erasure.request" || !prior || !equal(prior.request, receipt.request) || prior.request.operation !== "erasure.request" ||
        !equal(prior.request.binding, r.binding) || prior.request.subjectReference !== r.subjectReference || !equal(prior.request.audience, r.audience) ||
        !prior.result || !("receipt" in prior.result) || !equal(prior.result.receipt, receipt)) return refused(r, "provenance");
    }
    const latest = current(r, initial); if (typeof latest === "string") return refused(r, latest);
    if (ledger.entries[key] && ledger.entries[key].semantic !== semantic(r)) return refused(r, "invalid_request");
    if (r.operation !== "consent.push" && !equal(r.audience, audience) || r.operation === "consent.push" && r.audience.kind === "audience" && !equal(r.audience, audience)) return refused(r, "unsupported");
    const cap = capabilities.operations[r.operation];
    if (cap.state !== "supported") return refused(r, cap.state);
    const previous = ledger.entries[key];
    if (previous) {
      if (previous.semantic !== semantic(r)) return refused(r, "invalid_request");
      if (!equal(previous.request.binding, r.binding) || previous.request.subjectReference !== r.subjectReference || previous.request.operation !== r.operation) { closeAccount(); return unknown(r, "record_failed"); }
      if (previous.result) {
        const value = { ...previous.result };
        if (r.operation === "consent.push" && (value.kind === "accepted" || value.kind === "acknowledged") && "reconcileRequired" in value) {
          value.reconcileRequired ||= Object.values(ledger.withdrawals).some(w => !w.resolved && w.owner === owner && overlaps(w.audience, r.audience) && ledger.entries[key]?.request.subjectReference === r.subjectReference);
        }
        return result(r, value);
      }
      return previous.phase === "admitted" ? result(r, { kind: "accepted", receipt: { operation: r.operation, request: previous.request }, journal: "confirmed", ...(r.operation === "consent.push" ? { reconcileRequired: true } : {}) }) : unknown(r, "dispatch_unresolved");
    }
    if (r.operation === "consent.push" && r.payload.action === "grant" && Object.values(ledger.withdrawals).some(w => !w.resolved && w.owner === owner && overlaps(w.audience, r.audience))) return refused(r, "restricted");
    const pending = Object.values(ledger.entries).filter(e => subjectKey(e.request) === owner && e.phase !== "settled");
    const withdrawing = r.operation === "consent.push" && r.payload.action === "withdraw";
    if (r.operation !== "consent.read" && pending.some(e => !withdrawing || e.request.operation !== "consent.push" || e.request.payload.action !== "grant")) return unknown(r, "dispatch_unresolved");
    if ((!bypassGrantFence(r, ledger) && (quarantine || availability.quarantined || ledger.quarantined)) || ledger.coolingUntil > now()) return retry(r, "cooling", Math.max(1, Math.ceil((ledger.coolingUntil - now()) / 1000)));
    const proof = authority(r, latest); if (proof) return refused(r, proof);
    if (!ownsAvailability) return retry(r, "cooling");
    if (ledger.tombstones.includes(owner) && (r.operation === "profile.sync" || r.operation === "consent.push" && r.payload.action === "grant")) return refused(r, "restricted");
    const localRef = r.operation === "profile.sync" || r.operation === "consent.push" ? r.payload.consentEvidenceReference : r.operation === "erasure.request" ? r.payload.authorityReference : undefined;
    const localSnapshot = localRef ? copy(input.localEvidence.get(localRef)) : undefined;
    const authSnapshot = copy(input.authorizations.get(r.authorizationReference));
    const guard = (): Reason | undefined => {
      const s = current(r, initial); if (typeof s === "string") return s;
      if (!equal(authSnapshot, input.authorizations.get(r.authorizationReference)) || localRef && !equal(localSnapshot, input.localEvidence.get(localRef))) return "provenance";
      return authority(r, s);
    };
    const listId = r.audience.kind === "audience" ? Object.entries(verification!.listMappings).filter(([, scope]) => equal(scope, r.audience)).map(([k]) => k) : [];
    let target = copy({ ...latest, ...(ledger.mappings[owner] ? { id: ledger.mappings[owner] } : {}) });
    if (target.id && !id(target.id) || target.id && latest.id && target.id !== latest.id) return refused(r, "identity_conflict");
    const readProfile = async (selected: Subject) => http(r, "GET", `/api/profiles/${selected.id}?additional-fields[profile]=subscriptions`, undefined, guard);
    if (!target.id) {
      if (r.operation !== "profile.sync") return refused(r, "identity_conflict");
      const query = new URLSearchParams({ filter: `and(equals(email,${JSON.stringify(target.email)}),equals(external_id,${JSON.stringify(target.externalReference)}))`, "page[size]": "2" });
      const lookup = await http(r, "GET", "/api/profiles?" + query, undefined, guard);
      if (lookup.failure) return lookup.failure;
      const root = object(lookup.body), data = root.data;
      if (lookup.status !== 200 || !Array.isArray(data) || data.length > 1 || object(root.links).next !== null) return refused(r, "identity_conflict");
      if (data.length === 1) {
        const found = profileData({ data: data[0] }, target);
        if (!found) return refused(r, "identity_conflict");
        target = copy({ ...target, id: found });
      } else if (!verification!.safeCreate || !verification!.noTrigger.profile) return refused(r, "restricted");
    }
    if (target.id && (r.operation === "profile.sync" || r.operation === "consent.push")) {
      const read = await readProfile(target);
      if (read.failure) return read.failure;
      if (read.status !== 200 || !profileData(read.body, target)) return refused(r, "identity_conflict");
      if (r.operation === "consent.push" && r.payload.action === "grant") {
        const value = consentValue(read.body, target, r.audience, verification!, now(), maxFeedbackItems);
        if (!value || value.coverage !== "complete" || value.feedback.length > 0) return refused(r, "restricted");
      }
    }
    if (r.operation === "consent.read") {
      const readStartedAt = now();
      const settlements = copy(Object.fromEntries(input.grantSettlements ?? []));
      const read = await readProfile(target);
      if (read.failure) {
        if (read.slotHeld) await releaseSlot();
        const changed = guard(); return changed ? refused(r, changed) : read.failure;
      }
      const changed = guard(); if (changed) { if (read.slotHeld) await releaseSlot(); return refused(r, changed); }
      let value = read.status === 404 ? copy({ audience: r.audience, observedAtMs: now(), remoteConsent: "unknown" as const, coverage: "partial" as const, feedback: [] }) : consentValue(read.body, target, r.audience, verification!, now(), maxFeedbackItems);
      if (!value) { if (read.slotHeld) await releaseSlot(); const changed = guard(); return changed ? refused(r, changed) : retry(r, "provider"); }
      const unsettled = (w: Ledger["withdrawals"][string]) => w.earlier.some(k => {
        const grant = ledger.entries[k];
        const proof = grant && settlements[grant.request.requestId];
        return !grant || !proof || proof.source !== "provider-read" || !text(proof.evidenceReference) ||
          !equal(proof.binding, r.binding) || proof.subjectReference !== r.subjectReference ||
          proof.requestId !== grant.request.requestId || !Number.isFinite(proof.settledAtMs) || proof.settledAtMs > readStartedAt;
      });
      const affected = Object.values(ledger.withdrawals).filter(w => w.owner === owner && !w.resolved && overlaps(w.audience, r.audience));
      const uncertain = affected.some(w => unsettled(w)) || affected.length > 0 && (value.coverage !== "complete" || !["subscribed", "unsubscribed"].includes(value.remoteConsent));
      if (uncertain) value = copy({ ...value, remoteConsent: "unknown" });
      let journal: "confirmed" | "unknown" = "unknown";
      try {
      const next = await load();
      if (!uncertain && value.coverage === "complete") {
        for (const [k, w] of Object.entries(next.ledger.withdrawals)) {
          if (w.owner === owner && overlaps(w.audience, r.audience) && !unsettled(w)) {
            if (value.remoteConsent === "unsubscribed") next.ledger.withdrawals[k].resolved = true;
            for (const earlier of w.earlier) { next.ledger.entries[earlier].grantSettled = true; next.ledger.entries[earlier].phase = "settled"; }
          }
        }
      }
      const alreadyQuarantined = next.ledger.quarantined;
      next.ledger.entries[key] = { request: r, semantic: semantic(r), target, result: result(r, { kind: "completed", value, journal: "unknown" }), phase: "settled" };
      next.ledger.quarantined = true;
      if (await persist(next.raw, next.ledger, key) === "saved" && !alreadyQuarantined) {
        const recorded = canonical(next.ledger);
        next.ledger.entries[key].result = result(r, { kind: "completed", value, journal: "confirmed" });
        next.ledger.quarantined = false; next.ledger.slot = false;
        if (await persist(recorded, next.ledger, key) === "saved") journal = "confirmed";
        else await quarantineAccount(key);
      } else await quarantineAccount(key);
      } catch { await quarantineAccount(key); }
      const afterPersistence = guard(); if (afterPersistence) return refused(r, afterPersistence);
      return result(r, { kind: "completed", value, journal });
    }
    if (r.operation === "erasure.read") return refused(r, "unsupported");
    if (r.operation === "consent.push" && r.audience.kind === "audience" && (listId.length !== 1 || !id(listId[0]))) return refused(r, "restricted");
    const changed = guard(); if (changed) return refused(r, changed);
    // Refresh before CAS: all namespaces/instances sharing account storage arbitrate here.
    ({ raw, ledger } = await load());
    if (ledger.entries[key]) return unknown(r, "dispatch_unresolved");
    if (Object.values(ledger.entries).some(e => subjectKey(e.request) === owner && e.phase !== "settled" && (!withdrawing || e.request.operation !== "consent.push" || e.request.payload.action !== "grant"))) return unknown(r, "dispatch_unresolved");
    if (r.operation === "consent.push" && r.payload.action === "grant" && Object.values(ledger.withdrawals).some(w => !w.resolved && w.owner === owner && overlaps(w.audience, r.audience))) return refused(r, "restricted");
    const receipt = copy({ operation: r.operation, request: r });
    ledger.entries[key] = { request: r, semantic: semantic(r), target, phase: "dispatched" };
    if (r.operation === "erasure.request" && !ledger.tombstones.includes(owner)) ledger.tombstones.push(owner);
    let reconcileRequired = false;
    if (withdrawing) {
      const earlier = Object.entries(ledger.entries).filter(([, e]) => subjectKey(e.request) === owner && e.request.operation === "consent.push" && e.request.payload.action === "grant" && !e.grantSettled).map(([k]) => k);
      for (const [grant, subject] of grantQuarantines.get(availability) ?? []) if (subject === owner && !earlier.includes(grant)) earlier.push(grant);
      reconcileRequired = earlier.length > 0;
      ledger.withdrawals[key] = { owner, audience: r.audience, earlier, resolved: false };
    }
    const admitted = await persist(raw, ledger);
    if (admitted !== "saved") return admitted === "conflict" ? retry(r, "host") : unknown(r, "dispatch_unresolved");
    const command = r.operation === "consent.push" ? consentCommand(r, { id: target.id!, email: target.email }, listId[0]) : r.operation === "erasure.request" ? {
      method: "POST", path: "/api/data-privacy-deletion-jobs", expected: [202], body: { data: { type: "data-privacy-deletion-job", attributes: { profile: { data: { type: "profile", id: target.id, attributes: {} } } } } },
    } : {
      method: target.id ? "PATCH" : "POST", path: target.id ? `/api/profiles/${target.id}` : "/api/profiles", expected: target.id ? [200, 202, 204] : [201, 202, 204],
      body: { data: { type: "profile", ...(target.id ? { id: target.id } : {}), attributes: profileAttributes(r.payload.projection, !target.id) } },
    };
    const wire = await http(r, command.method, command.path, command.body, guard);
    let settled: Result, remoteId: string | undefined;
    if (wire.failure) settled = wire.failure;
    else if (!command.expected.includes(wire.status)) settled = unknown(r, "acceptance_ambiguous", receipt);
    else {
      settled = result(r, { kind: "acknowledged", receipt, journal: quarantine || availability.quarantined || ledger.quarantined ? "unknown" : "confirmed", ...(r.operation === "consent.push" ? { reconcileRequired } : {}) });
      if (r.operation === "profile.sync") {
        const found = wire.body === undefined ? target.id : profileData(wire.body, target, r.payload.projection);
        if (wire.body !== undefined && !found) settled = unknown(r, "acceptance_ambiguous", receipt);
        else if (!found) settled = result(r, { kind: "acknowledged", receipt, journal: "unknown" });
        else {
          const verified = await readProfile({ ...target, id: found });
          if (verified.failure || verified.status !== 200 || !profileData(verified.body, { ...target, id: found }, r.payload.projection) || guard()) settled = result(r, { kind: "acknowledged", receipt, journal: "unknown" });
          else remoteId = found;
        }
      }
    }
    try {
      const final = await load(), entry = final.ledger.entries[key];
      if (!entry || !equal(entry.request, r) || !equal(entry.target, target)) { closeAccount(); return settled.kind === "acknowledged" ? result(r, { ...settled, journal: "unknown" }) : unknown(r, "record_failed", receipt); }
      entry.result = settled;
      // Unknown acceptance retains the per-subject dispatch fence. Known acceptance with a
      // failed projection/mapping check quarantines the account; it is never retried as a write.
      entry.phase = settled.kind === "unknown" ? "dispatched" : "settled";
      if (r.operation === "consent.push" && r.payload.action === "grant" && (settled.kind === "refused" || settled.kind === "retryable")) entry.grantSettled = true;
      if (settled.kind === "acknowledged" && settled.journal === "unknown") final.ledger.quarantined = true;
      if (remoteId) { entry.remoteId = remoteId; final.ledger.mappings[owner] = remoteId; }
      const releaseQuarantine = !final.ledger.quarantined && !quarantine;
      final.ledger.quarantined = true;
      if (await persist(final.raw, final.ledger, key) !== "saved") {
        await quarantineAccount(key);
        return settled.kind === "acknowledged" ? result(r, { ...settled, journal: "unknown" }) : settled.kind === "refused" || settled.kind === "retryable" ? settled : unknown(r, "record_failed", receipt);
      }
      if (releaseQuarantine) {
        const recorded = canonical(final.ledger); final.ledger.quarantined = false;
        if (await persist(recorded, final.ledger, key) !== "saved") {
          await quarantineAccount(key);
          return settled.kind === "acknowledged" ? result(r, { ...settled, journal: "unknown" }) : settled;
        }
      }
      return settled;
    } catch {
      await quarantineAccount(key);
      return settled.kind === "acknowledged" ? result(r, { ...settled, journal: "unknown" }) : settled.kind === "refused" || settled.kind === "retryable" ? settled : unknown(r, "record_failed", receipt);
    }
  }
  async function run(r: Request, operation: Operation): Promise<Result> {
    const fallback = { binding, operation, subjectReference: "" as Request["subjectReference"], requestId: "", generation: 0 };
    try {
      if (!validRequest(r, maxRequestBytes)) return result(fallback, { kind: "refused", reason: "invalid_request" });
    } catch { return result(fallback, { kind: "refused", reason: "invalid_request" }); }
    if (r.operation !== operation) return result(r, { kind: "refused", reason: "binding" });
    const ownsAvailability = !availability.busy;
    if (ownsAvailability) { availability.busy = true; activeRequest = copy(r); }
    try { return await execute(r, ownsAvailability); }
    catch { closeAccount(); return result({ ...fallback, subjectReference: r.subjectReference, requestId: r.requestId, generation: r.generation }, { kind: "unknown", reason: "record_failed" }); }
    finally { if (ownsAvailability) { availability.busy = false; activeRequest = undefined; } }
  }
  const scope = copy(input.legacy?.scope ?? { bindingId: binding.namespace, accountReference: binding.account, audienceReference: audience.kind === "audience" ? audience.reference : "account-wide" });
  function legacyRequest(claim: MarketingAutomationClaim): Request | undefined {
    const saved = input.legacy?.claims.get(claim.effectId);
    return saved && equal(saved.claim, claim) && equal(claim.scope, scope) && claim.subjectReference === saved.request.subjectReference && claim.generation === saved.request.generation &&
      claim.deadlineMs === saved.request.deadlineMs && claim.idempotencyKey === saved.request.requestId ? saved.request : undefined;
  }
  const observation = (claim: MarketingAutomationClaim, value: Result, remoteId?: string): MarketingAutomationObservation => {
    const base = { effectId: claim.effectId, generation: claim.generation, observedAtMs: now() };
    if (value.kind === "acknowledged" && value.journal === "confirmed" && remoteId) return { ...base, status: "accepted", remoteReference: remoteId };
    if (value.kind === "retryable") return { ...base, status: "throttled", retryAfterMs: value.afterSeconds * 1000 };
    if (value.kind === "refused") return { ...base, status: "refused", reason: value.reason === "deadline" ? "deadline" : ["binding", "provenance", "stale", "identity_conflict"].includes(value.reason) ? "scope" : ["unsupported", "verification_pending"].includes(value.reason) ? "unsupported" : "restricted" };
    return { ...base, status: "ambiguous", retryAfterMs: 1000 };
  };
  return {
    capabilities, profiles: { sync: r => run(r, "profile.sync") as Promise<SyncResult<"profile.sync">> },
    consent: { read: r => run(r, "consent.read") as Promise<SyncResult<"consent.read">> },
    erasure: { request: r => run(r, "erasure.request") as Promise<SyncResult<"erasure.request">>, read: r => run(r, "erasure.read") as Promise<SyncResult<"erasure.read">> },
    consentPush: { capabilities, push: r => run(r, "consent.push") as Promise<ConsentPushResult> },
    newsletter: { providerKind: "klaviyo", capabilities: { subscribe: false, unsubscribe: false, suppress: false, unsuppress: false, doubleOptIn: false, emailChange: false, listMembership: false, webhookIdempotency: false, retryAfter: false },
      async sync() { return { status: "skipped", reason: "unsupported" }; }, async reconcile() { return { status: "skipped", reason: "unsupported" }; } },
    scope,
    async admit(claim) {
      try {
        const r = legacyRequest(claim); if (!r || !validRequest(r, maxRequestBytes) || !equal(r.binding, binding)) return "refused";
        const s = current(r); return typeof s === "string" || authority(r, s) || capabilities.operations[r.operation].state !== "supported" ? "refused" : "admitted";
      } catch { return "refused"; }
    },
    async apply(claim) {
      const r = legacyRequest(claim); if (!r) return { effectId: claim.effectId, generation: claim.generation, observedAtMs: now(), status: "refused", reason: "scope" };
      const value = await run(r, r.operation), saved = await load().catch(() => null);
      return observation(claim, value, saved?.ledger.entries[keyOf(r)]?.remoteId);
    },
    async observe(claim) {
      const r = legacyRequest(claim); if (!r) return { effectId: claim.effectId, generation: claim.generation, observedAtMs: now(), status: "refused", reason: "scope" };
      try {
        const saved = (await load()).ledger.entries[keyOf(r)]; return saved?.result ? observation(claim, saved.result, saved.remoteId) : null;
      } catch { return observation(claim, unknown(r, "record_failed")); }
    },
  };
}
