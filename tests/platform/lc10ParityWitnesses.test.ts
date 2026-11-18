import { describe, expect, it, vi } from "vitest";
import { createCatalogCandidateService,catalogDefinitionDigest,createCatalogProductTypeRegistry,catalogDraftPayloadV5Schema,catalogDraftPayloadV4Schema,createPostgresCatalogWithdrawalImpact } from "@openlup/platform/catalog";
import type { CatalogDraftPayloadV2,CatalogDraftPayloadV5 } from "@openlup/platform/catalog/contracts";
import { createPostgresSuccessorStore,createNativeRenewalCodec,createPostgresSuccessorNotices,createPostgresSizedEditor } from "@openlup/platform/subscriptions";
import type { HistoricalSuccessorProtocolBinding } from "@openlup/platform/subscriptions";
import { customerSubscriptionPreviewResponseSchema } from "../../src/domains/customers/subscriptionFacadeContracts.js";
import type { CustomerSubscriptionPreviewResponse } from "../../src/domains/customers/subscriptionFacadeContracts.js";
import { ambientSettlementProfile } from "../../src/lib/currency/platformCurrency.js";
import { attachSubscriptionPreviewQuote } from "../../server/adapters/supabase/customerSubscriptionPreviewQuoteLedger.js";
const definition={key:"example:article",version:1,units:[{code:"openlup:g",dimension:"mass" as const,integral:false}],netContentUnits:["openlup:g"],dimensions:[],axes:[],validatorRef:`sha256:${"a".repeat(64)}`,validateContent:()=>[]};
const registry=createCatalogProductTypeRegistry([definition]);
function input() {
  const product="10000000-0000-4000-8000-000000000001",sku="20000000-0000-4000-8000-000000000001",draftId="30000000-0000-4000-8000-000000000001";
  const payload:CatalogDraftPayloadV2={schemaVersion:2,product:{id:product,type:{key:definition.key,version:1},dimensions:[],slug:"article",primarySkuId:sku,sharedContent:{synthetic:true}},skus:[{id:sku,productId:product,code:"ARTICLE",options:{},netContent:{dimension:"mass",unit:"openlup:g",unscaled:"100",scale:0},identifiers:[{scheme:"gs1:gtin",issuer:"example",value:"5901234123457",packagingLevel:"unit"}]}]};
  return {payload,record:{draftId,productId:product,revision:1,status:"open" as const,commandKey:"draft:first",fingerprint:"b".repeat(64),actorId:"operator:synthetic",createdAt:"2026-01-01T00:00:00Z",payload}};
}
const historical = { sourceIdentity: "retained:synthetic", candidateKind: "adopt_v2", baseProtocol: "v3", eventKind: "adopt_v2" };
const binding = { ...historical, authorityRef: "installed:synthetic" };

const readSku = "81000000-0000-4000-8000-000000000001";
const obligation = { family: "stock_wait", sourceId: "81000000-0000-4000-8000-000000000002",
  subscriptionId: "81000000-0000-4000-8000-000000000003", skuId: readSku, skuCode: "SYNTHETIC", skuRevisionId: null };
const completeImpact = (obligations: unknown[]) => ({ schemaVersion: 2, outcome: "complete", obligations });
it.each([
  ["mixed_valid", completeImpact([obligation, { ...obligation, caseKind: "successor", sourceId: obligation.subscriptionId }]), "complete"],
  ["item_missing", completeImpact([null]), "unknown"],
  ["item_primitive", completeImpact([8]), "unknown"],
  ["family_unknown", completeImpact([{ ...obligation, family: "unrecognized" }]), "unknown"],
  ["kind_unknown", completeImpact([{ ...obligation, caseKind: "unknown" }]), "unknown"],
  ["source_invalid", completeImpact([{ ...obligation, sourceId: "invalid" }]), "unknown"],
  ["sku_changed", completeImpact([{ ...obligation, skuId: obligation.sourceId }]), "unknown"],
  ["item_duplicate", completeImpact([obligation, obligation]), "unknown"],
  ["result_absent", undefined, "unavailable"],
] as const)("lc10_read_impact_%s", async (_case, result, outcome) => {
  const impact = createPostgresCatalogWithdrawalImpact({
    query: async () => ({ rows: result === undefined ? [] : [{ result }] }),
  });
  const actual = await impact.report(readSku);
  expect(actual.outcome).toBe(outcome);
  if (outcome === "complete") expect(actual).toEqual(result);
  else expect(actual).toEqual({ schemaVersion: 2, outcome, reason: `catalog_obligation_evidence_${outcome}` });
});

it.each([
  ["mixed_valid", [obligation, { ...obligation, caseKind: "successor", sourceId: obligation.subscriptionId }], false, 2],
  ["after_valid_unknown", [obligation, { ...obligation, family: "unexpected" }], false, 0],
  ["after_valid_duplicate", [obligation, obligation], false, 0],
  ["absent_case_kind_on_successor", [obligation], true, 0],
  ["unowned_publication_member", [obligation], false, 0],
] as const)("lc10_read_notice_impact_%s", async (scenario, items, wrongKind, calls) => {
  const publicationId = "81000000-0000-4000-8000-000000000004";
  const notice = vi.fn();
  const stored = createPostgresSuccessorNotices({
    withTransaction: work => work({ query: async (sql, params) => {
      if (sql.includes("FROM public.outbox_events")) return { rows: [{ matching: true }] };
      if (sql.includes("FROM public.catalog_publications")) {
        return { rows: [{ canonical_state: JSON.stringify({ skus: [{ skuId: readSku }] }) }] };
      }
      if (sql.includes("FROM public.catalog_skus")) return { rows: scenario === "unowned_publication_member" ? [] : [{ id: readSku }] };
      if (sql.includes("subscription_successor_notice_v2")) {
        notice();
        return { rows: [{ result: { outcome: "handed_off" } }] };
      }
      const requested = (params?.[0] ?? []) as string[];
      const cases = requested.map(sourceId => ({ source_id: sourceId,
        legacy: !wrongKind && sourceId === obligation.sourceId, successor: wrongKind || sourceId !== obligation.sourceId }));
      return { rows: cases };
    } }),
    impact: { report: async () => ({ outcome: "complete", obligations: items }) },
    recipient: async () => null,
    delivery: { enqueue: async () => { throw Error("publication_must_only_handoff"); } },
  });
  const at = "2026-11-18T12:00:00Z";
  expect(await stored.handle({ id: publicationId, created_at: at, available_at: at, processed_at: null,
    aggregate_type: "catalog", aggregate_id: obligation.subscriptionId, event_type: "catalog.publication.committed",
    idempotency_key: publicationId, status: "pending", error: null, attempts: 0, metadata: {}, payload: { head: { publicationId } } }))
    .toEqual(calls ? { kind: "processed" } : { kind: "retry", reason: "catalog_obligation_evidence_unknown" });
  expect(notice).toHaveBeenCalledTimes(calls);
});

it.each(["subscription.successor.offered.v2","subscription.predecessor_withdrawn.v2"] as const)(
  "lc10_notice_accepted_precedes_live_%s",async eventType=>{
    const queries:string[] = [];
    const recipient=vi.fn();
    const enqueue=vi.fn();
    const store=createPostgresSuccessorNotices({
      withTransaction:work=>work({query:async sql=>{
        queries.push(sql);
        if(sql.includes("FROM public.outbox_events"))return {rows:[{matching:true}]};
        if(sql.includes("transactional_delivery_read_receipt"))return {rows:[{state:"accepted"}]};
        throw Error("accepted_notice_must_not_read_live_data");
      }}),
      recipient,delivery:{enqueue},impact:{report:async()=>{throw Error("unexpected_impact");}},
    });
    const at="2026-11-18T12:00:00Z";
    expect(await store.handle({id:obligation.sourceId,created_at:at,available_at:at,processed_at:null,aggregate_type:"subscription",
      aggregate_id:obligation.subscriptionId,event_type:eventType,idempotency_key:obligation.sourceId,status:"pending",
      error:null,attempts:0,metadata:{},payload:{subscriptionId:obligation.subscriptionId,clientId:readSku,
        proposalId:obligation.sourceId,caseKind:"legacy",caseId:obligation.sourceId}}))
      .toEqual({kind:"processed",detail:{dedupe:"email_already_sent"}});
    expect(queries).toHaveLength(2);
    expect(recipient).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  },
);

const readAt = "2026-11-18T12:00:00Z";
const readFingerprint = "a".repeat(64);
const waitCase = { id: obligation.sourceId, subscription_id: obligation.subscriptionId, client_id: readSku,
  operation_id: obligation.subscriptionId, scheduled_at: readAt, cycle_number: 1, state: "waiting", deficits: [],
  fingerprint: readFingerprint, identity_key: "synthetic:operation", opened_at: readAt, last_checked_at: readAt,
  last_selected_at: null, stock_secured_at: null, resumed_at: null, closed_at: null, block_reason: null,
  cycle_id: null, order_id: null, fulfillment_id: null };
const caseRead = { schemaVersion: 2, caseKind: "successor", case: waitCase };
const legacyDue = { schemaVersion: 2, operationKind: "legacy", due: { subscription_id: obligation.subscriptionId,
  client_id: readSku, scheduled_at: readAt, cycle_number: 1, currency_code: "XXX", cadence_days: 28,
  stock_source_key: "synthetic", settlement_channel_key: "native", authorization_ref: "synthetic",
  payer_account_ref: null, unattended_charge_authorized_at: readAt, delivery_admission: "ready", delivery_block_reason: null } };
const successorDue = { schemaVersion: 2, operationKind: "successor", operationId: obligation.subscriptionId,
  identityKey: "synthetic:operation", operationFingerprint: readFingerprint,
  snapshot: { schemaVersion: 2, subscriptionId: readSku, scheduledAt: readAt } };
const successorCandidate = { ...successorDue, caseKind: "successor", caseId: obligation.sourceId, cycleNumber: 1,
  binding: { caseKind: "successor", caseId: obligation.sourceId, operationId: obligation.subscriptionId,
    rootOperationId: readSku, proposalId: readSku, claimGeneration: 1 } };
const legacyCandidate = { schemaVersion: 2, operationKind: "legacy", caseKind: "legacy",
  frozen: { ...successorDue, snapshot:{...successorDue.snapshot,subscriptionId:obligation.sourceId},caseId: null, cycleNumber: 1,
    binding: { caseId: null, cycleId: null, orderId: null, paymentId: null, engineIdempotencyKey: successorDue.identityKey } } };
const resumedCase = { ...caseRead, case: { ...waitCase, state: "resumed", order_id: readSku, resumed_at: readAt } };
it.each([
  ["readCase", "null", null, true],
  ["readCase", "missing", undefined, false],
  ["readCase", "exact", caseRead, true],
  ["readCase", "kind_changed", { ...caseRead, caseKind: "legacy", case: { ...waitCase, renewal_operation_id: waitCase.operation_id } }, false],
  ["readCase", "case_changed", { ...caseRead, case: { ...waitCase, id: readSku } }, false],
  ["readCase", "bad_time", { ...caseRead, case: { ...waitCase, checked_at: readAt, last_checked_at: "date" } }, false],
  ["readCase", "bad_state", { ...caseRead, case: { ...waitCase, state: "unknown" } }, false],
  ["readCase", "nonpositive_cycle", { ...caseRead, case: { ...waitCase, cycle_number: 0 } }, false],
  ["listDue", "exact_mixed", [legacyDue, successorDue], true],
  ["listDue", "not_an_array", legacyDue, false],
  ["listDue", "legacy_bad_currency", [{ ...legacyDue, due: { ...legacyDue.due, currency_code: 123 } }], false],
  ["listDue", "successor_bad_snapshot", [{ ...successorDue, snapshot: [] }], false],
  ["listCandidates", "exact_mixed", [legacyCandidate, successorCandidate], true],
  ["listCandidates", "not_an_array", successorCandidate, false],
  ["listCandidates", "legacy_binding_missing", [{ ...legacyCandidate, frozen: { ...legacyCandidate.frozen, binding: null } }], false],
  ["listCandidates", "successor_binding_mismatch", [{ ...successorCandidate, binding: { ...successorCandidate.binding, operationId: readSku } }], false],
  ["markResumed", "null", null, true],
  ["markResumed", "exact", resumedCase, true],
  ["markResumed", "wrong_order", { ...resumedCase, case: { ...resumedCase.case, order_id: obligation.sourceId } }, false],
] as const)("lc10_read_versioned_%s_%s", async (method, _case, result, valid) => {
  const store = createPostgresSuccessorStore({ codec: createNativeRenewalCodec(),
    previews: { prepare: async () => { throw Error("read_must_not_prepare"); } },
    withTransaction: work => work({ query: async sql => ({ rows: method==="listDue"&&sql.includes("stock_wait_candidates_v2")
      ?[{result:[]}]:result===undefined?[]:[{result}] }) }),
  });
  const reads = {
    readCase: () => store.readCase(obligation.sourceId, "successor"), markResumed: () => store.markResumed(readSku),
    listDue: () => store.listDue(50, readAt), listCandidates: () => store.listCandidates(50, readAt),
  };
  if (valid) expect(await reads[method]()).toEqual(result);
  else await expect(reads[method]()).rejects.toHaveProperty("message", "subscription_renewal_response_invalid");
});

it.each([[0,1],[1,1],[2,2],[50,50],[51,50],[500,50],[501,50],[null,50]] as const)("lc10_select_combined_cap_%s",async(limit,cap)=>{
  const normal=[legacyDue,successorDue],waiting=[legacyCandidate,{...successorCandidate,
    snapshot:{...successorCandidate.snapshot,scheduledAt:"2026-11-18T13:00:00+01:00"}}];
  const query=vi.fn(async(sql:string,_parameters?:readonly unknown[])=>({rows:[{result:sql.includes("stock_wait_candidates_v2")?waiting:normal}]}));
  const store=createPostgresSuccessorStore({codec:createNativeRenewalCodec(),
    withTransaction:work=>work({query}),previews:{prepare:async()=>{throw Error("selection_must_not_quote");}}});
  expect(await store.listDue(limit,readAt)).toEqual([legacyDue,legacyCandidate,waiting[1]].slice(0,cap));
  expect(query.mock.calls.map(([,parameters])=>parameters?.[0])).toEqual([cap,cap]);
});

const readPrepared = { schemaVersion: 2, operationKind: "successor", state: "attempt_prepared", replayed: true,
  operationId: readSku, operationFingerprint: readFingerprint, cycleId: obligation.subscriptionId,
  orderId: obligation.sourceId, settlementIntentId: obligation.sourceId };
it.each(["w10", "w11", "r6"] as const)("lc10_saved_method_host_selection_%s", async path => {
  const subscriptionId = readSku, clientId = obligation.sourceId;
  const snapshot = { ...successorDue.snapshot, subscriptionId, clientId };
  const candidate = path === "w10" ? { ...legacyCandidate, frozen: { ...legacyCandidate.frozen, snapshot } }
    : { ...successorCandidate, snapshot };
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("SELECT cycle_snapshot") ? [{ cycle_snapshot: snapshot }]
    : [{ result: path === "r6" ? readPrepared : [candidate] }] }));
  const connection = { query };
  const methods = [
    { ref: "inactive", active: false, healthy: false, updated: 5, created: 5 },
    { ref: "active", active: true, healthy: false, updated: 4, created: 4 },
    { ref: "healthy-old", active: true, healthy: true, updated: 1, created: 1 },
    { ref: "healthy-new", active: true, healthy: true, updated: 1, created: 2 },
  ];
  const buyer = { email: null, firstName: null, lastName: "Synthetic" };
  const selectSavedMethod = vi.fn(async () => ({ buyer, methodRef: [...methods].sort((a, b) =>
    Number(b.active && b.healthy) - Number(a.active && a.healthy) || Number(b.active) - Number(a.active)
    || b.updated - a.updated || b.created - a.created)[0]?.ref ?? null }));
  const store = createPostgresSuccessorStore({ withTransaction: work => work(connection), selectSavedMethod,
    codec: { ...createNativeRenewalCodec(), decode: vi.fn().mockReturnValue(snapshot) },
    previews: { prepare: vi.fn() } });
  for (const methodRef of ["healthy-new", "healthy-old", "active", "inactive", null]) {
    const result = path === "r6" ? await store.prepare({ operationId: readSku, claimToken: readSku, now: readAt })
      : (await store.listCandidates(1, readAt) as unknown[])[0];
    expect(result).toEqual({ ...(path === "r6" ? readPrepared : candidate), paymentSelection: { methodRef, buyer } });
    expect(selectSavedMethod).toHaveBeenLastCalledWith(connection, { subscriptionId, clientId, asOf: readAt });
    methods.pop();
  }
  expect(selectSavedMethod).toHaveBeenCalledTimes(5);
});
const readWaiting = { schemaVersion: 2, caseKind: "successor", waiting: true, caseId: obligation.sourceId,
  deficits: [{ sku: "SYNTHETIC", requiredUnits: 1, reservedUnits: 0, availableUnits: 0, missingUnits: 1 }] };

it.each([
  ["prepare", "exact", readPrepared, true],
  ["prepare", "missing_cycle", { ...readPrepared, cycleId: undefined }, false],
  ["prepare", "missing_order", { ...readPrepared, orderId: undefined }, false],
  ["prepare", "missing_payment", { ...readPrepared, settlementIntentId: undefined }, false],
  ["prepare", "wrong_operation", { ...readPrepared, operationId: obligation.sourceId }, false],
  ["prepare", "invalid_replay", { ...readPrepared, replayed: "true" }, false],
  ["recover", "exact_wait", readWaiting, true],
  ["recover", "missing_case", { ...readWaiting, caseId: undefined }, false],
  ["recover", "empty_deficits", { ...readWaiting, deficits: [] }, false],
  ["recover", "unrelated_error", { error: "other_error", caseId: obligation.sourceId }, false],
  ["recover", "durable_blocker", { error: "stock_wait_check_failed", caseId: obligation.sourceId }, true],
  ["recover", "secured", { schemaVersion: 2, operationKind: "successor", waiting: false, replayed: true,
    caseId: obligation.sourceId, operation: { id: readSku } }, true],
] as const)("lc10_read_command_%s_%s", async (method, _input, result, valid) => {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("SELECT cycle_snapshot") ? [{ cycle_snapshot: {} }] : [{ result }] }));
  const store = createPostgresSuccessorStore({
    codec: { ...createNativeRenewalCodec(), decode: vi.fn().mockReturnValue({}) },
    withTransaction: work => work({ query }), previews: { prepare: async () => { throw Error("unexpected_quote"); } },
  });
  const invoke = () => method === "prepare" ? store.prepare({ operationId: readSku, claimToken: readSku, now: readAt })
    : store.recover({ operationId: readSku, fingerprint: readFingerprint, workerId: "fixture", now: readAt });
  if (valid) expect(await invoke()).toEqual(result);
  else await expect(invoke()).rejects.toHaveProperty("message", method === "prepare"
    ? "subscription_renewal_prepare_response_invalid" : "subscription_renewal_response_invalid");
  expect(query).toHaveBeenCalledTimes(method === "prepare" ? 2 : 1);
});

it.each([["version",{version:1}],["data",{data:{}}],["flat",{}]] as const)("lc10_quote_successor_sized_constraint_%s",async(kind,extra)=>{
  const transaction=vi.fn(async()=>{throw Error("preview_transaction");});
  const editor=createPostgresSizedEditor({
    now:()=>readAt,withTransaction:transaction,
    policy:{minimumCoreUnits:1,maximumCoreLines:3,maximumAddonLines:3,maximumQuantity:12,allowedCadences:[28],
      maximumExclusions:20,maximumCatalogExclusions:20,fixedThroughCycle:2,graduationCycle:3,
      portionModes:{full:{mode:"complete",factor:1},reduced:{mode:"partial",factor:0.5}}},
    readFacts:vi.fn(),resolveOptInNeed:vi.fn(),readCatalog:vi.fn(),assertCurrentFacts:vi.fn(),proposePortion:vi.fn(),
    quotePort:{createServerAuthoritativeQuote:vi.fn()},
  });
  await expect(editor.previewStockWaitSuccessor({actorId:obligation.sourceId,clientId:readSku},
    {subscriptionId:obligation.subscriptionId,action:"update_bundle",coreLines:[{variantId:readSku,qty:1}],
      compositionConstraint:{kind:"unit_count",value:1,dailyNeed:1,...extra}},
    {caseId:obligation.sourceId,caseKind:"legacy"})).rejects.toHaveProperty("message",kind==="flat"
      ?"preview_transaction":"subscription_reprice_invalid_request");
  expect(transaction).toHaveBeenCalledTimes(kind==="flat"?1:0);
});

it("lc10_quote_shipped_sized_constraint_envelope_result", async () => {
  const stored = { status: "applied", action: "update_bundle", templateVersion: 4 };
  const withTransaction: Parameters<typeof createPostgresSizedEditor>[0]["withTransaction"] = work => work({
    query: async sql => ({ rows: sql.includes("SELECT s.*") ? [{ status: "active", payment_blocked: true,
      method_healthy: true, configured_offer_version: "sized.v1", next_cycle_at: null, template_version: 3 }]
      : sql.includes("FROM public.subscription_command_receipts") ? [{ matches: true, result: stored, status: "applied" }] : [] }),
  });
  const editor = createPostgresSizedEditor({ now: () => readAt, withTransaction,
    policy: { minimumCoreUnits: 1, maximumCoreLines: 3, maximumAddonLines: 3, maximumQuantity: 12, allowedCadences: [28],
      maximumExclusions: 20, maximumCatalogExclusions: 20, fixedThroughCycle: 2, graduationCycle: 3,
      portionModes: { full: { mode: "complete", factor: 1 }, reduced: { mode: "partial", factor: 0.5 } } },
    readFacts: vi.fn(), resolveOptInNeed: vi.fn(), readCatalog: vi.fn(), assertCurrentFacts: vi.fn(), proposePortion: vi.fn(),
    quotePort: { createServerAuthoritativeQuote: vi.fn() } });
  const actor = { actorId: obligation.sourceId, clientId: readSku };
  const request = { subscriptionId: obligation.subscriptionId, action: "update_bundle" as const,
    coreLines: [{ variantId: readSku, qty: 1 }], compositionConstraint: { kind: "unit_count", value: 1 } };
  const expected = { preview: { subscriptionId: request.subscriptionId, action: "update_bundle", canApply: false,
    blockedReason: "payment_blocked", nextCycleAt: null, editCutoffAt: null, templateVersion: 3 },
  lockedCycle: { locked: true, status: "dunning" },
  futureTemplate: { templateVersion: 3, effectiveCycleAt: null, priceAgreementPolicy: "lock_until_edit" } };
  expect(await editor.preview(actor, request)).toEqual(expected);
  const envelope = { ...request, compositionConstraint: { version: 1, data: request.compositionConstraint } };
  await expect(editor.preview(actor, envelope)).resolves.toEqual(expected);
  await expect(editor.apply(actor, "synthetic-command", { ...envelope, expectedTemplateVersion: 3, acceptedQuoteHash: readFingerprint }))
    .resolves.toEqual({ ...stored, status: "replayed", originalStatus: "applied" });
});

function historicalOffer(installedBindings:readonly HistoricalSuccessorProtocolBinding[],lineage=historical) {
  const effect=vi.fn(),id="90000000-0000-4000-8000-000000000001",subscriptionId="90000000-0000-4000-8000-000000000002",actor={actorId:id,clientId:"90000000-0000-4000-8000-000000000003"};
  const store=createPostgresSuccessorStore({codec:createNativeRenewalCodec(),historicalBindings:installedBindings,
    previews:{prepare:async()=>({applyPayload:{},cycleSnapshot:null})},withTransaction:async work=>{
      effect();return work({query:async sql=>({rows:sql.includes("EXISTS")||sql.includes("pg_try_advisory")?[{allowed:true}]:sql.includes("FROM public.subscription_successor_proposals")?[]:sql.includes("FROM public.subscription_quote_previews")?[{actor_id:id,client_id:actor.clientId,subscription_id:subscriptionId}]:[{result:{state:"offered"}}]})});
    }});
  return {effect,invoke:()=>store.offer(actor,{proposalId:"90000000-0000-4000-8000-000000000004",subscriptionId,predecessorSkuId:"90000000-0000-4000-8000-000000000005",successorSkuId:"90000000-0000-4000-8000-000000000006",publicationId:"90000000-0000-4000-8000-000000000007",previewId:"90000000-0000-4000-8000-000000000008",lane:"classic",action:"update_package_template",sourceBinding:{kind:"ordinary_edit"},historicalBinding:lineage,now:"2026-01-01T00:00:00Z"})};
}
describe("explicit historical successor authority", () => {
  it.each([
    ["lc10_history_03679_kind_authority_missing", "candidateKind"],
    ["lc10_history_03680_kind_authority_missing", "candidateKind"],
    ["lc10_history_03682_protocol_authority_missing", "baseProtocol"],
    ["lc10_history_03683_protocol_authority_missing", "baseProtocol"],
    ["lc10_history_03685_event_authority_missing", "eventKind"],
    ["lc10_history_03686_event_authority_missing", "eventKind"],
    ["lc10_history_03791_kind_authority_missing", "candidateKind"],
    ["lc10_history_03792_protocol_authority_missing", "baseProtocol"],
    ["lc10_history_03793_event_authority_missing", "eventKind"],
  ] as const)("%s", async (_name, field) => {
    const supported=historicalOffer([binding]);expect(await supported.invoke()).toEqual({state:"offered"});expect(supported.effect).toHaveBeenCalledOnce();
    const missing=historicalOffer([{...binding,[field]:"unsupported"}]);
    expect(missing.invoke).toThrow("lc10_protocol_binding_unavailable");expect(missing.effect).not.toHaveBeenCalled();
    const absent=historicalOffer([]);expect(absent.invoke).toThrow("lc10_protocol_binding_unavailable");expect(absent.effect).not.toHaveBeenCalled();
  });
  it("requires one exact installed source, rather than a current metadata guess", () => {
    expect(historicalOffer([binding,binding]).invoke).toThrow("lc10_protocol_binding_unavailable");
    expect(historicalOffer([binding],{ ...historical,sourceIdentity:"other:source" }).invoke).toThrow("lc10_protocol_binding_unavailable");
    expect(historicalOffer([{...binding,authorityRef:" "}]).invoke).toThrow("lc10_protocol_binding_unavailable");
  });
});
it.each(["03120","03123","03139","03142","03143","03146"])("lc10_history_%s_candidate_identity", async () => {
  const f = input(), service = createCatalogCandidateService({
    registry, readDraft: async () => f.record, installedDefinitionDigest: async () => catalogDefinitionDigest(definition),
    currentHead: async () => ({ outcome: "unpublished" }), resolveHead: async () => null,
    readDocument: async reference => reference,
  });
  const candidate = await service.prepareCandidate({ draftId: f.record.draftId,draftRevision: 1,expectedHead: null });
  expect(candidate.issues).toEqual([]);
  expect(await service.compareCandidate({ candidateRef: candidate.candidateRef,candidateDigest: candidate.candidateDigest,expectedHead: null })).toEqual(candidate);
  await expect(service.compareCandidate({ candidateRef: candidate.candidateRef,candidateDigest: "0".repeat(64),expectedHead: null })).rejects.toMatchObject({ code: "candidate_digest_mismatch" });
});
it("successor declaration uses a new grammar and leaves prior authoring bytes closed", () => {
  const initial=input().payload,facts={skuCode:"ARTICLE",title:"Synthetic article",minQuantity:1,isAddon:false,facts:{derived:12}},predecessor="90000000-0000-4000-8000-000000000001";
  const payload:CatalogDraftPayloadV5={...initial,schemaVersion:5,product:{...initial.product,sharedContent:{schemaVersion:1,catalogAction:"create",presentation:{},publicationSkus:[facts],requestedModes:[{skuCode:"ARTICLE",modes:[]}],offerMemberships:[]}},publication:{kind:"release",evidence:{},operations:[{op:"create_product",productId:initial.product.id,productSlug:"article",name:"Synthetic article"},{op:"create_sku",productSlug:"article",documentRevisionNo:1,skuId:initial.skus[0]!.id,...facts,successorOf:predecessor}]}};
  expect(catalogDraftPayloadV5Schema.parse(payload)).toEqual(payload);
  expect(catalogDraftPayloadV4Schema.safeParse({ ...payload,schemaVersion: 4 }).success).toBe(false);
  const invalid = structuredClone(payload);
  invalid.publication.operations = invalid.publication.operations.map(operation => operation.op === "create_sku" ? { ...operation,successorOf: operation.skuId } : operation);
  expect(catalogDraftPayloadV5Schema.safeParse(invalid).success).toBe(false);
});

function previewResponse() {
  const money={amountMinor:100,currency:ambientSettlementProfile.defaultCurrency},at="2040-01-01T12:00:00.000Z";
  return {preview:{subscriptionId:"10000000-0000-4000-8000-000000000001",action:"update_package_template",canApply:true,
    blockedReason:null as string|null,nextCycleAt:at,editCutoffAt:at,templateVersion:1,quoteHash:"a".repeat(64),
    lockedCycle:{locked:false,status:null},futureTemplate:{templateVersion:1,effectiveCycleAt:at,priceAgreementPolicy:"lock_until_edit"},
    deliverability:{status:"unknown",blockedReason:null as string|null},catalogAvailability:{status:"unknown",blockedReason:null as string|null},
    chargeTiming:{requiresConfirmation:false,confirmed:false,earliestChargeAt:null},
    dateAvailability:{earliestAllowedAt:at,latestAllowedAt:at,availableDates:[at],blockedReason:null as string|null},
    packageEdit:{currentRecurringPrice:money,newRecurringPrice:money,delta:{...money,amountMinor:0},quoteHash:"a".repeat(64),effectiveCycleAt:at,priceAgreementPolicy:"lock_until_edit"}}};
}
it.each([
  ["lc10_parity__LC10_11067__customerSubscriptionPreviewResponseSchema__kills_delete_outermost_validation_call_only","response"],
  ["lc10_parity__LC10_11068__customerSubscriptionPreviewResponseSchema__kills_delete_outermost_validation_call_only","preview"],
  ["lc10_preview_lockedCycle_rejects_unknown_fields","lockedCycle"],
  ["lc10_preview_futureTemplate_rejects_unknown_fields","futureTemplate"],
  ["lc10_parity__LC10_11087__customerSubscriptionPreviewResponseSchema__kills_delete_outermost_validation_call_only","deliverability"],
  ["lc10_parity__LC10_11097__customerSubscriptionPreviewResponseSchema__kills_delete_outermost_validation_call_only","catalogAvailability"],
  ["lc10_preview_chargeTiming_rejects_unknown_fields","chargeTiming"],
  ["lc10_parity__LC10_11108__customerSubscriptionPreviewResponseSchema__kills_delete_outermost_validation_call_only","dateAvailability"],
  ["lc10_preview_packageEdit_rejects_unknown_fields","packageEdit"],
] as const)("%s",(_name,path)=>{
  const response=previewResponse();expect(customerSubscriptionPreviewResponseSchema.safeParse(response).success).toBe(true);
  const target=path==="response"?response:path==="preview"?response.preview:response.preview[path];
  Object.assign(target,{unrecognized:true});
  expect(customerSubscriptionPreviewResponseSchema.safeParse(response).success).toBe(false);
});
it.each([
  ["lc10_parity__LC10_11074__customerSubscriptionPreviewResponseSchema__kills_remove_allowed_member_or_literal","preview"],
  ["lc10_parity__LC10_11094__customerSubscriptionPreviewResponseSchema__kills_remove_allowed_member_or_literal","deliverability"],
  ["lc10_parity__LC10_11103__customerSubscriptionPreviewResponseSchema__kills_remove_allowed_member_or_literal","catalogAvailability"],
  ["lc10_parity__LC10_11113__customerSubscriptionPreviewResponseSchema__kills_remove_allowed_member_or_literal","dateAvailability"],
] as const)("%s",(_name,path)=>{
  const response=previewResponse(),target=path==="preview"?response.preview:response.preview[path];
  for(const value of [null,"not_active","edit_window_closed","cycle_locked","payment_blocked","missing_payment_method","invalid_address"]){
    target.blockedReason=value;expect(customerSubscriptionPreviewResponseSchema.safeParse(response).success).toBe(true);
  }
  target.blockedReason="unknown_reason";expect(customerSubscriptionPreviewResponseSchema.safeParse(response).success).toBe(false);
});

type PreviewResponseFixture=ReturnType<typeof previewResponse>;
it.each([
  ["11069",(r:PreviewResponseFixture)=>{r.preview.action="";}],
  ["11070",(r:PreviewResponseFixture)=>{r.preview.action="a".repeat(81);}],
  ["11080",(r:PreviewResponseFixture)=>{r.preview.templateVersion=1.5;}],
  ["11081",(r:PreviewResponseFixture)=>{r.preview.templateVersion=0;}],
  ["11084",(r:PreviewResponseFixture)=>{r.preview.futureTemplate.templateVersion=1.5;}],
  ["11085",(r:PreviewResponseFixture)=>{r.preview.futureTemplate.templateVersion=0;}],
  ["11106",(r:PreviewResponseFixture)=>{r.preview.quoteHash="z".repeat(64);}],
  ["11117",(r:PreviewResponseFixture)=>{r.preview.packageEdit.quoteHash="z".repeat(64);}],
  ["11109",(r:PreviewResponseFixture)=>{r.preview.dateAvailability.availableDates=Array.from({length:62},()=>"2040-01-01T12:00:00.000Z");}],
] as const)("lc10_parity__LC10_%s__customerSubscriptionPreviewResponseSchema__kills_delete_outermost_validation_call_only",(_id,mutate)=>{
  const response=previewResponse();expect(customerSubscriptionPreviewResponseSchema.safeParse(response).success).toBe(true);
  mutate(response);expect(customerSubscriptionPreviewResponseSchema.safeParse(response).success).toBe(false);
});
it.each([
  ["11088","deliverability","address_book_validated"],
  ["11089","deliverability","blocked"],
  ["11090","deliverability","unknown"],
  ["11098","catalogAvailability","blocked"],
  ["11099","catalogAvailability","unknown"],
] as const)("lc10_parity__LC10_%s__customerSubscriptionPreviewResponseSchema__kills_remove_allowed_member_or_literal",(_id,path,status)=>{
  const response=previewResponse();response.preview[path].status=status;
  expect(customerSubscriptionPreviewResponseSchema.safeParse(response).success).toBe(true);
  if(path==="catalogAvailability"){response.preview[path].status="available";expect(customerSubscriptionPreviewResponseSchema.safeParse(response).success).toBe(true);}
  response.preview[path].status="invalid";expect(customerSubscriptionPreviewResponseSchema.safeParse(response).success).toBe(false);
});

it.each([
  ["lc10_parity__LC10_08315__attachSubscriptionPreviewQuote__kills_delete_refusal_statement","absent"],
  ["lc10_parity__LC10_08319__attachSubscriptionPreviewQuote__kills_delete_refusal_statement","line"],
  ["lc10_parity__LC10_08325__attachSubscriptionPreviewQuote__kills_delete_refusal_statement","bundle"],
] as const)("%s",async(_name,mode)=>{
  const rpc=vi.fn(async()=>({data:null,error:null})),repriceForEdit=vi.fn(async()=>null),repriceRecipeSet=vi.fn(async()=>null);
  const response=previewResponse() as CustomerSubscriptionPreviewResponse,before=structuredClone(response);
  const action=mode==="bundle"?"update_bundle":"update_addon_quantity";
  await expect(attachSubscriptionPreviewQuote({userId:"10000000-0000-4000-8000-000000000002",
    serviceClient:{rpc} as unknown as Parameters<typeof attachSubscriptionPreviewQuote>[0]["serviceClient"],
    subscriptionRepricer:mode==="absent"?undefined:{repriceForEdit,repriceRecipeSet} as unknown as Parameters<typeof attachSubscriptionPreviewQuote>[0]["subscriptionRepricer"],
    action:{action,subscriptionId:response.preview.subscriptionId},canApply:true,nextCycleAt:response.preview.nextCycleAt,response,
  })).rejects.toThrow("subscription_preview_reprice_unavailable");
  expect(rpc).not.toHaveBeenCalled();expect(response).toEqual(before);
  if(mode==="line"){expect(repriceForEdit).toHaveBeenCalledOnce();expect(repriceRecipeSet).not.toHaveBeenCalled();}
  if(mode==="bundle"){expect(repriceRecipeSet).toHaveBeenCalledOnce();expect(repriceForEdit).not.toHaveBeenCalled();}
});
