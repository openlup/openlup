import type { PersonalDataObligation, PrivacyJson } from "./contracts/privacy.js";
import { PrivacyRefusal, type PersonalDataContributor, type PrivacyStore } from "./privacyPorts.js";

export interface IdentityPrivacyPolicy {
  /** Explicit dispositions for populated opaque contact fields; absence refuses erasure. */
  retainedContactFields: Readonly<Record<string, PersonalDataObligation>>;
}
const owned = new Set(["id", "email", "first_name", "last_name", "phone", "country", "principal_id", "created_at", "updated_at"]);
const populated = (value: PrivacyJson) => value !== null && value !== "" && !(typeof value === "object" && Object.keys(value).length === 0);
export function createIdentityPersonalDataContributor<C>(store: PrivacyStore<C>, policy: IdentityPrivacyPolicy, randomId: () => string): PersonalDataContributor<C> {
  function obligations(identity: { [key: string]: PrivacyJson }): PersonalDataObligation[] {
    const contact = identity.contact;
    const result: PersonalDataObligation[] = [{ owner: "identity", resource: "identity.audit-and-receipt", disposition: "retain", reasonCode: "PSEUDONYMOUS_AUDIT", remote: false }];
    if (contact && typeof contact === "object" && !Array.isArray(contact)) {
      for (const [key, value] of Object.entries(contact)) {
        if (owned.has(key) || !populated(value)) continue;
        const declaration = policy.retainedContactFields[key];
        result.push(declaration?.disposition === "retain" && declaration.resource === `clients.${key}` ? declaration : { owner: "unassigned", resource: `clients.${key}`, disposition: "unresolved", reasonCode: "PRIVACY_OWNERSHIP_UNDECLARED", remote: false });
      }
    }
    return result;
  }
  return {
    id: "identity", version: "identity.personal-data.v1",
    ownedResources: ["identity.contact-profile", "identity.principal", "identity.membership", "identity.invitations", "identity.audit-and-receipt"],
    async prepareErasure() {},
    async export(_context, subject) {
      const unavailable = Array.isArray(subject.identity.unavailable) ? subject.identity.unavailable.map(String) : [];
      const data = { ...subject.identity };
      const contact = data.contact;
      if (contact && typeof contact === "object" && !Array.isArray(contact)) {
        data.contact = Object.fromEntries(Object.entries(contact).filter(([key]) => owned.has(key) || key === "auth_user_id"));
        for (const key of Object.keys(contact)) if (!owned.has(key) && key !== "auth_user_id") unavailable.push(`contact.${key}`);
      }
      return { contributorId: "identity", version: "identity.personal-data.v1", data,
        coverage: { complete: unavailable.length === 0, included: Object.keys(subject.identity).filter(k => k !== "unavailable"), unavailable }, obligations: obligations(subject.identity) };
    },
    async assessErasure(_context, subject) {
      const declared = obligations(subject.identity);
      if (declared.some(o => o.disposition === "unresolved")) throw new PrivacyRefusal("PRIVACY_OWNERSHIP_UNDECLARED");
      return { obligations: declared };
    },
    async eraseOrRetain(context, subject, assessment, actor) {
      await store.eraseIdentity(context, subject, actor, `erased+${randomId()}@identity.invalid`);
      return { contributorId: "identity", version: "identity.personal-data.v1", obligations: assessment.obligations };
    },
  };
}
