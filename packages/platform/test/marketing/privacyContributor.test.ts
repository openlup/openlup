import { expect, it, vi } from "vitest";
import { createPersonalDataContributorRegistry, createPrivacyOperations, PrivacyRefusal,
  type PersonalDataContributor, type PrivacyStore, type ResolvedPrivacySubject } from "../../src/identity/index.js";
import type { ErasureReceipt, PersonalDataObligation } from "../../src/identity/contracts/index.js";
import { createMarketingPrivacyContributor, type MarketingAcquisitionPrivacyPort, type MarketingRemoteErasureCase, type MarketingRemoteErasurePort } from "../../src/marketing/server/index.js";

type Context = { effects: string[]; email: string };
const contactId = "00000000-0000-4000-8000-000000000001", principalId = "00000000-0000-4000-8000-000000000002";
const actor = { principalId: "00000000-0000-4000-8000-000000000003" };
const key = "00000000-0000-4000-8000-000000000004", caseId = "00000000-0000-4000-8000-000000000005";
const ref = { kind: "contact" as const, contactId }, now = () => new Date(0);
const declared = (): PersonalDataObligation[] => ["marketing.acquisition-records", "marketing.acquisition-evidence"].map(resource => ({
  owner: "marketing", resource, disposition: resource.endsWith("evidence") ? "retain" : "erase", reasonCode: "OWNER_POLICY", remote: false,
}));
function fixture(options: { unbound?: "both" | "acquisition" | "remoteErasure"; veto?: "PRIVACY_ACTIVE_SUBSCRIPTION" | "PRIVACY_RESUMABLE_SUBSCRIPTION" } = {}) {
  const context: Context = { effects: [], email: "subject@example.invalid" };
  const subject = (): ResolvedPrivacySubject => ({ contactId, principalId, identity: { contact: { email: context.email } } });
  let receipt: ErasureReceipt | null = null;
  let state: MarketingRemoteErasureCase = { state: "pending", fenced: true, waitingImports: 0, pendingTargets: 0 };
  const acquisition: MarketingAcquisitionPrivacyPort<Context> = {
    export: vi.fn(async () => ({ records: [{ id: contactId }], evidence: { count: 1 }, obligations: declared() })),
    assessErasure: vi.fn(async () => ({ obligations: declared() })),
    eraseOrRetain: vi.fn(async (tx, _subject, assessment) => { tx.effects.push("local"); return assessment; }),
  };
  const remote: MarketingRemoteErasurePort<Context> = {
    read: vi.fn(async () => state),
    openAndFence: vi.fn(async (tx, input) => {
      expect(tx).toBe(context); expect(input.subject.identity.contact).toEqual({ email: "subject@example.invalid" });
      expect(input.actor).toEqual(actor); expect(input.caseId).toBe(caseId); expect(input.openedAt).toBe(now().toISOString());
      tx.effects.push("fence"); return state;
    }),
  };
  const marketing = createMarketingPrivacyContributor({ acquisition: options.unbound === "both" || options.unbound === "acquisition" ? null : acquisition,
    remoteErasure: options.unbound === "both" || options.unbound === "remoteErasure" ? null : remote, randomId: () => caseId, now });
  const identity: PersonalDataContributor<Context> = {
    id: "identity", version: "identity.personal-data.v1", ownedResources: ["identity.profile"], async prepareErasure() {},
    async export() { return { contributorId: "identity", version: "identity.personal-data.v1", data: {}, coverage: { complete: true, included: [], unavailable: [] }, obligations: [] }; },
    async assessErasure() { return { obligations: [] }; },
    async eraseOrRetain(tx) { tx.email = "erased@example.invalid"; tx.effects.push("identity"); return { contributorId: "identity", version: "identity.personal-data.v1", obligations: [] }; },
  };
  const subscriptions: PersonalDataContributor<Context> = { ...identity, id: "subscriptions", version: "subscriptions.privacy.v1", ownedResources: ["subscriptions.lifecycle"],
    async assessErasure() { if (options.veto) throw new PrivacyRefusal(options.veto); return { obligations: [] }; },
    async eraseOrRetain() { return { contributorId: "subscriptions", version: "subscriptions.privacy.v1", obligations: [] }; },
    async export() { return { contributorId: "subscriptions", version: "subscriptions.privacy.v1", data: {}, coverage: { complete: false, included: [], unavailable: ["subscriptions.lifecycle"] }, obligations: [] }; },
  };
  const saveReceipt = vi.fn(async (_tx: Context, _subject: ResolvedPrivacySubject, _actor: unknown, _key: string, value: ErasureReceipt) => { receipt = value; });
  const store: PrivacyStore<Context> = { erasureSupported: true, async prepareErasure() {}, async authorizeErasure() {},
    async resolve() { return subject(); }, async findReceipt() { return receipt; }, async eraseIdentity() {}, saveReceipt };
  const operations = createPrivacyOperations({ registry: createPersonalDataContributorRegistry([identity, marketing, subscriptions], { requiredContributorIds: ["identity", "marketing", "subscriptions"] }),
    store, now, randomId: () => key, unitOfWork: { async run(work) {
      const before = { effects: [...context.effects], email: context.email };
      try { return await work(context); } catch (error) { Object.assign(context, before); throw error; }
    } } });
  return { operations, context, marketing, acquisition, remote, saveReceipt, subject, setState(value: MarketingRemoteErasureCase) { state = value; } };
}
const erase = (f: ReturnType<typeof fixture>) => f.operations.erase(actor, { subject: ref, idempotencyKey: key });

it.each(["both", "acquisition", "remoteErasure"] as const)("reports unavailable coverage with %s unbound and refuses before any owner call", async unbound => {
  const f = fixture({ unbound });
  const exported = await f.operations.export(actor, ref), document = exported.documents.find(row => row.contributorId === "marketing")!;
  expect(document.coverage).toEqual({ complete: false, included: [], unavailable: [...f.marketing.ownedResources] });
  expect(document.obligations.every(row => row.disposition === "unresolved")).toBe(true);
  await expect(erase(f)).rejects.toMatchObject({ code: "PRIVACY_OWNERSHIP_UNDECLARED" });
  for (const fn of [...Object.values(f.acquisition), ...Object.values(f.remote)]) expect(fn).not.toHaveBeenCalled();
  expect(f.context.effects).toEqual([]); expect(f.saveReceipt).not.toHaveBeenCalled();
});
it("uses the resolved subject in the shared transaction and receipt replay avoids another case", async () => {
  const f = fixture();
  vi.mocked(f.acquisition.assessErasure).mockResolvedValue({ obligations: declared().map(row => ({ ...row, reasonCode: "subject@example.invalid" })) });
  await f.marketing.prepareErasure(f.context);
  await f.marketing.assessErasure(f.context, f.subject());
  expect(f.remote.openAndFence).not.toHaveBeenCalled(); expect(f.acquisition.eraseOrRetain).not.toHaveBeenCalled();
  const receipt = await erase(f);
  expect(JSON.stringify(receipt)).not.toContain("subject@example.invalid");
  expect(receipt.outcome).toBe("ERASED"); expect(f.context.effects).toEqual(["identity", "fence", "local"]);
  expect(receipt.obligations).toEqual(expect.arrayContaining(declared().map(row => expect.objectContaining({ resource: row.resource, disposition: row.disposition }))));
  expect(f.saveReceipt).toHaveBeenCalledTimes(1);
  await expect(erase(f)).resolves.toMatchObject({ outcome: "ALREADY_ERASED", erasureId: receipt.erasureId });
  expect(f.remote.openAndFence).toHaveBeenCalledTimes(1); expect(f.acquisition.eraseOrRetain).toHaveBeenCalledTimes(1);
});
it.each(["PRIVACY_ACTIVE_SUBSCRIPTION", "PRIVACY_RESUMABLE_SUBSCRIPTION"] as const)("preserves the owner veto %s before a marketing fence", async veto => {
  const f = fixture({ veto }); await expect(erase(f)).rejects.toMatchObject({ code: veto });
  expect(f.remote.openAndFence).not.toHaveBeenCalled(); expect(f.acquisition.eraseOrRetain).not.toHaveBeenCalled(); expect(f.saveReceipt).not.toHaveBeenCalled();
  expect(f.context.effects).toEqual([]);
});
it("reports closed remote states and backlog without claiming deletion proof or exposing owner fields", async () => {
  const f = fixture();
  const outcomes = { pending: "REMOTE_ERASURE_PENDING", requested: "REMOTE_ERASURE_REQUESTED", accepted: "REMOTE_ERASURE_ACCEPTED_NOT_OBSERVED",
    failed: "REMOTE_ERASURE_FAILED", not_bound: "REMOTE_ERASURE_NOT_BOUND_LOCAL_FENCE_ONLY" } as const;
  for (const state of Object.keys(outcomes) as (keyof typeof outcomes)[]) {
    f.setState({ state, fenced: true, pendingTargets: 0, waitingImports: 0, email: "subject@example.invalid",
      providerJobRef: "00000000-0000-4000-8000-000000000006", address: "synthetic" } as MarketingRemoteErasureCase);
    const document = await f.marketing.export(f.context, f.subject());
    expect(document.coverage.complete).toBe(false); expect(document.coverage.unavailable).toContain("marketing.remote-profile");
    expect((document.data as { remoteProfile: unknown }).remoteProfile).toEqual({ state });
    expect(document.obligations[2]).toMatchObject({ disposition: "retain", remote: true, reasonCode: outcomes[state] });
    expect(JSON.stringify(document)).not.toContain("subject@example.invalid");
  }
  f.setState({ state: "accepted", fenced: true, pendingTargets: 0, waitingImports: 0 });
  expect((await erase(f)).obligations[2]?.reasonCode).toBe(outcomes.accepted);
  for (const [waitingImports, pendingTargets, reasonCode] of [[1, 0, "REMOTE_ERASURE_ACCEPTED_NOT_OBSERVED_WAITING_IMPORTS"], [0, 1, "REMOTE_ERASURE_ACCEPTED_NOT_OBSERVED_PENDING_TARGETS"]] as const) {
    f.setState({ state: "accepted", fenced: true, waitingImports, pendingTargets });
    expect((await f.marketing.assessErasure(f.context, f.subject())).obligations[2]?.reasonCode).toBe(reasonCode);
  }
  f.setState({ state: "unknown", fenced: true, pendingTargets: 0, waitingImports: 0 } as unknown as MarketingRemoteErasureCase);
  expect((await f.marketing.assessErasure(f.context, f.subject())).obligations[2]?.disposition).toBe("unresolved");
});
it.each(["unfenced", "throws"] as const)("rolls back without a receipt when fencing %s", async failure => {
  const f = fixture();
  if (failure === "unfenced") f.setState({ state: "pending", fenced: false, pendingTargets: 0, waitingImports: 0 });
  else vi.mocked(f.remote.openAndFence).mockRejectedValue(new Error("subject@example.invalid"));
  await expect(erase(f)).rejects.toThrow(failure === "unfenced" ? "marketing_privacy_fence_required" : "marketing_privacy_owner_failed");
  expect(f.context.effects).toEqual([]); expect(f.context.email).toBe("subject@example.invalid");
  expect(f.acquisition.eraseOrRetain).not.toHaveBeenCalled(); expect(f.saveReceipt).not.toHaveBeenCalled();
});
it.each(["foreign", "malformed"] as const)("refuses %s acquisition obligations before mutation", async kind => {
  const f = fixture(), rows = declared();
  if (kind === "foreign") rows[0] = { ...rows[0]!, owner: "other", resource: "other.profile" };
  else rows[0] = { ...rows[0]!, disposition: "unknown" } as unknown as PersonalDataObligation;
  vi.mocked(f.acquisition.assessErasure).mockResolvedValue({ obligations: rows });
  await expect(erase(f)).rejects.toMatchObject({ code: "PRIVACY_OWNERSHIP_UNDECLARED" });
  expect(f.remote.openAndFence).not.toHaveBeenCalled(); expect(f.acquisition.eraseOrRetain).not.toHaveBeenCalled(); expect(f.saveReceipt).not.toHaveBeenCalled();
});
