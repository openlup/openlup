// Private helpers/symbols, never exported. Brands are not serialization authority.
declare const subjectBrand: unique symbol, feedbackBrand: unique symbol,
  receiptBrand: unique symbol, readBrand: unique symbol;
type Operation = "profile.sync" | "consent.read" | "erasure.request" | "erasure.read";
type Mutation = "profile.sync" | "erasure.request";
type SubjectReference = string & { readonly [subjectBrand]: "opaque-subject" };
export type SyncBinding = Readonly<{ account: string; environment: string; namespace: string; mappingVersion: string }>;
export type SyncAudience = Readonly<{ kind: "account-wide" } | { kind: "audience"; reference: string }>;
export type ProfileProjection = Readonly<{
  email: string; externalReference: string;
  fields: Readonly<Partial<Record<"givenName" | "familyName" | "locale", string>>>;
  properties: Readonly<Record<string, string | number | boolean>>;
}>;
type Payload = {
  "profile.sync": { projection: ProfileProjection; consentEvidenceReference: string };
  "consent.read": Readonly<Record<string, never>>;
  "erasure.request": { caseReference: string; authorityReference: string };
  "erasure.read": { receipt: SyncReceipt<"erasure.request"> };
};
export type SyncRequest<O extends Operation = Operation> = { [K in O]: Readonly<{
  binding: SyncBinding; audience: SyncAudience; subjectReference: SubjectReference;
  requestId: string; generation: number; deadlineMs: number; authorizationReference: string;
  operation: K; payload: Readonly<Payload[K]>;
}> }[O];
export type NegativeFeedback = Readonly<{
  [feedbackBrand]: "provider-negative"; sourceReference: string; occurredAtMs: number | null; audience: SyncAudience;
}> & Readonly<
  | { kind: "unsubscribe" | "complaint" | "manual_block"; outcome: "deny_permission" }
  | { kind: "hard_bounce" | "invalid_address"; outcome: "deny_delivery" }
>;
export type ConsentReadback = Readonly<{
  audience: SyncAudience; observedAtMs: number;
  remoteConsent: "subscribed" | "unsubscribed" | "pending" | "never_subscribed" | "unknown";
  feedback: readonly NegativeFeedback[];
  // Coverage describes this current-state observation only; never historical completeness.
  coverage: "complete" | "partial" | "unsupported";
}>;
export type SyncFailure<O extends Operation = Operation> =
  | { kind: "refused"; reason: "invalid_request" | "binding" | "provenance" | "stale" | "deadline" |
      "unsupported" | "verification_pending" | "restricted" | "identity_conflict" | "provider_refusal" }
  | { kind: "retryable"; reason: "cooling" | "host" | "provider"; afterSeconds: number }
  | ({ kind: "unknown"; reason: "dispatch_unresolved" | "acceptance_ambiguous" | "record_failed" } &
      (O extends Mutation ? { receipt?: SyncReceipt<O> } : { receipt?: never }));
// Receipt identifies the original admitted mutation; status lives only in the result union.
export type SyncReceipt<O extends Mutation> = Readonly<{
  [receiptBrand]: O; operation: O; request: SyncRequest<O>;
}>;
type MutationSuccess<O extends Mutation> =
  { kind: "accepted" | "acknowledged"; receipt: SyncReceipt<O>; journal: "confirmed" | "unknown" };
type Success = {
  "profile.sync": MutationSuccess<"profile.sync">;
  "consent.read": { kind: "completed"; value: ConsentReadback; journal: "confirmed" | "unknown" };
  "erasure.request": MutationSuccess<"erasure.request">;
  "erasure.read": MutationSuccess<"erasure.request"> | {
    kind: "completed"; receipt: SyncReceipt<"erasure.request">; journal: "confirmed" | "unknown";
    evidence: Readonly<{ [readBrand]: "provider-read"; readRequestId: string; observedAtMs: number;
      evidenceReference: string; assurance: "provider_record_deleted" | "provider_erasure_confirmed" }>;
  };
};
export type SyncResult<O extends Operation = Operation> = { [K in O]:
  Readonly<Pick<SyncRequest<K>, "binding" | "operation" | "subjectReference" | "requestId" | "generation">> &
  Readonly<Success[K] | SyncFailure<K>>
}[O];
export type SyncCapabilities = Readonly<{ binding: SyncBinding; audience: SyncAudience; operations: Readonly<Record<Operation,
  { state: "supported"; evidenceReference: string; maxRequestBytes: number; maxFeedbackItems: number } |
  { state: "unsupported" | "verification_pending" }>> }>;
export interface ProfileSyncPort {
  sync(request: SyncRequest<"profile.sync">): Promise<SyncResult<"profile.sync">>;
}
export interface ConsentReadPort {
  read(request: SyncRequest<"consent.read">): Promise<SyncResult<"consent.read">>;
}
export interface ErasurePort {
  request(request: SyncRequest<"erasure.request">): Promise<SyncResult<"erasure.request">>;
  read(request: SyncRequest<"erasure.read">): Promise<SyncResult<"erasure.read">>;
}
export interface MarketingSyncProvider {
  readonly capabilities: SyncCapabilities;
  readonly profiles: ProfileSyncPort; readonly consent: ConsentReadPort; readonly erasure: ErasurePort;
}

export type ConsentPushRequest = Readonly<
  Omit<SyncRequest<"profile.sync">, "operation" | "audience" | "payload"> & {
    operation: "consent.push";
  } & (
    { audience: Extract<SyncAudience, { kind: "audience" }>;
      payload: Readonly<{ action: "grant"; consentEvidenceReference: string }> } |
    { audience: SyncAudience;
      payload: Readonly<{ action: "withdraw"; consentEvidenceReference: string }> }
  )>;
declare const pushReceiptBrand: unique symbol; // private, same receipt style
type PushReceipt = Readonly<{ [pushReceiptBrand]: "consent.push";
  operation: "consent.push"; request: ConsentPushRequest }>;
type PushFailure = Exclude<SyncFailure, { kind: "unknown" }> |
  (Omit<Extract<SyncFailure, { kind: "unknown" }>, "receipt"> & { receipt?: PushReceipt });
export type ConsentPushResult = Readonly<Pick<ConsentPushRequest,
  "binding" | "operation" | "subjectReference" | "requestId" | "generation">> & Readonly<
    { kind: "accepted" | "acknowledged"; receipt: PushReceipt;
      journal: "confirmed" | "unknown"; reconcileRequired: boolean } | PushFailure>;
export interface ConsentPushPort {
  readonly capabilities: SyncCapabilities & Readonly<{
    operations: SyncCapabilities["operations"] & Readonly<{
      "consent.push": SyncCapabilities["operations"]["profile.sync"] & Readonly<{
        grantEffect: "audience" | "account-wide";
      }>;
    }>;
  }>;
  push(request: ConsentPushRequest): Promise<ConsentPushResult>;
}
