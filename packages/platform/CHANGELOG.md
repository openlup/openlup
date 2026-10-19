# Changelog

## Unreleased

- Add an opt-in immutable consent-purpose registry with mandatory classification,
  registry-bound policy/token/newsletter contracts and explicit host preference
  persistence. Legacy defaults and managed purpose CHECKs remain unchanged;
  registration grants no permission and creates no implicit synchronization.
  Extract neutral newsletter event processing and preserve host effects/readback.
  Add marketing automation ports and synthetic conformance without a runner,
  provider activation, schema or package-graph change.

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

## [Unreleased]

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
