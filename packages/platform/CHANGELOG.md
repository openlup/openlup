# Changelog

## [Unreleased]

- Add experimental `./pricing` and `./pricing/contracts` entries by moving the existing OpenLup authority, subscription policy, assignment token and refusal mapping unchanged. Named reference exports preserve identity; browser schemas and feature-flag/secret/readiness composition remain local. Quote, offer and acquisition behavior remains for later P2 parts.

- Add experimental `catalog` and dependency-free `catalog/contracts` entries by
  moving the existing public neutral foundation, product types, draft logic,
  read ports and projections unchanged. Reference paths delegate; browser
  sellable schemas and rich catalog interpretation remain application-owned.
  Add unchanged provider-free media validation/resolution and bounded source-pack
  transfer using the existing blob port. Add lifecycle/publication DTOs and ports
  only; publication read, publish and lifecycle writes remain unsupported, with
  no executor, upload route, activation, SQL or wire-status changes.

- Add four native communications stores, explicit trusted network registration
  and evidence readback, and durable native consent decisions. Sync reuses the
  existing outbox rail; the reference binding is callable without activation.
  Append CREATE-only schema position 70 and its exact sparse SQL projection.
  Native consent excludes managed frequency caps and legacy contact-touching;
  evaluate is not a send-time fence. Existing exports and managed paths remain.

- Add neutral Polish/EN invoice, role, opt-out and generic inquiry default content
  factories with optional whole-copy injection in `communications/contracts`.
  Reference invoice/role rendering delegates to them; invoice construction may
  explicitly select EN, while implicit Polish and existing role bytes are preserved.
  Add Polish invoice/role previews and a pure inquiry binding without a new sender.

Migration: B2 changes reference opt-out page copy in both locales, translates
legacy/error outcomes for `lang=en`, corrects EN document language and escapes
all display values. Hosts preserving legacy page bytes must retain their own
presentation binding. Token verification, purpose scope, durable RPC and HTTP
statuses/headers are unchanged. Invoice locale defaults to Polish and is opt-in at
construction only; no persisted language or runtime activation is added. All
four contracts exports are additive; existing content copy interfaces remain.

- Add an opt-in immutable consent-purpose registry with mandatory classification,
  registry-bound policy/token/newsletter contracts and explicit host preference
  persistence. Legacy defaults and managed purpose CHECKs remain unchanged;
  registration grants no permission and creates no implicit synchronization.
  Extract neutral newsletter event processing and preserve host effects/readback.
  Add marketing automation ports and synthetic conformance without a runner,
  provider activation, schema or package-graph change.

Migration: P4 generalizes the existing purpose-bearing declarations with finite
legacy defaults. Calls and type references that omit a purpose argument retain
the same built-in purposes. Registry composition is opt-in: thread the same
registered purpose union through newsletter events, provider/store/webhook ports,
policy and token payloads, and pass the registry to dispatch, schema construction
and preference-token verification. Registration grants no consent, provider
activation or managed database support. Custom persistence remains host-owned;
the managed permission/sync CHECKs and existing token signing bytes are unchanged.
The legacy managed preference adapter still returns the same expanded three-value
purpose union.

Before (existing imports from `@openlup/platform/communications` or its contracts
entry; declarations shown with unrelated members omitted):

```ts
interface NewsletterWebhookEvent { purpose: NewsletterMarketingPurpose | null }
interface NewsletterSyncEvent { purpose: NewsletterMarketingPurpose }
interface NewsletterSyncProviderPort {
  sync(event: NewsletterSyncEvent): Promise<NewsletterSyncOutcome>;
}
type NormalizedNewsletterWebhookEvent = NewsletterWebhookEvent;
interface NewsletterWebhookPort {
  recordProviderEvent(input: NewsletterWebhookEvent & {
    state: "unknown" | "granted" | "denied" | "suppressed" | null;
    processingStatus: "received" | "ignored";
  }): Promise<{ providerEventId: string; contactId: string | null; inserted: boolean }>;
  // setPermissionFromProvider input.purpose: NewsletterMarketingPurpose
}
interface CommunicationSyncStore {
  // claimBatch(input): Promise<NewsletterSyncEvent[]>
}
interface CommunicationPolicyInput { purpose: CommunicationPurpose }
interface CommunicationPreferenceTokenPayload {
  email: string;
  purpose: "tester_program" | "marketing_launch_offer" | "marketing_newsletter";
  expiresAt: number;
}
declare function evaluateCommunicationPolicy(input: CommunicationPolicyInput): CommunicationPolicyResult;
declare function createCommunicationPreferenceToken(payload: CommunicationPreferenceTokenPayload, secret: string): string;
declare function normalizeCanonicalNewsletterWebhookEvent(event: CanonicalNewsletterWebhookEvent): NewsletterWebhookEvent;
// runCommunicationSyncDispatch / runCommunicationSyncDispatchForProviders:
// store: CommunicationSyncStore; provider(s): NewsletterSyncProviderPort (or array)
```

After (the unchanged members and return types above are retained):

```ts
interface NewsletterWebhookEvent<Purpose extends string = NewsletterMarketingPurpose> {
  purpose: Purpose | null;
}
interface NewsletterSyncEvent<Purpose extends string = NewsletterMarketingPurpose> {
  purpose: Purpose;
}
interface NewsletterSyncProviderPort<Purpose extends string = NewsletterMarketingPurpose> {
  sync(event: NewsletterSyncEvent<Purpose>): Promise<NewsletterSyncOutcome>;
}
type NormalizedNewsletterWebhookEvent<Purpose extends string = NewsletterMarketingPurpose> = NewsletterWebhookEvent<Purpose>;
interface NewsletterWebhookPort<Purpose extends string = NewsletterMarketingPurpose> {
  recordProviderEvent(input: NewsletterWebhookEvent<Purpose> & {
    state: "unknown" | "granted" | "denied" | "suppressed" | null;
    processingStatus: "received" | "ignored";
  }): Promise<{ providerEventId: string; contactId: string | null; inserted: boolean }>;
  // setPermissionFromProvider input.purpose: Purpose
}
interface CommunicationSyncStore<Purpose extends string = NewsletterMarketingPurpose> {
  // claimBatch(input): Promise<NewsletterSyncEvent<Purpose>[]>
}
interface CommunicationPolicyInput<Purpose extends string = CommunicationPurpose> {
  purpose: Purpose;
}
type LegacyCommunicationPreferencePurpose = "tester_program" | "marketing_launch_offer" | "marketing_newsletter";
interface CommunicationPreferenceTokenPayload<Purpose extends string = LegacyCommunicationPreferencePurpose> {
  email: string;
  purpose: Purpose;
  expiresAt: number;
}
declare function evaluateCommunicationPolicy<Purpose extends string = CommunicationPurpose>(input: CommunicationPolicyInput<Purpose>, registry?: CommunicationPurposeRegistry<Purpose>): CommunicationPolicyResult;
declare function createCommunicationPreferenceToken<Purpose extends string = LegacyCommunicationPreferencePurpose>(payload: CommunicationPreferenceTokenPayload<Purpose>, secret: string): string;
declare function normalizeCanonicalNewsletterWebhookEvent<Purpose extends string = NewsletterMarketingPurpose>(event: Omit<CanonicalNewsletterWebhookEvent, "purpose"> & { purpose?: Purpose | null }): NewsletterWebhookEvent<Purpose>;
// runCommunicationSyncDispatch / runCommunicationSyncDispatchForProviders now
// carry Purpose extends string = NewsletterMarketingPurpose through their store
// and provider(s), and accept registry?: CommunicationPurposeRegistry<Purpose>.
// verifyCommunicationPreferenceToken retains its old three-argument overload;
// the new fourth-argument registry overload returns the registered payload type.
```

No SQL forward, stock-store capability expansion or package-set version change is
part of this migration. Existing legacy schemas and purpose-less webhook fallback
remain finite and unchanged.

- B1: require package egress admission before every supported injected mail send.
  `createGuardedEmailTransport` validates a fresh explicit host policy, refuses
  missing/unknown/malformed decisions, redirects sink sends and suppresses drops
  before invoking the network sender. Provider names grant no admission.
  Package capture remains local; the maintained policy-enforcing transport uses
  an explicit composition bridge with unchanged wire behavior. Raw Auth closures
  compose through `createAuthEmailTransport`. See the M04 plan for every changed
  alternate-transport expectation; there is no schema or package graph change.

- Move the existing pure email renderer, block builders and commerce/subscription
  content assembly into communications/contracts. Host copy and helper bindings,
  browser previews, Auth refusal and independent verifier policies are preserved.
  The complete browser entry has an explicitly inventoried pure value surface;
  its measured owner-read size limit and W4/parity evidence are in the M04 ledger.

- Extract neutral admitted-observation and bounded polling orchestration through
  existing `./communications`. Existing domain wrappers retain protocol mapping,
  admission, evidence and persistence arguments. Keep lookup/apply/telemetry and
  polling fairness/failure order; the database remains the single convergence
  writer. No schema, dependency, manifest or route/schedule change.

- Add experimental `./communications` and type-only `./communications/contracts`
  entries by relocating the existing public implementation behind reference
  bindings. Preserve current transport outcomes, signature policies, token
  purposes, receipt replay and send/ledger order. Add generic webhook primitives
  to the existing `./http` entry and three byte-identical canonical SQL projections.
  Browser rendering/content, activation and deployment ownership stay with hosts.
- Apply E2 payment-helper delegation with identical export names and declared
  signatures, including `readRawBody`'s `VercelRequest` signature and function
  identity. Keep the payment provider-specific verification local.
- Keep maintained mail-provider clients, factories, callback protocol mapping, polling reads,
  timeline and send-ledger adapters at their unchanged reference owners.
  Required selection additions witness only retained package code; the current
  [verification ledger](../../docs/platform/plans/oss-m04-communications-triggers.md#verification-ledger)
  records counted cases, separate boundary iterations and the X2 time acceptance.
  Existing package artifact caps remain binding.

Migration: this opt-in import adds no schema forward or activation. Supply the
existing reference renderer, egress/environment/control policy or equivalent host
bindings when adopting the server factories. Apply the full selected canonical
SQL prefix once; the three sparse projections must not be reapplied over an
existing history. Package-set version preparation remains a separate step.

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise.

## [0.16.0]

- Publishable on the npm `latest` dist-tag as `0.16.0`, from tag
  `openlup-platform-v0.16.0`.

- Add the experimental identity capability at `./identity` and browser-safe
  `./identity/contracts`: role-based authorization, actor-scoped profiles,
  bounded normalized contact matching, unconfirmed soft accounts with explicit
  email-trust policies, and configured-origin magic-link redirect resolution.
- Add operator invitations with transactional pending acceptance, expiry,
  cancellation and revoked re-invitation for direct stores, and immediate active
  membership with repeat/concurrent recovery for managed stores. Direct operator
  login uses single-use email challenges, operator-audience sessions, live
  membership authorization, explicit first-administrator bootstrap and bounded
  challenge pruning. An opt-in OIDC access-token verifier provides pinned issuer
  discovery, bounded rotating JWKS, strict claim validation and deterministic
  issuer/subject principals for direct composition.
- Add versioned personal-data contributors, identity export and transactional
  direct erasure with contributor vetoes, challenge/invitation cleanup,
  pseudonymization, guarded operator revocation and idempotent receipts. Managed
  export reports incomplete coverage; managed erasure refuses with
  `MANAGED_PRIVACY_ERASURE_UNAVAILABLE` without mutation. Issued tokens may remain
  valid until expiry.
- Add seven byte-identical identity SQL projections and host-selected module
  schema readiness. The projections retain canonical migration identities and
  positions; they are not a standalone installation chain.

Migration: identity adoption is opt-in; upgrade the complete package set together
for the exact `@openlup/core` `0.16.0` peer pin. Supply the selected bundle's schema
inventory, clients and delivery bindings, an explicit email-trust policy, exact
redirect origins, a distinct operator audience and a deployment policy for
admin, operator and privacy routes. Managed soft-account provisioning requires
an email-trust envelope with automatic confirmation disabled and all enabled
non-email providers declared email-verifying. Install the complete direct
catalogue through `20261018190000_identity_privacy_erasures` before enabling
identity; never reapply projections to an existing canonical history. Managed
adopters need their committed chain's
`20261018160000_identity_service_role_capabilities.sql` forward for contact linking
and operator membership capabilities, and must supply their own erasure path.

## [0.15.0]

- Publishable on the npm `latest` dist-tag as `0.15.0`, from tag
  `openlup-platform-v0.15.0`.

- First publication of `@openlup/platform`, the server substrate for an OpenLup application, with one module subpath each for `http`, `bff`, `scheduler`, `blob`, `data`, `migrations`, `job-ledger`, `kernel` and `composition`.
- Transport-neutral scheduled jobs: a `run(context)` contract, an empty job registry, a lease-aware runner and an authenticated HTTP cron entry, with a constant-time cron secret comparison.
- Per-capability bundle readiness that refuses an unknown bundle and reports every missing scheduler, lock and blob setting together.
- Blob capability selection with filesystem, Vercel Blob, Supabase Storage and S3 bindings; `pg`, `@types/pg` and `@aws-sdk/client-s3` are optional peers, and an adapter refuses a missing peer with `OPENLUP_E_PEER_MISSING`.
