import type { PrivacySubjectRef, PrivacyExport, ErasureReceipt, PersonalDataDocument, PersonalDataObligation, PrivacyJson, PrivacyRefusalCode } from "./contracts/privacy.js";

export class PrivacyRefusal extends Error {
  constructor(readonly code: PrivacyRefusalCode) { super(code); this.name = "PrivacyRefusal"; }
}
export interface AuthorizedHumanAdministrator { principalId: string }
export interface ResolvedPrivacySubject {
  contactId: string | null;
  principalId: string | null;
  /** Only explicitly selected identity fields; never credentials. */
  identity: { [key: string]: PrivacyJson };
}
export interface ErasureAssessment { obligations: PersonalDataObligation[] }
export interface ContributorDisposition { contributorId: string; version: string; obligations: PersonalDataObligation[] }
export interface PersonalDataContributor<Context> {
  readonly id: string;
  readonly version: string;
  readonly ownedResources: readonly string[];
  prepareErasure(context: Context): Promise<void>;
  export(context: Context, subject: ResolvedPrivacySubject): Promise<PersonalDataDocument>;
  assessErasure(context: Context, subject: ResolvedPrivacySubject): Promise<ErasureAssessment>;
  eraseOrRetain(context: Context, subject: ResolvedPrivacySubject, assessment: ErasureAssessment, actor: AuthorizedHumanAdministrator): Promise<ContributorDisposition>;
}
export interface PersonalDataContributorRegistry<Context> {
  readonly contributors: readonly PersonalDataContributor<Context>[];
  readonly missingContributors: readonly string[];
}
export interface PrivacyUnitOfWork<Context> { run<T>(work: (context: Context) => Promise<T>): Promise<T> }
export interface PrivacyStore<Context> {
  readonly erasureSupported: boolean;
  prepareErasure(context: Context): Promise<void>;
  authorizeErasure(context: Context, actor: AuthorizedHumanAdministrator): Promise<void>;
  resolve(context: Context, subject: PrivacySubjectRef, actor?: AuthorizedHumanAdministrator): Promise<ResolvedPrivacySubject | null>;
  findReceipt(context: Context, subject: PrivacySubjectRef, key?: string): Promise<ErasureReceipt | null>;
  eraseIdentity(context: Context, subject: ResolvedPrivacySubject, actor: AuthorizedHumanAdministrator, pseudonym: string): Promise<void>;
  saveReceipt(context: Context, subject: ResolvedPrivacySubject, actor: AuthorizedHumanAdministrator, key: string, receipt: ErasureReceipt, dispositions: ContributorDisposition[]): Promise<void>;
}
export interface PrivacyUseCaseDependencies<Context> {
  unitOfWork: PrivacyUnitOfWork<Context>;
  registry: PersonalDataContributorRegistry<Context>;
  store: PrivacyStore<Context>;
  now(): Date;
  randomId(): string;
}
export interface PrivacyOperations {
  export(actor: AuthorizedHumanAdministrator, subject: PrivacySubjectRef): Promise<PrivacyExport>;
  erase(actor: AuthorizedHumanAdministrator, input: { subject: PrivacySubjectRef; idempotencyKey: string }): Promise<ErasureReceipt>;
}
/** A host may compose this only after a committed local erasure; never delete an identity. */
export interface ProviderIdentityErasurePort {
  disableIdentity(input: { principalId: string; committedErasureId: string }): Promise<{ status: "disabled" | "already_disabled" }>;
}
