import { personalDataDocumentSchema, personalDataObligationSchema } from "../../identity/contracts/index.js";
import type { PersonalDataDocument, PersonalDataObligation, PrivacyJson } from "../../identity/contracts/index.js";

interface RiskPrivacySubject {
  contactId: string | null;
  principalId: string | null;
  identity: { [key: string]: PrivacyJson };
}
interface RiskPrivacyAssessment { obligations: PersonalDataObligation[] }
/** Structural M03 contributor; identity owns authorization, transactions and receipt replay. */
export interface RiskPrivacyContributor<Context> {
  readonly id: string;
  readonly version: string;
  readonly ownedResources: readonly string[];
  prepareErasure(context: Context): Promise<void>;
  export(context: Context, subject: RiskPrivacySubject): Promise<PersonalDataDocument>;
  assessErasure(context: Context, subject: RiskPrivacySubject): Promise<RiskPrivacyAssessment>;
  eraseOrRetain(context: Context, subject: RiskPrivacySubject, assessment: RiskPrivacyAssessment,
    actor: { principalId: string }): Promise<{ contributorId: string; version: string; obligations: PersonalDataObligation[] }>;
}

/** Logical resources cover both rails, including embedded native replay fingerprints.
 * Review cases include hold links; commerce still owns the linked hold itself.
 */
export const RISK_PRIVACY_RESOURCES = ["risk.assessments", "risk.blocklist-entries", "risk.review-cases", "risk.case-events", "risk.idempotency"] as const;
export type RiskPrivacyResource = typeof RISK_PRIVACY_RESOURCES[number];
export type RiskPrivacyReadResult = {
  resource: RiskPrivacyResource;
  status: "available" | "unavailable";
  /** Explicitly selected subject data only; unavailable resources must use null. */
  data: PrivacyJson;
};
export interface RiskPrivacyReadPort<Context> {
  /** Read-only in the identity transaction. Map resolved IDs to rail-specific order,
   * client, actor and hashed subject links; never infer ownership by equal emails.
   * Return exactly one result per logical resource, even if empty on this rail.
   * Omit secrets/credentials. Missing grants or uncertain linkage mean unavailable.
   */
  read(context: Context, subject: RiskPrivacySubject): Promise<readonly RiskPrivacyReadResult[]>;
}
export interface RiskPrivacyPolicy<Context> {
  /** Read-only, explicit owner/resource obligations for this subject and deployment.
   * Only retain or unresolved is supported. No default retention period or deletion.
   * Policy prose is not copied to exports/receipts; reasons are projected to fixed codes.
   */
  assess(context: Context, subject: RiskPrivacySubject): Promise<readonly PersonalDataObligation[]>;
}
export interface RiskPrivacyDependencies<Context> {
  data: RiskPrivacyReadPort<Context> | null;
  policy: RiskPrivacyPolicy<Context> | null;
}
const id = "risk", version = "risk.personal-data.v1";
function obligation(resource: string, disposition: "retain" | "unresolved", reasonCode: string): PersonalDataObligation {
  return { owner: id, resource, disposition, reasonCode, remote: false };
}
function unavailable(): PersonalDataObligation[] {
  return RISK_PRIVACY_RESOURCES.map(resource => obligation(resource, "unresolved", "RISK_OWNER_UNAVAILABLE"));
}
function policyObligations(value: unknown): PersonalDataObligation[] {
  if (!Array.isArray(value) || value.length !== RISK_PRIVACY_RESOURCES.length) return unavailable();
  const parsed = value.map(row => personalDataObligationSchema.safeParse(row));
  if (parsed.some(row => !row.success)) return unavailable();
  const rows = parsed.flatMap(row => row.success ? [row.data] : []);
  if (rows.some(row => row.owner !== id || row.remote || row.disposition === "erase")
    || RISK_PRIVACY_RESOURCES.some(resource => rows.filter(row => row.resource === resource).length !== 1)) return unavailable();
  return RISK_PRIVACY_RESOURCES.map(resource => {
    const row = rows.find(item => item.resource === resource)!;
    return obligation(resource, row.disposition === "retain" ? "retain" : "unresolved",
      row.disposition === "retain" ? "RISK_POLICY_RETENTION" : "RISK_POLICY_UNRESOLVED");
  });
}
async function ownerCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch { throw new Error("risk_privacy_owner_failed"); }
}

/** Bounded read/retention contributor: never deletes audit, replay, hash or hold facts. */
export function createRiskPrivacyContributor<Context>(input: RiskPrivacyDependencies<Context>): RiskPrivacyContributor<Context> {
  const { data, policy } = input;
  async function assess(context: Context, subject: RiskPrivacySubject): Promise<PersonalDataObligation[]> {
    if (!data || !policy) return unavailable();
    return policyObligations(await ownerCall(() => policy.assess(context, subject)));
  }
  return {
    id, version, ownedResources: Object.freeze([...RISK_PRIVACY_RESOURCES]),
    async prepareErasure() {},
    async export(context, subject) {
      const rows = data ? await ownerCall(() => data.read(context, subject)) : null;
      // Reject malformed/partial ownership rather than presenting an empty complete export.
      if (rows !== null && (!Array.isArray(rows) || rows.length !== RISK_PRIVACY_RESOURCES.length
        || RISK_PRIVACY_RESOURCES.some(resource => rows.filter(row => row?.resource === resource).length !== 1)
        || rows.some(row => !row || !["available", "unavailable"].includes(row.status)
          || (row.status === "unavailable" && row.data !== null)))) throw new Error("risk_privacy_coverage_invalid");
      const included = rows?.filter(row => row.status === "available").map(row => row.resource) ?? [];
      const document = personalDataDocumentSchema.safeParse({ contributorId: id, version,
        data: Object.fromEntries(rows?.filter(row => row.status === "available").map(row => [row.resource, row.data]) ?? []),
        coverage: { complete: included.length === RISK_PRIVACY_RESOURCES.length, included,
          unavailable: RISK_PRIVACY_RESOURCES.filter(resource => !included.includes(resource)) },
        obligations: await assess(context, subject) });
      if (!document.success) throw new Error("risk_privacy_export_invalid");
      return document.data;
    },
    async assessErasure(context, subject) { return { obligations: await assess(context, subject) }; },
    async eraseOrRetain(_context, _subject, assessment) {
      const obligations = policyObligations(assessment.obligations);
      if (!data || !policy || obligations.some(row => row.disposition !== "retain")) throw new Error("risk_privacy_retention_unresolved");
      return { contributorId: id, version, obligations };
    },
  };
}
