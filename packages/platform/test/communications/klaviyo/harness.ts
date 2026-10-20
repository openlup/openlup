import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { expect } from "vitest";
import { createKlaviyoMarketingAdapter } from "../../../src/communications/klaviyo/index.js";
import { binding, audience, request as neutralRequest, pushRequest as neutralPushRequest } from "../helpers/marketingSyncConformance.js";
import type { ConsentPushRequest, SyncAudience, SyncRequest } from "../../../src/communications/contracts/marketingSync.js";

type WireBody = { data: { [key: string]: unknown; attributes: Record<string, unknown>; relationships: unknown } };
type Config = Parameters<typeof createKlaviyoMarketingAdapter>[0];
export { binding, audience };
export type Factory = typeof createKlaviyoMarketingAdapter;
export const sample = JSON.parse(readFileSync(new URL("./profile.json", import.meta.url), "utf8"));
export function request<O extends SyncRequest["operation"]>(op: O, overrides: Partial<SyncRequest<O>> = {}) {
  return neutralRequest(op, { deadlineMs: 100000, authorizationReference: `authorization:${op}`, ...overrides });
}
export function pushRequest(overrides: Partial<ConsentPushRequest> = {}) {
  return neutralPushRequest({ deadlineMs: 100000, authorizationReference: "authorization:consent.push", ...overrides });
}
export const withdraw = (overrides: Partial<ConsentPushRequest> = {}) => pushRequest({ requestId: "withdraw:1", payload: { action: "withdraw", consentEvidenceReference: "withdraw:1" }, ...overrides });
export function fixture(factory: Factory = createKlaviyoMarketingAdapter, options: { audience?: SyncAudience; pending?: boolean; verification?: Partial<NonNullable<Config["verification"]>> } = {}) {
  const scope = options.audience ?? audience;
  const state = {
    now: 10, subject: { binding: structuredClone(binding), subjectReference: "subject:1", generation: 1, erased: false,
      id: "owned_1" as string | undefined, email: "synthetic@example.invalid", externalReference: "local:1", ownedFields: ["givenName", "familyName", "locale"] as const, ownedProperties: ["segment"] },
    remote: structuredClone(sample), matches: 0, lookupNext: false, calls: [] as { url: string; method: string; body: WireBody; headers: HeadersInit | undefined; redirect: RequestRedirect | undefined }[],
    fault: undefined as undefined | ((url: string, init: RequestInit) => Response | Promise<Response> | undefined),
    storageFault: undefined as undefined | ((phase: "get" | "cas", value?: string) => "throw" | "lost" | "false" | "wrong" | undefined),
    afterAwait: () => {},
  };
  const authorizations = new Map<string, Config["authorizations"] extends ReadonlyMap<string, infer T> ? T : never>();
  for (const operation of ["profile.sync", "consent.read", "erasure.request", "erasure.read", "consent.push"] as const) {
    authorizations.set(`authorization:${operation}`, { binding, subjectReference: "subject:1", audience: scope, operation, expiresAtMs: 100000 });
  }
  const localEvidence = new Map<string, Config["localEvidence"] extends ReadonlyMap<string, infer T> ? T : never>([
    ["local-consent:1", { binding, subjectReference: "subject:1", audience: scope, purpose: "purpose:1", action: "profile", current: true, projection: request("profile.sync").payload.projection }],
    ["grant:1", { binding, subjectReference: "subject:1", audience: scope, purpose: "purpose:1", action: "grant", current: true }],
    ["withdraw:1", { binding, subjectReference: "subject:1", audience: scope, purpose: "purpose:1", action: "withdraw", current: true, allPurposes: true }],
    ["authority:1", { binding, subjectReference: "subject:1", audience: scope, purpose: "erasure", action: "erase", current: true, caseReference: "case:1", authorityReference: "authority:1" }],
  ]);
  const values = new Map<string, string>();
  const storage: Config["storage"] = {
    availability: { account: binding.account, environment: binding.environment, busy: false, quarantined: false },
    async get(key) { state.afterAwait(); const fault = state.storageFault?.("get"); if (fault === "throw") throw Error("synthetic storage"); return fault === "wrong" ? "{}" : values.get(key) ?? null; },
    async compareAndSwap(key, expected, next) {
      state.afterAwait(); const fault = state.storageFault?.("cas", next);
      if (fault === "throw") throw Error("synthetic storage"); if (fault === "false") return false;
      if ((values.get(key) ?? null) !== expected) return false;
      values.set(key, next);
      if (fault === "lost") throw Error("synthetic lost reply");
      return true;
    },
  };
  const settlements = new Map<string, NonNullable<Config["grantSettlements"]> extends ReadonlyMap<string, infer T> ? T : never>();
  const config: Config = { binding, audience: scope, subjectMapper: ref => ref === "subject:1" ? state.subject : undefined,
    resolveCredential: () => ({ binding, key: "synthetic-key" }), authorizations, localEvidence, storage, grantSettlements: settlements,
    now: () => state.now, timeoutMs: 25, rateIntervalMs: 1,
    verification: options.pending ? undefined : { binding, audience: scope, evidenceReference: "offline:synthetic-not-TEST", revision: "2026-07-15",
      operations: ["profile.sync", "consent.read", "erasure.request", "consent.push"], scopes: ["profiles:read", "profiles:write", "data-privacy:write", "subscriptions:write", "lists:write"],
      noTrigger: { profile: true, accountWideGrant: true, doi: true }, safeCreate: true, safeListRemoval: true, suppressionSafeAtEffect: true, negativeSourcesComplete: true,
      listMappings: { LIST1: audience, LIST2: { kind: "audience", reference: "audience:opposite" } }, ...options.verification },
    fetch: async (raw, init = {}) => {
      const url = String(raw), method = init.method ?? "GET", body: WireBody = init.body ? JSON.parse(String(init.body)) : { data: { attributes: {}, relationships: {} } };
      state.calls.push({ url, method, body, headers: init.headers, redirect: init.redirect }); state.now += 2;
      const fault = state.fault?.(url, init); if (fault) return fault;
      const path = new URL(url).pathname;
      if (method === "GET" && path === "/api/profiles") return Response.json({ data: Array.from({ length: state.matches }, () => state.remote.data), links: { next: state.lookupNext ? "forbidden" : null } });
      if (method === "GET") return Response.json(state.remote);
      if (path === "/api/profiles" || method === "PATCH") {
        if (method === "POST") state.remote.data.id = "created_1";
        state.remote.data.attributes = { ...state.remote.data.attributes, ...body.data.attributes };
        return Response.json(state.remote, { status: method === "POST" ? 201 : 200 });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 202 });
    },
  };
  const provider = factory(config);
  return { factory, provider, state, config, storage, values, authorizations, localEvidence, settlements,
    effects: () => state.calls.filter(c => c.method !== "GET"),
    ledger: () => JSON.parse([...values.values()][0] ?? "{}"),
    rebuild: () => factory(config),
  };
}
export type Harness = ReturnType<typeof fixture>;

const mutations: Record<string, [string, string][]> = {
  binding: [['if (!equal(r.binding, binding)) return refused(r, "binding");', 'if (false) return refused(r, "binding");']],
  target: [['if (snapshot && !equal(s, snapshot))', 'if (false)']],
  consent: [['const local = input.localEvidence.get(ref);', 'const local = input.localEvidence.get(ref) ?? input.localEvidence.get("local-consent:1");']],
  projection: [['if (!equal(local.projection, r.payload.projection))', 'if (false)']],
  generation: [['if (s.generation !== r.generation)', 'if (false)'], ['if (snapshot && !equal(s, snapshot))', 'if (snapshot && !equal({...s,generation:0}, {...snapshot,generation:0}))']],
  tombstone: [['if (s.erased &&', 'if (false &&'], ['if (snapshot && !equal(s, snapshot))', 'if (snapshot && !equal({...s,erased:false}, {...snapshot,erased:false}))']],
  mapping: [['final.ledger.mappings[owner] = remoteId;', 'void remoteId;']],
  surface: [['const REVISION =', 'export const unexpected = true;\nconst REVISION =']],
  scope: [['audience: scope }) as NegativeFeedback', 'audience: {kind:"account-wide"} }) as NegativeFeedback']],
  grant: [['feedback, coverage: complete', 'feedback, localConsent:"granted", coverage: complete']],
  bounce: [['kind === "hard_bounce" || kind === "invalid_address" ? "deny_delivery"', 'kind === "invalid_address" ? "deny_delivery"']],
  receipt: [['if (receipt.operation !== "erasure.request" || !prior', 'if (false && (receipt.operation !== "erasure.request" || !prior'], ['!equal(prior.result.receipt, receipt)) return refused', '!equal(prior.result.receipt, receipt))) return refused']],
  case: [['if (r.operation === "erasure.request" && (local.caseReference', 'if (false && (local.caseReference']],
  "ack-completed": [['kind: "acknowledged", receipt, journal: quarantine', 'kind: "completed", receipt, journal: quarantine']],
  "absence-completed": [['if (cap.state !== "supported") return refused(r, cap.state);', 'if (cap.state !== "supported") return r.operation === "erasure.read" ? result(r,{kind:"completed"}) : refused(r, cap.state);']],
  "generation-key": [['canonical([r.binding, r.operation, r.subjectReference, r.requestId])', 'canonical([r.binding, r.operation, r.subjectReference, r.requestId, r.generation])']],
  "lost-admission": [['} catch { await quarantineAccount(affectedKey); return "uncertain"; }', '} catch { return "saved"; }']],
  "lost-record": [['        ledger.quarantined = true;', '        ledger.quarantined = false;'], ['if (r.operation !== "consent.read" && pending.some(e => !withdrawing || e.request.operation !== "consent.push" || e.request.payload.action !== "grant"))', 'if (false)'], ['if (Object.values(ledger.entries).some(e => subjectKey(e.request) === owner && e.phase !== "settled" && (!withdrawing || e.request.operation !== "consent.push" || e.request.payload.action !== "grant")))', 'if (false)']],
  "expired-read": [['if (r.deadlineMs <= now())', 'if (false)'], ['Math.min(timeoutMs, r.deadlineMs - now())', 'timeoutMs']],
  "flow-endpoint": [], "import-endpoint": [], "suppression-endpoint": [], "extra-profile": [],
  "withdraw-redispatch": [['if (r.operation !== "consent.read" && pending.some(e => !withdrawing || e.request.operation !== "consent.push" || e.request.payload.action !== "grant"))', 'if (r.operation !== "consent.read" && pending.length > 0 && !withdrawing)'], ['if (Object.values(ledger.entries).some(e => subjectKey(e.request) === owner && e.phase !== "settled" && (!withdrawing || e.request.operation !== "consent.push" || e.request.payload.action !== "grant")))', 'if (Object.values(ledger.entries).some(e => subjectKey(e.request) === owner && e.phase !== "settled") && !withdrawing)']],
  "record-quarantine": [['        ledger.quarantined = true;', '        ledger.quarantined = false;']],
  pacing: [['if (!quarantine && !availability.quarantined && !ledger.quarantined && !ledger.slot && ledger.coolingUntil <= now() && delay > 0 && delay < Math.min(timeoutMs, r.deadlineMs - now()))', 'if (false)']],
  "read-quarantine": [['        ledger.quarantined = true;', '        ledger.quarantined = false;'], ['if (r.operation !== "consent.read") await releaseSlot(r);', 'await releaseSlot();']],
  "read-fact": [['} catch { await quarantineAccount(key); }\n      const afterPersistence', '} catch { quarantine = true; return unknown(r,"record_failed"); }\n      const afterPersistence']],
  "read-generation": [['const afterPersistence = guard(); if (afterPersistence)', 'const afterPersistence = guard(); if (false)']],
  "withdraw-as-grant": [['if (r.operation === "consent.push") {', 'if (r.operation === "consent.push") { if (r.payload.action === "withdraw" && !input.localEvidence.get("grant:1")?.current) return "restricted";']],
  "old-grant-start": [['if (s.generation !== r.generation)', 'if (false)'], ['if (snapshot && !equal(s, snapshot))', 'if (snapshot && !equal({...s,generation:0}, {...snapshot,generation:0}))']],
  "grant-fenced-withdrawal": [['const withdrawing = r.operation === "consent.push" && r.payload.action === "withdraw";', 'const withdrawing = r.operation === "consent.push" && r.payload.action === "withdraw"; if (withdrawing && Object.values(ledger.entries).some(e => e.request.operation === "consent.push" && e.request.payload.action === "grant" && e.result?.kind === "unknown")) return unknown(r,"dispatch_unresolved");']],
  "delay-withdrawal": [['const withdrawing = r.operation === "consent.push" && r.payload.action === "withdraw";', 'const withdrawing = r.operation === "consent.push" && r.payload.action === "withdraw"; if(withdrawing && Object.values(ledger.entries).some(e=>e.request.operation==="consent.push" && e.request.payload.action==="grant" && !e.grantSettled)) return unknown(r,"dispatch_unresolved");']],
  cooldown: [['providerCooling.set(availability, Math.max(providerCooling.get(availability) ?? 0, now() + afterSeconds * 1000));', 'void 0;'], ['next.ledger.coolingUntil = Math.max(next.ledger.coolingUntil, now() + afterSeconds * 1000);', 'next.ledger.coolingUntil = 0;']],
  "missing-ref": [['text(object(p).consentEvidenceReference) &&', 'true &&'], ['const local = input.localEvidence.get(ref);', 'const local = input.localEvidence.get(ref) ?? input.localEvidence.get("grant:1");']],
  "push-completed": [['kind: "acknowledged", receipt, journal: quarantine', 'kind: "completed", receipt, journal: quarantine']],
  unverified: [[': { state: "verification_pending" as const };', ': { state: "supported" as const, evidenceReference:"fault",maxRequestBytes,maxFeedbackItems };']],
  "no-trigger": [['!verification?.noTrigger.accountWideGrant', 'false']],
  "suppression-clearing": [['!verification.suppressionSafeAtEffect', 'false'], ['value.feedback.length > 0', 'false'], ['value.coverage !== "complete"', 'false']],
  "global-widening": [['if (r.payload.action === "withdraw" && r.audience.kind === "audience" && !verification?.safeListRemoval)', 'if (false)']],
  "hide-race": [['reconcileRequired = earlier.length > 0;', 'reconcileRequired = false;']],
  "pending-withdrawal": [['Object.values(ledger.withdrawals).some(w => !w.resolved && w.owner === owner && overlaps(w.audience, r.audience))) return refused(r, "restricted");', 'false) return refused(r, "restricted");'], ['w.owner === subjectKey(r) && !w.resolved', 'false']],
  "skip-withdrawal": [['const withdrawing = r.operation === "consent.push" && r.payload.action === "withdraw";', 'const withdrawing = false;']],
  "early-read": [['if (uncertain) value = copy({ ...value, remoteConsent: "unknown" });', 'if (false) value = copy({ ...value, remoteConsent: "unknown" });']],
  "body-import": [],
};
mutations["substituted-authority"] = [['local.subjectReference !== r.subjectReference', 'false']];
mutations["broadened-grant"] = [['!equal(local.audience, r.audience)', 'false']];
mutations["remote-grant"] = mutations.grant;
mutations["suppression-present"] = [['value.feedback.length > 0', 'false']];
mutations["suppression-unknown"] = [['value.coverage !== "complete"', 'false']];
mutations["suppression-at-effect"] = [['!verification.suppressionSafeAtEffect', 'false']];
mutations["rejected-job"] = [['entry.grantSettled = true;', 'void 0;']];
const dropAvailability: [string, string] = ['quarantine = true; availability.quarantined = true;', 'quarantine = true;'];
for (const name of ["lost-record", "read-quarantine", "record-quarantine"]) mutations[name].push(dropAvailability);
mutations["host-availability"] = [dropAvailability];
const modules = new Map<string, Factory>();
const surfaces = new Map<string, string[]>();
let temporary = "";
export async function preparePlants(names: string[]) {
  temporary = mkdtempSync(join(tmpdir(), "openlup-offline-protocol-"));
  const source = readFileSync(new URL("../../../src/communications/klaviyo/index.ts", import.meta.url), "utf8");
  const command = readFileSync(new URL("../../../src/communications/klaviyo/consentPush.ts", import.meta.url), "utf8");
  const compile = (s: string) => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  writeFileSync(join(temporary, "consentPush.mjs"), compile(command));
  for (const name of names) {
    let changed = source;
    for (const [before, after] of mutations[name] ?? []) { expect(changed, `${name} source plant target exists`).toContain(before); changed = changed.replaceAll(before, after); }
    if (["body-import", "flow-endpoint", "import-endpoint", "suppression-endpoint", "extra-profile", "extra-payload-keys"].includes(name)) {
      const endpoint = name === "flow-endpoint" ? "/api/flows" : name === "import-endpoint" ? "/api/profile-bulk-import-jobs" : "/api/profile-suppression-bulk-create-jobs";
      const bad = name === "extra-payload-keys" ? command.replace("attributes: { profiles:", "attributes: { unapproved: true, profiles:") : name === "body-import" ? command.replace('attributes: { profiles:', 'attributes: { historical_import: true, profiles:') : name === "extra-profile" ? command.replace('profiles: { data: [', 'profiles: { data: [{type:"profile",attributes:{email:"extra@example.invalid"}},') : command.replace('path: `/api/${type}s`', `path: "${endpoint}"`);
      writeFileSync(join(temporary, `${name}-command.mjs`), compile(bad));
      changed = changed.replace('"./consentPush.js"', `"./${name}-command.mjs"`);
    }
    changed = changed.replace('"./consentPush.js"', '"./consentPush.mjs"');
    const file = join(temporary, `${name}.mjs`); writeFileSync(file, compile(changed));
    const module = await import(/* @vite-ignore */ pathToFileURL(file).href);
    modules.set(name, module.createKlaviyoMarketingAdapter); surfaces.set(name, Object.keys(module));
  }
}
export const planted = (name?: string, options?: Parameters<typeof fixture>[1]) => ({ ...fixture(name ? modules.get(name)! : createKlaviyoMarketingAdapter, options), surface: name ? surfaces.get(name)! : ["createKlaviyoMarketingAdapter"] });
export function cleanupPlants() { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
export const factoryFor = (name: string) => modules.get(name)!;
