import { expect, it, vi } from "vitest";
import { createPersonalDataContributorRegistry } from "../../src/identity/personalDataRegistry.js";
import { erasePersonalData, exportPersonalData } from "../../src/identity/privacyUseCases.js";
import { PrivacyRefusal, type PrivacyStore, type PersonalDataContributor } from "../../src/identity/privacyPorts.js";
const C = "11111111-1111-4111-8111-111111111111", K = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const calls: string[] = [];
  const contributor = (id: string): PersonalDataContributor<null> => ({ id, version: `${id}.v1`, ownedResources: [`${id}.data`], prepareErasure: async () => { calls.push(`prepare:${id}`); },
    export: async () => ({ contributorId: id, version: `${id}.v1`, data: null, coverage: { complete: true, included: [], unavailable: [] }, obligations: [] }),
    assessErasure: vi.fn(async () => { calls.push(`assess:${id}`); return { obligations: [] }; }),
    eraseOrRetain: vi.fn(async () => { calls.push(`erase:${id}`); return { contributorId: id, version: `${id}.v1`, obligations: [] }; }),
  });
  const identity = contributor("identity"), other = contributor("other");
  const store: PrivacyStore<null> = { erasureSupported: true, prepareErasure: async () => {}, authorizeErasure: async () => {}, resolve: async () => ({ contactId: C, principalId: null, identity: {} }), findReceipt: async () => null, eraseIdentity: async () => {}, saveReceipt: vi.fn(async () => {}) };
  const deps = { store, unitOfWork: { run: async <T>(work: (context: null) => Promise<T>) => work(null) }, registry: createPersonalDataContributorRegistry([identity, other], { requiredContributorIds: ["identity", "other"] }), now: () => new Date("2026-01-01T00:00:00Z"), randomId: () => K };
  return { calls, identity, other, store, deps };
}
it("duplicate and missing required contributors refuse erasure while export exposes coverage", async () => {
  const f = fixture();
  expect(() => createPersonalDataContributorRegistry([f.identity, f.identity], { requiredContributorIds: [] })).toThrow("PRIVACY_CONTRIBUTOR_DUPLICATE");
  f.deps.registry = createPersonalDataContributorRegistry([f.identity], { requiredContributorIds: ["identity", "other"] });
  await expect(erasePersonalData(f.deps, { principalId: K }, { subject: { kind: "contact", contactId: C }, idempotencyKey: K })).rejects.toThrow("PRIVACY_CONTRIBUTOR_MISSING");
  expect((await exportPersonalData(f.deps, { principalId: K }, { kind: "contact", contactId: C })).missingContributors).toEqual(["other"]);
  expect(f.identity.eraseOrRetain).not.toHaveBeenCalled();
});
it("every assessment completes before the first mutation and a late veto leaves identity untouched", async () => {
  const f = fixture();
  await erasePersonalData(f.deps, { principalId: K }, { subject: { kind: "contact", contactId: C }, idempotencyKey: K });
  expect(f.calls).toEqual(["prepare:identity", "prepare:other", "assess:identity", "assess:other", "erase:identity", "erase:other"]);
  const refused = fixture();
  vi.mocked(refused.other.assessErasure).mockRejectedValueOnce(new PrivacyRefusal("PRIVACY_ACTIVE_SUBSCRIPTION"));
  await expect(erasePersonalData(refused.deps, { principalId: K }, { subject: { kind: "contact", contactId: C }, idempotencyKey: K })).rejects.toThrow("PRIVACY_ACTIVE_SUBSCRIPTION");
  expect(refused.identity.eraseOrRetain).not.toHaveBeenCalled(); expect(refused.store.saveReceipt).not.toHaveBeenCalled();
});
it("repeat returns the original committed receipt without reassessing or mutating", async () => {
  const f = fixture();
  const receipt = { version: "identity.erasure.v1" as const, erasureId: K, completedAt: "2026-01-01T00:00:00.000Z", outcome: "ERASED" as const, obligations: [] };
  f.store.findReceipt = async () => receipt;
  expect(await erasePersonalData(f.deps, { principalId: K }, { subject: { kind: "contact", contactId: C }, idempotencyKey: K })).toEqual({ ...receipt, outcome: "ALREADY_ERASED" });
  expect(f.identity.assessErasure).not.toHaveBeenCalled(); expect(f.identity.eraseOrRetain).not.toHaveBeenCalled(); expect(f.store.saveReceipt).not.toHaveBeenCalled();
});

it("undeclared ownership and mismatched export versions refuse", async () => {
  const f = fixture();
  expect(() => createPersonalDataContributorRegistry([{ ...f.identity, ownedResources: [] }], { requiredContributorIds: ["identity"] })).toThrow("PRIVACY_OWNERSHIP_UNDECLARED");
  f.identity.export = async () => ({ contributorId: "other", version: "other.v1", data: null, coverage: { complete: true, included: [], unavailable: [] }, obligations: [] });
  await expect(exportPersonalData(f.deps, { principalId: K }, { kind: "contact", contactId: C })).rejects.toThrow("PRIVACY_OWNERSHIP_UNDECLARED");
});
