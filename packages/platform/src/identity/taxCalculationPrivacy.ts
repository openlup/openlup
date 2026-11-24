import type { PgQueryExecutor } from "../data/index.js";
import type { PersonalDataContributor } from "./privacyPorts.js";
import type { PersonalDataObligation, PrivacyJson } from "./contracts/privacy.js";

const id = "tax-calculations", version = "commerce.tax-calculations.v1";
const obligations = (): PersonalDataObligation[] => [
  { owner: id, resource: "tax-evaluation-subject-evidence", disposition: "erase", reasonCode: "PRIVATE_TAX_EVALUATION_EVIDENCE", remote: false },
  { owner: id, resource: "tax-evaluation-provider-uniqueness", disposition: "retain", reasonCode: "PSEUDONYMOUS_ERASURE_FENCE", remote: false },
];
async function installed(db: PgQueryExecutor): Promise<boolean> {
  return (await db.query("SELECT to_regclass('public.tax_calculations') IS NOT NULL AS installed")).rows[0]?.installed !== false;
}

/** @experimental Native tax evaluation privacy. */
export function createTaxCalculationPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  return {
    id, version, ownedResources: obligations().map(({ resource }) => resource),
    async prepareErasure() {},
    async export(db, subject) {
      const present = await installed(db);
      const data = (present && subject.contactId
        ? (await db.query("SELECT public.tax_calculation_export_v1($1::uuid) AS data", [subject.contactId])).rows[0]?.data : []) as { [key: string]: PrivacyJson }[];
      const unavailable = data.some(row => Object.hasOwn(row, "verification"))
        ? ["Recover the verified original evaluation through its owner."] : [];
      return { contributorId: id, version, data, obligations: present ? obligations() : [],
        coverage: { complete: unavailable.length === 0, included: present ? ["tax evaluation status and verified outcome"] : [], unavailable } };
    },
    async assessErasure(db) { return { obligations: await installed(db) ? obligations() : [] }; },
    async eraseOrRetain(db, subject, assessment) {
      if (assessment.obligations.length && subject.contactId) await db.query("SELECT public.tax_calculation_erase_v1($1::uuid)", [subject.contactId]);
      return { contributorId: id, version, obligations: assessment.obligations };
    },
  };
}
