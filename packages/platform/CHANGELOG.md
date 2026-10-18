# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise.

## [Unreleased]

- Mount default identity privacy routes in the shipped reference dispatcher for
  managed bundles. Public policy refuses with `adopter_policy_required`; admitted
  managed exports report incomplete coverage and erasure refuses without mutation.
  Customer challenge issue/redeem reject erasure receipts for either the contact
  or principal under the transaction lock shared with erasure, including stale
  challenges inserted after cleanup.
  Migration: hosts must use the package challenge adapters rather than call raw
  challenge SQL functions directly to retain erasure re-link protection. No SQL
  migration or declaration change is required.

- Wait for direct operator session and admin state before completing pasted-token
  or callback sign-in, so delayed authorization enters the protected admin shell.
  Preserve the managed initial-session application order and retain direct tab
  sessions on transient focus-check failures; authorization refusals still clear
  them. Document expired first-administrator invitation recovery limits.
  Migration: successful direct code verification now waits for the browser's
  authorization check before resolving; transient focus-check outages preserve
  the current session until its existing expiry or a later authorization refusal.

- Preserve the reference invite/remove message catalogue and role-mail locale
  through the package inputs. The admin `me` route retains its fail-closed
  deployment-risk classification and public-default refusal.

- Apply the existing observed route and deployment policy boundary to all mounted
  direct operator routes, including caller-composed handlers. Preserve injected
  challenge delivery through dispatcher session-binding composition. Consume
  guarded browser auth notifications so an older authorization check cannot sign
  out an established newer session or cancel its pending redemption.
  Migration: all mounted direct operator routes, including `me`, use the admin
  mutation risk classification and require the adopter's deployment policy.
  Configure operator delivery through `createReferenceBffDispatch` and `createOperatorSessionBinding`.

- Keep both reference admin privacy routes under deployment-policy risk
  `mutation`. The public default refuses direct and managed requests before body/query reads
  with 503 / `adopter_policy_required`. Direct and managed adopters reach these routes only
  through their deployment policy, like every admin mutation route. Once admitted,
  managed export reports incomplete coverage and erasure refuses with
  `MANAGED_PRIVACY_ERASURE_UNAVAILABLE` without mutation. Direct mounts refuse before authentication or privacy bindings are created,
  including when supplied routes contain the same path. Human-admin authorization
  remains required after policy admission.
  Migration: direct and managed hosts must bind their existing deployment policy to admit
  these reference routes. This policy correction requires no schema migration.

- Fix opt-in managed privacy conformance replay through node-postgres by omitting
  only psql's pg_dump guard lines from the committed migration chain. Document
  the required database owner connection; privacy assertions and grants are unchanged.

- Add versioned personal-data contributors, identity export and transactional
  direct identity erasure with subscription vetoes, challenge/invitation cleanup,
  scoped pseudonymization, guarded operator revocation and idempotent receipts.
  Add human-admin privacy POSTs, Settings readback and bounded customer challenge
  expiry pruning. Managed export reports incomplete coverage; managed erasure
  refuses with `MANAGED_PRIVACY_ERASURE_UNAVAILABLE`. Issued tokens can remain
  valid until expiry.
  Migration: apply the direct privacy receipt forward before the updated customer
  challenge store or privacy operations; register required contributors and
  declare opaque-field retention ownership. Managed adopters must provide their
  own erasure path; no managed grants are added.

- Preserve pending direct operator redemption across browser restoration and focus
  checks, including provider/callback mounting under StrictMode. Send the padded
  generic challenge acceptance before mailbox delivery so slow transports do not
  reveal eligibility. Repeat active-operator login preserves membership and
  invitation history.
  Migration: custom operator HTTP hosts must send their padded accepted response
  in the optional `requestChallenge(email, accept)` callback before delivery;
  calls without that callback retain their existing delivery-waiting behavior.

- Add the opt-in identity envelope proof with phase `email-trust`, including
  association under the shipped managed grants (including the identity
  capabilities forward), immediate persisted-association assertions,
  pre-existing contact linking and post-replay state checks. Phase `joint` also
  proves unconfirmed soft-account provisioning and first-login confirmation,
  preserving customer/auth identities and subscription references and refusing
  unknown addresses without creating accounts.
- Abort managed settings transport when an assessment finishes, including
  unread error response bodies, to preserve the three-second deadline.
- Always bind managed settings assessment for the managed reconcile route.
  Migration: `PLATFORM_BUNDLE=node-postgres` no longer bypasses that route's
  managed email-trust policy; verifier-only trust belongs to direct composition.

- Add the direct operator pending-invitation lifecycle with trusted acceptance,
  expiry, cancellation, atomic membership/audit writes and ordered locks. Append
  direct forward `20261018120000_identity_operator_invitations` at catalogue
  position 67, with its byte-identical package projection. Existing memberships
  and identity/customer links are preserved.
- Keep managed operator invitations immediately active. Identical repeats and
  concurrent insert losers return existing membership without another role
  notification; failures retain identities for retry. Revoked operators refuse
  with `MANAGED_REINVITE_UNSUPPORTED`. Inserts use the machine-actor default.
  The reference browser accepts structured active managed and pending direct
  results. Managed role mail uses an active-membership key without a deadline.
  Notification failure retains the active principal ID, state and role in BFF
  error details.
  Migration: direct hosts apply the new forward and compose trusted acceptance
  and TTL parsing. Managed consumers parse active results with
  `MEMBERSHIP_CREATED`/`ALREADY_ACTIVE` instead of message-only success; duplicates
  return existing membership instead of `ALREADY_ADDED`. Notification failure
  returns 503 `INVITATION_NOTIFICATION_FAILED` with membership retained.
  Managed pending/expiry remains a compatibility gap requiring a separate
  transactional store and reviewed forward. The managed chain's identity
  capabilities forward `20261018160000_identity_service_role_capabilities.sql`
  grants `service_role` SELECT(email) and INSERT(id, email, role, membership_state,
  membership_provenance, membership_accepted_at) on `admin_users`. The opt-in
  conformance replays the complete committed chain with ambient default ACLs
  removed and adds no grant. It proves immediate activation, repeat/concurrent
  recovery and revoked-member refusal under the shipped grants. It does not
  establish managed/direct lifecycle parity.

- Import the identity capability and its conformance witnesses into internal
  candidate entries `./identity` and `./identity/contracts`.
- Include the characterized create-first directory lookup, bounded normalized
  invite lookup and managed machine-actor write fence.

Migration: The identity entries are internal candidates, not a published identity release. Reference
bindings keep application copy, origins, sender and provider setup outside the
module. Existing module paths delegate to the package; invite results adopt the
structured fields and identity reasons described above, while notification
receipts retain their reference field names. The
contracts runtime-schema move and profile-specific readiness schema inventory
remain pending. The six package SQL projections preserve canonical bytes and
positions; do not apply them again to an existing canonical migration history.

- Only stored `admin` and `distributor` roles authorize. Null and unknown
  roles refuse with 403, do not qualify for an admin magic link and are reported
  as non-admin by the reference profile reader. Magic-link acceptance, response
  padding and quota remain unchanged.
  Migration: Adopters relying on null/unknown role mapping must map those values
  in their own adapter before the package sees the role.
- Both managed contact stores match normalized email case-insensitively,
  with literal address matching: an anchored, escaped `imatch` database prefilter
  followed by an exact trimmed lowercase comparison. Mixed-case contact rows now match for soft
  linking and reconciliation instead of disappearing behind an exact filter.
  Migration: Mixed-case rows now resolve to the existing contact; injected query
  clients must support the escaped, anchored `imatch` filter. No schema or stored
  address rewrite is required; the direct challenge lookup already uses lower(email).
- Reject Unicode lookalike email candidates returned by the managed contact
  prefilter before linking. Both stores inspect at most ten candidates; soft
  linking chooses the oldest exact normalized match, and reconciliation refuses
  multiple exact matches through its existing multiple-row error path.
  Migration: Injected query clients must return email in bounded array results
  for both lookups. Regex-only matches no longer resolve to another contact;
  matches beyond the ten-candidate bound are not selected. No SQL migration or
  stored address rewrite is required.

- Both magic-link factories default to one configured-origin allowlist resolver;
  request headers never supply the callback origin. Missing or invalid origins
  refuse with `UPSTREAM_UNAVAILABLE` (503) before provider access. Unsafe customer
  return paths are omitted for the default landing page. Explicit `resolveOrigin`
  injection remains available.
  Migration: Configure `redirectOrigins` with exact HTTP(S) origins (primary first).
  The reference bindings reuse `APP_BASE_URL`, otherwise
  `CUSTOMER_AUTH_REDIRECT_ORIGIN` for customers or `SITE_URL` for admins. Remove
  paths, credentials, queries and fragments from those values. Local and preview
  requests now require configuration too; an unconfigured customer request no
  longer derives its link from the forwarded host. Direct customer session
  challenges also refuse without origin configuration. Adopters retaining their
  own origin policy can continue passing `resolveOrigin`.

- Managed identity verification requires the provider confirmation timestamp.
  Email-based account association requires an injected trust policy; the managed
  default checks cached public Auth settings and fails closed for unsafe or
  unavailable settings. The readiness helper identifies module `identity`. The
  browser reconcile contract lists the two refusal codes and
  `PRINCIPAL_EMAIL_MISMATCH`, which the engine already returned.
  Migration: Bind an email-trust policy at reconcile composition. Declare trusted
  email-verifying providers explicitly, or deliberately bind
  `createVerifierResultOnlyEmailTrustPolicy()`. Metadata-only verification no
  longer qualifies. Existing identities and matching account links are not rewritten.

- Customer soft-account auth users are provisioned unconfirmed. Existing-user
  magic-link verification confirms the same user without replacing customer
  identities or links. Typed contact addresses do not prove mailbox ownership.
  Migration: Soft-account provisioning now requires an injected trusted email
  envelope: automatic confirmation off and all enabled non-email providers
  declared email-verifying. Unsafe or unavailable settings return a non-fatal
  refusal before identity creation or email-based linking, preventing anonymous
  signup from acquiring a commerce-linked identity merely by knowing its address.
  Pass `emailTrustPolicy` to the managed store factory and expose it on custom
  stores; explicit verifier-result-only composition remains available to adopters.
  The reference managed binding always reads settings, regardless of bundle.
  Ensure the selected Auth installation can deliver and verify a
  first-login link for an existing unconfirmed user, and run
  `node tests/postgres/runIdentityEnvelopeConformance.mjs --phase joint`.
  Existing identities are not rewritten.

- Direct operator invitations remain pending until trusted acceptance, expire
  lazily at a configurable deadline and preserve attempts without repeat mail.
  Direct storage provides transactional acceptance, cancellation, revoked
  re-invitation and audit. Removal retains identities.
  Migration: Apply direct forward `20261018120000_identity_operator_invitations`
  through the complete canonical catalogue. Bind the direct invitation store and
  parsed TTL (default 604800 seconds, range 60..2592000); consume lifecycle
  fields and 409 identity reasons in place of message-only results. Replace
  immediate-membership invite writers on the direct bundle. Direct human login
  requires the operator-challenges forward described below. Managed invitations
  retain immediate activation as described above; no managed lifecycle migration
  is introduced.

- Added direct PostgreSQL human operator login with single-use email challenges,
  operator-audience ES256 sessions and live membership/role authorization. First
  direct sign-in activates pending direct invitations. Added explicit first-administrator
  bootstrap and bounded challenge pruning, tab-scoped browser sessions, and
  lazy managed browser authentication selection.
  Migration: apply the appended operator-challenges forward through the complete
  selected catalogue and configure a distinct operator audience. Resolve normalized
  duplicate principal emails without merging identities. Customer links and machine
  credentials remain intact. Challenge delivery defaults to discard; inject delivery
  for interactive login. No managed migration is required.

## [0.15.0]

- Publishable on the npm `latest` dist-tag as `0.15.0`, from tag
  `openlup-platform-v0.15.0`.

- First publication of `@openlup/platform`, the server substrate for an OpenLup application, with one module subpath each for `http`, `bff`, `scheduler`, `blob`, `data`, `migrations`, `job-ledger`, `kernel` and `composition`.
- Transport-neutral scheduled jobs: a `run(context)` contract, an empty job registry, a lease-aware runner and an authenticated HTTP cron entry, with a constant-time cron secret comparison.
- Per-capability bundle readiness that refuses an unknown bundle and reports every missing scheduler, lock and blob setting together.
- Blob capability selection with filesystem, Vercel Blob, Supabase Storage and S3 bindings; `pg`, `@types/pg` and `@aws-sdk/client-s3` are optional peers, and an adapter refuses a missing peer with `OPENLUP_E_PEER_MISSING`.
