# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise.

## [Unreleased]

- Add the opt-in identity envelope proof with phase `email-trust`, including
  its fixture-only service-role grant, immediate persisted-association assertions,
  pre-existing contact linking and post-replay state checks. Phase `joint` also
  proves unconfirmed soft-account provisioning and first-login confirmation,
  preserving customer/auth identities and subscription references and refusing
  unknown addresses without creating accounts.
- Abort managed settings transport when an assessment finishes, including
  unread error response bodies, to preserve the three-second deadline.
- Always bind managed settings assessment for the managed reconcile route.
  Migration: `PLATFORM_BUNDLE=node-postgres` no longer bypasses that route's
  managed email-trust policy; verifier-only trust belongs to direct composition.

- Import the identity capability and its conformance witnesses into internal
  candidate entries `./identity` and `./identity/contracts`.
- Include the characterized create-first directory lookup, bounded normalized
  invite lookup and managed machine-actor write fence.

Migration: The identity entries are internal candidates, not a published identity release. Reference
bindings keep application copy, origins, sender and provider setup outside the
module. Existing module paths delegate to the package; stable codes are internal
and the reference invite/remove wire shapes retain their prior fields. The
contracts runtime-schema move and profile-specific readiness schema inventory
remain pending. The four package SQL projections preserve canonical bytes and
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

- Rename the opt-in identity envelope proof phase to `email-trust` and document
  its fixture-only service-role grant and post-replay state checks.
  Migration: Invoke the envelope runner with `--phase email-trust`.
- Customer soft-account auth users are provisioned unconfirmed. Existing-user
  magic-link verification confirms the same user without replacing customer
  identities or links. Typed contact addresses do not prove mailbox ownership.
  Migration: Ensure the selected Auth installation can deliver and verify a
  first-login link for an existing unconfirmed user, and run
  `node tests/postgres/runIdentityEnvelopeConformance.mjs --phase joint`.
  Existing identities are not rewritten.

## [0.15.0]

- Publishable on the npm `latest` dist-tag as `0.15.0`, from tag
  `openlup-platform-v0.15.0`.

- First publication of `@openlup/platform`, the server substrate for an OpenLup application, with one module subpath each for `http`, `bff`, `scheduler`, `blob`, `data`, `migrations`, `job-ledger`, `kernel` and `composition`.
- Transport-neutral scheduled jobs: a `run(context)` contract, an empty job registry, a lease-aware runner and an authenticated HTTP cron entry, with a constant-time cron secret comparison.
- Per-capability bundle readiness that refuses an unknown bundle and reports every missing scheduler, lock and blob setting together.
- Blob capability selection with filesystem, Vercel Blob, Supabase Storage and S3 bindings; `pg`, `@types/pg` and `@aws-sdk/client-s3` are optional peers, and an adapter refuses a missing peer with `OPENLUP_E_PEER_MISSING`.
