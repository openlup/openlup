import { describe, expect, it, vi } from "vitest";
import { createCatalogCandidateService,catalogDefinitionDigest,createCatalogProductTypeRegistry,catalogDraftPayloadV5Schema,catalogDraftPayloadV4Schema } from "@openlup/platform/catalog";
import type { CatalogDraftPayloadV2,CatalogDraftPayloadV5 } from "@openlup/platform/catalog/contracts";
import { createPostgresSuccessorStore,createNativeRenewalCodec } from "@openlup/platform/subscriptions";
import type { HistoricalSuccessorProtocolBinding } from "@openlup/platform/subscriptions";
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
  const effect=vi.fn(),id="90000000-0000-4000-8000-000000000001",actor={actorId:id,clientId:id};
  const store=createPostgresSuccessorStore({codec:createNativeRenewalCodec(),historicalBindings:installedBindings,
    previews:{prepare:async()=>({applyPayload:{},cycleSnapshot:null})},withTransaction:async work=>{
      effect();return work({query:async sql=>({rows:sql.includes("EXISTS")?[{allowed:true}]:sql.includes("FROM public.subscription_quote_previews")?[{actor_id:id,client_id:id,subscription_id:id}]:[{result:{state:"offered"}}]})});
    }});
  return {effect,invoke:()=>store.offer(actor,{proposalId:id,subscriptionId:id,predecessorSkuId:id,successorSkuId:id,publicationId:id,previewId:id,lane:"classic",action:"update_package_template",sourceBinding:{kind:"ordinary_edit"},historicalBinding:lineage,now:"2026-01-01T00:00:00Z"})};
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
