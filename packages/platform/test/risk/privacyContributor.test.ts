import { expect, it, vi } from "vitest";
import type { PersonalDataObligation, PrivacyJson } from "../../src/identity/contracts/index.js";
import { createRiskPrivacyContributor, RISK_PRIVACY_RESOURCES,
  type RiskPrivacyDependencies, type RiskPrivacyReadResult } from "../../src/risk/server/index.js";

const subject = { contactId: "00000000-0000-4000-8000-000000000001",
  principalId: "00000000-0000-4000-8000-000000000002", identity: { email: "person@example.invalid" } };
const actor = { principalId: "00000000-0000-4000-8000-000000000003" };
type Context = { effects: string[] };
const obligations = (): PersonalDataObligation[] => RISK_PRIVACY_RESOURCES.map(resource => ({ owner: "risk", resource,
  disposition: "retain", reasonCode: "DEPLOYMENT_POLICY", remote: false }));
function fixture() {
  const context: Context = { effects: [] };
  const read = vi.fn(async (): Promise<RiskPrivacyReadResult[]> => RISK_PRIVACY_RESOURCES.map(resource => ({
    resource, status: "available", data: [{ subjectRef: subject.contactId, resource }],
  })));
  const assess = vi.fn(async () => obligations());
  const deps: RiskPrivacyDependencies<Context> = { data: { read }, policy: { assess } };
  return { context, read, assess, deps, contributor: createRiskPrivacyContributor(deps) };
}

it.each(["data", "policy"] as const)("keeps a missing %s owner unresolved", async missing => {
  const f = fixture(), contributor = createRiskPrivacyContributor({ ...f.deps, [missing]: null });
  const assessment = await contributor.assessErasure(f.context, subject);
  expect(assessment.obligations).toHaveLength(5);
  expect(assessment.obligations.every(row => row.disposition === "unresolved" && row.reasonCode === "RISK_OWNER_UNAVAILABLE")).toBe(true);
  await expect(contributor.eraseOrRetain(f.context, subject, assessment, actor)).rejects.toThrow("risk_privacy_retention_unresolved");
  const document = await contributor.export(f.context, subject);
  if (missing === "data") expect(document.coverage).toEqual({ complete: false, included: [], unavailable: [...RISK_PRIVACY_RESOURCES] });
  expect(f.assess).not.toHaveBeenCalled(); expect(f.context.effects).toEqual([]);
});

it.each(["foreign", "malformed", "incomplete"] as const)("refuses %s policy ownership without erasure", async failure => {
  const f = fixture(), rows = obligations();
  if (failure === "foreign") rows[0] = { ...rows[0]!, owner: "other" };
  if (failure === "malformed") rows[0] = { ...rows[0]!, disposition: "erase" };
  if (failure === "incomplete") rows[0] = { ...rows[1]! }; // duplicate cannot replace missing coverage
  f.assess.mockResolvedValue(rows);
  const assessment = await f.contributor.assessErasure(f.context, subject);
  expect(assessment.obligations.every(row => row.disposition === "unresolved")).toBe(true);
  await expect(f.contributor.eraseOrRetain(f.context, subject, assessment, actor)).rejects.toThrow("risk_privacy_retention_unresolved");
  expect(f.context.effects).toEqual([]);
});

it("rejects incomplete read coverage and reports an explicitly unavailable resource", async () => {
  const f = fixture();
  f.read.mockResolvedValue([{ resource: "risk.assessments", status: "available", data: [] }]);
  await expect(f.contributor.export(f.context, subject)).rejects.toThrow("risk_privacy_coverage_invalid");
  f.read.mockResolvedValue(RISK_PRIVACY_RESOURCES.map(resource => ({ resource,
    status: resource === "risk.idempotency" ? "unavailable" : "available", data: resource === "risk.idempotency" ? null : [] })));
  const document = await f.contributor.export(f.context, subject);
  expect(document.coverage).toEqual({ complete: false, included: RISK_PRIVACY_RESOURCES.slice(0, 4), unavailable: ["risk.idempotency"] });
  expect(Object.keys(document.data as object)).not.toContain("risk.idempotency");
});

it("refuses nested credentials and sanitizes owner errors", async () => {
  const f = fixture();
  f.read.mockResolvedValue(RISK_PRIVACY_RESOURCES.map(resource => ({ resource, status: "available", data: { nested: { access_token: "sensitive" } } })));
  await expect(f.contributor.export(f.context, subject)).rejects.toThrow("risk_privacy_export_invalid");
  f.read.mockRejectedValue(new Error("person@example.invalid"));
  await expect(f.contributor.export(f.context, subject)).rejects.toThrow(/^risk_privacy_owner_failed$/);
  f.assess.mockRejectedValue(new Error("sensitive"));
  await expect(f.contributor.assessErasure(f.context, subject)).rejects.toThrow(/^risk_privacy_owner_failed$/);
});

it("passes resolved identity and the transaction to read-only owners without selecting mutation", async () => {
  const f = fixture();
  await f.contributor.prepareErasure(f.context);
  expect(f.read).not.toHaveBeenCalled(); expect(f.assess).not.toHaveBeenCalled();
  const document = await f.contributor.export(f.context, subject);
  expect(f.read).toHaveBeenCalledExactlyOnceWith(f.context, subject);
  expect(f.assess).toHaveBeenCalledExactlyOnceWith(f.context, subject);
  expect(document.coverage).toEqual({ complete: true, included: [...RISK_PRIVACY_RESOURCES], unavailable: [] });
  expect((document.data as Record<string, PrivacyJson>)["risk.case-events"]).toEqual([{ subjectRef: subject.contactId, resource: "risk.case-events" }]);
  expect(f.context.effects).toEqual([]);
});

it("retains audit, replay, hashes and hold links only under explicit policy with content-free reasons", async () => {
  const f = fixture();
  f.assess.mockResolvedValue(obligations().map(row => ({ ...row, reasonCode: "person@example.invalid" })));
  const assessment = await f.contributor.assessErasure(f.context, subject);
  const result = await f.contributor.eraseOrRetain(f.context, subject, assessment, actor);
  expect(result).toEqual({ contributorId: "risk", version: "risk.personal-data.v1", obligations: obligations().map(row => ({ ...row, reasonCode: "RISK_POLICY_RETENTION" })) });
  expect(JSON.stringify(result)).not.toContain("person@example.invalid");
  expect(f.read).not.toHaveBeenCalled(); expect(f.assess).toHaveBeenCalledTimes(1);
  expect(f.context.effects).toEqual([]);
});

it("keeps a policy's unresolved resource visible and refuses incomplete disposition", async () => {
  const f = fixture(), rows = obligations();
  rows[3] = { ...rows[3]!, disposition: "unresolved" }; f.assess.mockResolvedValue(rows);
  const document = await f.contributor.export(f.context, subject);
  expect(document.obligations[3]).toMatchObject({ resource: "risk.case-events", disposition: "unresolved", reasonCode: "RISK_POLICY_UNRESOLVED" });
  await expect(f.contributor.eraseOrRetain(f.context, subject, { obligations: document.obligations }, actor)).rejects.toThrow("risk_privacy_retention_unresolved");
  await expect(f.contributor.eraseOrRetain(f.context, subject, { obligations: obligations().slice(1) }, actor)).rejects.toThrow("risk_privacy_retention_unresolved");
});
