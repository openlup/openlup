/** Structural privacy contracts: identity owns validation, authorization and orchestration. */
export type AccountEventPrivacyJson = null | boolean | number | string | AccountEventPrivacyJson[] | { [key: string]: AccountEventPrivacyJson };
export interface AccountEventPrivacyObligation { owner: string; resource: string; disposition: "erase" | "retain" | "unresolved"; reasonCode: string; remote: boolean }
export interface AccountEventPrivacyDocument { contributorId: string; version: string; data: AccountEventPrivacyJson; coverage: { complete: boolean; included: string[]; unavailable: string[] }; obligations: AccountEventPrivacyObligation[] }
export interface AccountEventPrivacySubject { contactId: string | null; principalId: string | null; identity: { [key: string]: AccountEventPrivacyJson } }
export interface AccountEventPrivacyAssessment { obligations: AccountEventPrivacyObligation[] }
/** Structural identity contributor; authorization and transaction ownership remain in identity. */
export interface AccountEventPrivacyContributor<Context> {
  id: string; version: string; ownedResources: readonly string[];
  prepareErasure(context: Context): Promise<void>;
  export(context: Context, subject: AccountEventPrivacySubject): Promise<AccountEventPrivacyDocument>;
  assessErasure(context: Context, subject: AccountEventPrivacySubject): Promise<AccountEventPrivacyAssessment>;
  eraseOrRetain(context: Context, subject: AccountEventPrivacySubject, assessment: AccountEventPrivacyAssessment, actor: { principalId: string }): Promise<{ contributorId: string; version: string; obligations: AccountEventPrivacyObligation[] }>;
}
export interface AccountEventPrivacyDependencies<Context> {
  /** Explicit privileged subject reader, including payloads. No customer-history or census grant implies this access. */
  read: null | ((context: Context, subject: AccountEventPrivacySubject) => Promise<{ available: boolean; data: AccountEventPrivacyJson }>);
  /** Only explicit retention or unresolved policy; no automatic retention period or deletion. */
  assess: null | ((context: Context, subject: AccountEventPrivacySubject) => Promise<"retain" | "unresolved">);
}
export function createAccountEventPrivacyContributor<Context>(input: AccountEventPrivacyDependencies<Context>): AccountEventPrivacyContributor<Context> {
  const id = "account-support", version = "account-support.personal-data.v1", resource = "account-support.account-events";
  const { read, assess } = input;
  const obligation = (retained: boolean): AccountEventPrivacyObligation => ({ owner: id, resource, disposition: retained ? "retain" : "unresolved",
    reasonCode: retained ? "ACCOUNT_EVENT_POLICY_RETENTION" : "ACCOUNT_EVENT_OWNER_UNAVAILABLE", remote: false });
  const assessment = async (context: Context, subject: AccountEventPrivacySubject) => ({ obligations: [obligation(Boolean(read && assess && await assess(context, subject) === "retain"))] });
  return {
    id, version, ownedResources: [resource], async prepareErasure() {},
    async export(context, subject) {
      const result = read ? await read(context, subject) : null;
      return { contributorId: id, version, data: result?.available ? result.data : null,
        coverage: { complete: result?.available === true, included: result?.available ? [resource] : [], unavailable: result?.available ? [] : [resource] },
        ...(await assessment(context, subject)) };
    },
    assessErasure: assessment,
    async eraseOrRetain(_context, _subject, value) {
      if (!read || !assess || value.obligations.length !== 1 || value.obligations[0]?.owner !== id || value.obligations[0]?.resource !== resource
        || value.obligations[0]?.disposition !== "retain" || value.obligations[0]?.remote !== false) throw new Error("account_event_privacy_unresolved");
      return { contributorId: id, version, obligations: [obligation(true)] };
    },
  };
}
