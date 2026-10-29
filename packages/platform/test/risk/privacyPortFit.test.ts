import { expect, it, vi } from "vitest";
import { createPersonalDataContributorRegistry, createPrivacyOperations, PrivacyRefusal,
  type PersonalDataContributor, type PrivacyStore, type ResolvedPrivacySubject } from "../../src/identity/index.js";
import type { ErasureReceipt } from "../../src/identity/contracts/index.js";
import { createRiskPrivacyBinding, RISK_PRIVACY_RESOURCES } from "../../src/risk/server/index.js";

type Context = { effects: string[] };
const contactId = "00000000-0000-4000-8000-000000000001", principalId = "00000000-0000-4000-8000-000000000002";
const actor = { principalId: "00000000-0000-4000-8000-000000000003" };
const key = "00000000-0000-4000-8000-000000000004";
const subjectRef = { kind: "contact" as const, contactId };
const subject: ResolvedPrivacySubject = { contactId, principalId, identity: {} };
function fixture() {
  const context: Context = { effects: [] };
  let receipt: ErasureReceipt | null = null;
  const read = vi.fn(async () => RISK_PRIVACY_RESOURCES.map(resource => ({ resource, status: "available" as const, data: [] })));
  const assess = vi.fn(async () => RISK_PRIVACY_RESOURCES.map(resource => ({ owner: "risk", resource, disposition: "retain" as const,
    reasonCode: "HOST_POLICY", remote: false })));
  const binding = createRiskPrivacyBinding({ data: { read }, policy: { assess } });
  // Compiler and runtime witness against M03's real interface and registry, not a parallel registry.
  const risk: PersonalDataContributor<Context> = binding.contributor;
  const identity: PersonalDataContributor<Context> = { id: "identity", version: "identity.personal-data.v1", ownedResources: ["identity.profile"],
    async prepareErasure() {}, async export() { return { contributorId: "identity", version: "identity.personal-data.v1", data: {},
      coverage: { complete: true, included: ["identity.profile"], unavailable: [] }, obligations: [] }; },
    async assessErasure() { return { obligations: [] }; },
    async eraseOrRetain(tx) { tx.effects.push("identity"); return { contributorId: "identity", version: "identity.personal-data.v1", obligations: [] }; } };
  const registry = createPersonalDataContributorRegistry([identity, risk], { requiredContributorIds: ["identity", "risk"] });
  const resolve = vi.fn(async (): Promise<ResolvedPrivacySubject | null> => subject);
  const authorizeErasure = vi.fn(async () => {});
  const saveReceipt = vi.fn(async (_tx: Context, _subject: ResolvedPrivacySubject, _actor: unknown, _key: string, value: ErasureReceipt) => { receipt = value; });
  const store: PrivacyStore<Context> = { erasureSupported: true, async prepareErasure() {}, authorizeErasure, resolve,
    async findReceipt() { return receipt; }, async eraseIdentity() {}, saveReceipt };
  const unitOfWork = { async run<T>(work: (tx: Context) => Promise<T>): Promise<T> {
    const before = [...context.effects], previousReceipt = receipt;
    try { return await work(context); } catch (error) { context.effects = before; receipt = previousReceipt; throw error; }
  } };
  const run = vi.spyOn(unitOfWork, "run");
  const operations = createPrivacyOperations({ registry, store, unitOfWork, now: () => new Date(0), randomId: () => key });
  return { context, binding, risk, registry, read, assess, store, resolve, authorizeErasure, saveReceipt, run, operations };
}
const erase = (f: ReturnType<typeof fixture>) => f.operations.erase(actor, { subject: subjectRef, idempotencyKey: key });

it("registers through M03 and defers portability unless the host supplies an opaque binding", async () => {
  const f = fixture();
  expect(f.registry.missingContributors).toEqual([]); expect(f.registry.contributors[1]).toBe(f.risk);
  const document = (await f.operations.export(actor, subjectRef)).documents[1]!;
  expect(document.contributorId).toBe("risk"); expect(document.obligations).toHaveLength(5);
  expect(f.binding.portability).toEqual({ status: "deferred" });
  const transfer = vi.fn(), host = { transfer };
  const selected = createRiskPrivacyBinding({ data: null, policy: null, portability: host });
  expect(selected.portability).toEqual({ status: "host-bound", binding: host });
  if (selected.portability.status === "host-bound") expect(selected.portability.binding).toBe(host);
  expect(transfer).not.toHaveBeenCalled();
  const missing = createPersonalDataContributorRegistry([f.registry.contributors[0]!], { requiredContributorIds: ["identity", "risk"] });
  expect(missing.missingContributors).toEqual(["risk"]);
});

it.each(["authorization", "subject"] as const)("preserves M03 %s refusal before risk assessment", async failure => {
  const f = fixture();
  if (failure === "authorization") f.authorizeErasure.mockRejectedValue(new PrivacyRefusal("PRIVACY_PROTECTED_OPERATOR"));
  else f.resolve.mockResolvedValue(null);
  await expect(erase(f)).rejects.toMatchObject({ code: failure === "authorization" ? "PRIVACY_PROTECTED_OPERATOR" : "PRIVACY_SUBJECT_NOT_FOUND" });
  expect(f.read).not.toHaveBeenCalled(); expect(f.assess).not.toHaveBeenCalled();
  expect(f.context.effects).toEqual([]); expect(f.saveReceipt).not.toHaveBeenCalled();
});

it("preserves managed erasure refusal before the transaction or risk owner calls", async () => {
  const f = fixture(); Object.assign(f.store, { erasureSupported: false });
  await expect(erase(f)).rejects.toMatchObject({ code: "MANAGED_PRIVACY_ERASURE_UNAVAILABLE" });
  expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.assess).not.toHaveBeenCalled();
  expect(f.saveReceipt).not.toHaveBeenCalled();
});

it("rolls identity work back if the shared transaction cannot save its risk dispositions", async () => {
  const f = fixture(); f.saveReceipt.mockRejectedValue(new Error("receipt_failed"));
  await expect(erase(f)).rejects.toThrow("receipt_failed");
  expect(f.context.effects).toEqual([]);
  f.saveReceipt.mockClear(); f.saveReceipt.mockImplementation(async () => {});
  await expect(erase(f)).resolves.toMatchObject({ outcome: "ERASED" });
  expect(f.assess).toHaveBeenCalledTimes(2); expect(f.context.effects).toEqual(["identity"]);
});

it("keeps explicit retained obligations on the receipt and replays without another risk assessment", async () => {
  const f = fixture(), receipt = await erase(f);
  expect(receipt.obligations).toEqual(RISK_PRIVACY_RESOURCES.map(resource => ({ owner: "risk", resource, disposition: "retain",
    reasonCode: "RISK_POLICY_RETENTION", remote: false })));
  await expect(erase(f)).resolves.toEqual({ ...receipt, outcome: "ALREADY_ERASED" });
  expect(f.assess).toHaveBeenCalledTimes(1); expect(f.saveReceipt).toHaveBeenCalledTimes(1);
  expect(f.context.effects).toEqual(["identity"]); expect(f.read).not.toHaveBeenCalled();
});
