import { personalDataObligationSchema } from "../../identity/contracts/index.js";
import type { PersonalDataDocument, PersonalDataObligation, PrivacyJson } from "../../identity/contracts/index.js";

interface AuthorizedHumanAdministrator { principalId: string }
interface ResolvedPrivacySubject {
  contactId: string | null;
  principalId: string | null;
  identity: { [key: string]: PrivacyJson };
}
interface ErasureAssessment { obligations: PersonalDataObligation[] }
/** Structural identity contributor contract without selecting identity's server adapters. */
export interface MarketingPrivacyContributor<Context> {
  readonly id: string;
  readonly version: string;
  readonly ownedResources: readonly string[];
  prepareErasure(context: Context): Promise<void>;
  export(context: Context, subject: ResolvedPrivacySubject): Promise<PersonalDataDocument>;
  assessErasure(context: Context, subject: ResolvedPrivacySubject): Promise<ErasureAssessment>;
  eraseOrRetain(context: Context, subject: ResolvedPrivacySubject, assessment: ErasureAssessment, actor: AuthorizedHumanAdministrator): Promise<{
    contributorId: string; version: string; obligations: PersonalDataObligation[];
  }>;
}

export interface MarketingAcquisitionPrivacyPort<Context> {
  export(context: Context, subject: ResolvedPrivacySubject): Promise<{ records: PrivacyJson; evidence: PrivacyJson; obligations: PersonalDataObligation[] }>;
  /** Read-only; declare both local resources, including explicit retention policy. */
  assessErasure(context: Context, subject: ResolvedPrivacySubject): Promise<ErasureAssessment>;
  eraseOrRetain(context: Context, subject: ResolvedPrivacySubject, assessment: ErasureAssessment, actor: AuthorizedHumanAdministrator): Promise<ErasureAssessment>;
}
export interface MarketingRemoteErasureCase {
  state: "pending" | "requested" | "accepted" | "failed" | "not_bound";
  fenced: boolean;
  pendingTargets: number;
  waitingImports: number;
}
export interface MarketingRemoteErasurePort<Context> {
  /** Read-only subject lookup; return no addresses or provider references. */
  read(context: Context, subject: ResolvedPrivacySubject): Promise<MarketingRemoteErasureCase | null>;
  /** Authorized transaction: atomically fence against recreation and record the case, replay-safe per caseId.
   * In-flight imports and late-import orphan targets remain the case owner's obligations.
   */
  openAndFence(context: Context, input: { caseId: string; subject: ResolvedPrivacySubject; actor: AuthorizedHumanAdministrator; openedAt: string }): Promise<MarketingRemoteErasureCase>;
}
export interface MarketingPrivacyDependencies<Context> {
  acquisition: MarketingAcquisitionPrivacyPort<Context> | null;
  remoteErasure: MarketingRemoteErasurePort<Context> | null;
  now?: () => Date;
  randomId(): string;
}
const localResources = ["marketing.acquisition-records", "marketing.acquisition-evidence"] as const;
const remoteResource = "marketing.remote-profile";
const id = "marketing", version = "marketing.personal-data.v1";
function obligation(resource: string, disposition: PersonalDataObligation["disposition"], reasonCode: string): PersonalDataObligation {
  return { owner: id, resource, disposition, reasonCode, remote: resource === remoteResource };
}
function unresolved(resource: string): PersonalDataObligation { return obligation(resource, "unresolved", "MARKETING_OWNER_UNAVAILABLE"); }
function localObligations(value: unknown): PersonalDataObligation[] {
  const invalid = () => localResources.map(unresolved);
  if (!Array.isArray(value) || value.length !== localResources.length) return invalid();
  const parsed = value.map(item => personalDataObligationSchema.safeParse(item));
  if (parsed.some(item => !item.success)) return invalid();
  const rows = parsed.map(item => { if (!item.success) throw new Error("marketing_obligation_invalid"); return item.data; });
  if (rows.some(row => row.owner !== id || row.remote || !localResources.some(resource => resource === row.resource))
    || localResources.some(resource => rows.filter(row => row.resource === resource).length !== 1)) return invalid();
  // Owner text is never echoed into receipts; only closed, content-free reasons cross this boundary.
  return rows.map(row => obligation(row.resource, row.disposition, row.disposition === "erase" ? "LOCAL_OWNER_ERASURE"
    : row.disposition === "retain" ? "LOCAL_OWNER_RETENTION" : "MARKETING_OWNER_UNAVAILABLE"));
}
function validCase(value: MarketingRemoteErasureCase): boolean {
  return !!value && ["pending", "requested", "accepted", "failed", "not_bound"].includes(value.state)
    && typeof value.fenced === "boolean" && Number.isSafeInteger(value.pendingTargets) && value.pendingTargets >= 0
    && Number.isSafeInteger(value.waitingImports) && value.waitingImports >= 0;
}
function remoteObligation(value: MarketingRemoteErasureCase | null): PersonalDataObligation {
  if (value === null) return obligation(remoteResource, "retain", "REMOTE_ERASURE_NOT_REQUESTED");
  if (!validCase(value)) return unresolved(remoteResource);
  const reasons = { pending: "REMOTE_ERASURE_PENDING", requested: "REMOTE_ERASURE_REQUESTED", accepted: "REMOTE_ERASURE_ACCEPTED_NOT_OBSERVED",
    failed: "REMOTE_ERASURE_FAILED", not_bound: value.fenced ? "REMOTE_ERASURE_NOT_BOUND_LOCAL_FENCE_ONLY" : "REMOTE_ERASURE_NOT_BOUND" };
  return obligation(remoteResource, "retain", `${reasons[value.state]}${value.waitingImports > 0 ? "_WAITING_IMPORTS" : ""}${value.pendingTargets > 0 ? "_PENDING_TARGETS" : ""}`);
}
async function ownerCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch { throw new Error("marketing_privacy_owner_failed"); }
}

/** Identity orchestrates authorization, assessment, transaction rollback and receipt replay. */
export function createMarketingPrivacyContributor<Context>(input: MarketingPrivacyDependencies<Context>): MarketingPrivacyContributor<Context> {
  // Partial ownership cannot establish coverage or permit any erasure effects.
  const acquisition = input.acquisition && input.remoteErasure ? input.acquisition : null;
  const remoteErasure = acquisition ? input.remoteErasure : null;
  const { randomId } = input, now = input.now ?? (() => new Date());
  return {
    id, version, ownedResources: [...localResources, remoteResource],
    async prepareErasure() {},
    async export(context, subject) {
      const local = acquisition ? await ownerCall(() => acquisition.export(context, subject)) : null;
      const remote = remoteErasure ? await ownerCall(() => remoteErasure.read(context, subject)) : null;
      const validRemote = remote === null || validCase(remote);
      return { contributorId: id, version, data: { acquisition: local ? { records: local.records, evidence: local.evidence } : null,
        remoteProfile: { state: validRemote ? remote?.state ?? null : null } },
      coverage: { complete: false, included: local ? [...localResources] : [], unavailable: [...(local ? [] : localResources), remoteResource] },
      obligations: [...(local ? localObligations(local.obligations) : localResources.map(unresolved)),
        remoteErasure ? remoteObligation(remote) : unresolved(remoteResource)] };
    },
    async assessErasure(context, subject) {
      const local = acquisition ? await ownerCall(() => acquisition.assessErasure(context, subject)) : null;
      const remote = remoteErasure ? await ownerCall(() => remoteErasure.read(context, subject)) : null;
      return { obligations: [...(local ? localObligations(local.obligations) : localResources.map(unresolved)),
        remoteErasure ? remoteObligation(remote) : unresolved(remoteResource)] };
    },
    async eraseOrRetain(context, subject, assessment, actor) {
      if (!acquisition || !remoteErasure || assessment.obligations.some(row => row.disposition === "unresolved")) throw new Error("marketing_privacy_unbound");
      // Identity receipt replay bypasses contributors. Rolled-back attempts may use a fresh ID;
      // the owner atomically reuses the subject fence and deduplicates each case ID.
      const remote = await ownerCall(() => remoteErasure.openAndFence(context, { caseId: randomId(), subject, actor, openedAt: now().toISOString() }));
      if (!validCase(remote) || remote.fenced !== true) throw new Error("marketing_privacy_fence_required");
      const local = await ownerCall(() => acquisition.eraseOrRetain(context, subject,
        { obligations: assessment.obligations.filter(row => localResources.some(resource => resource === row.resource)) }, actor));
      const obligations = localObligations(local.obligations);
      if (obligations.some(row => row.disposition === "unresolved")) throw new Error("marketing_privacy_disposition_invalid");
      return { contributorId: id, version, obligations: [...obligations, remoteObligation(remote)] };
    },
  };
}
