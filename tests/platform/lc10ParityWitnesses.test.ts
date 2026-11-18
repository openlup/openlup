import { describe, expect, it, vi } from "vitest";
import { createCatalogCandidateService,catalogDefinitionDigest,createCatalogProductTypeRegistry,catalogDraftPayloadV5Schema,catalogDraftPayloadV4Schema } from "@openlup/platform/catalog";
import type { CatalogDraftPayloadV2,CatalogDraftPayloadV5 } from "@openlup/platform/catalog/contracts";
import { createPostgresSuccessorStore,createNativeRenewalCodec } from "@openlup/platform/subscriptions";
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
function historicalOffer(installedBindings:readonly HistoricalSuccessorProtocolBinding[],lineage=historical) {
  const effect=vi.fn(),id="90000000-0000-4000-8000-000000000001",subscriptionId="90000000-0000-4000-8000-000000000002",actor={actorId:id,clientId:"90000000-0000-4000-8000-000000000003"};
  const store=createPostgresSuccessorStore({codec:createNativeRenewalCodec(),historicalBindings:installedBindings,
    previews:{prepare:async()=>({applyPayload:{},cycleSnapshot:null})},withTransaction:async work=>{
      effect();return work({query:async sql=>({rows:sql.includes("EXISTS")||sql.includes("pg_try_advisory")?[{allowed:true}]:sql.includes("FROM public.subscription_quote_previews")?[{actor_id:id,client_id:actor.clientId,subscription_id:subscriptionId}]:[{result:{state:"offered"}}]})});
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
