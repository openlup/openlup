import { describe, expect, it, vi } from "vitest";
import { createCatalogCandidateService } from "../../packages/platform/src/catalog/candidate.js";
import { catalogDefinitionDigest } from "../../packages/platform/src/catalog/catalogDefinitionDigest.js";
import { requireHistoricalProtocolBinding, Lc10ProtocolBindingError } from "../../packages/platform/src/subscriptions/successorProtocolBindings.js";
import { input, registry, definition } from "../../packages/platform/test/catalog/fixtures/publicationInput.js";
import { catalogDraftPayloadV5Schema } from "../../packages/platform/src/catalog/successorPublication.js";
import { catalogDraftPayloadV4Schema } from "../../packages/platform/src/catalog/lifecycleV2.js";

const historical = { sourceIdentity: "retained:synthetic", candidateKind: "adopt_v2", baseProtocol: "v3", eventKind: "adopt_v2" };
const binding = { ...historical, authorityRef: "installed:synthetic" };
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
  ] as const)("%s", (_name, field) => {
    const effect = vi.fn();
    expect(requireHistoricalProtocolBinding(historical, [binding])).toEqual(binding);
    try { effect(requireHistoricalProtocolBinding(historical, [{ ...binding, [field]: "unsupported" }])); }
    catch (error) { expect(error).toBeInstanceOf(Lc10ProtocolBindingError); expect(error).toMatchObject({ code: "lc10_protocol_binding_unavailable" }); }
    expect(effect).not.toHaveBeenCalled();
    expect(() => requireHistoricalProtocolBinding(historical, [])).toThrow("lc10_protocol_binding_unavailable");
  });
  it("requires one exact installed source, rather than a current metadata guess", () => {
    expect(() => requireHistoricalProtocolBinding(historical, [binding,binding])).toThrow("lc10_protocol_binding_unavailable");
    expect(() => requireHistoricalProtocolBinding({ ...historical,sourceIdentity: "other:source" }, [binding])).toThrow("lc10_protocol_binding_unavailable");
    expect(() => requireHistoricalProtocolBinding(historical, [{ ...binding,authorityRef: " " }])).toThrow("lc10_protocol_binding_unavailable");
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
  const payload = { ...input().payload,schemaVersion: 5 as const }, predecessor = "90000000-0000-4000-8000-000000000001";
  payload.publication.operations = payload.publication.operations.map(operation => operation.op === "create_sku" ? { ...operation,successorOf: predecessor } : operation);
  expect(catalogDraftPayloadV5Schema.parse(payload)).toEqual(payload);
  expect(catalogDraftPayloadV4Schema.safeParse({ ...payload,schemaVersion: 4 }).success).toBe(false);
  const invalid = structuredClone(payload);
  invalid.publication.operations = invalid.publication.operations.map(operation => operation.op === "create_sku" ? { ...operation,successorOf: operation.skuId } : operation);
  expect(catalogDraftPayloadV5Schema.safeParse(invalid).success).toBe(false);
});
