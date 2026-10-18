# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise.

## [Unreleased]

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
  with literal address matching. Mixed-case contact rows now match for soft
  linking and reconciliation instead of disappearing behind an exact filter.
  Migration: Mixed-case rows now resolve to the existing contact; injected query
  clients must support the escaped, anchored `imatch` filter. No schema or stored
  address rewrite is required; the direct challenge lookup already uses lower(email).


## [0.15.0]

- Publishable on the npm `latest` dist-tag as `0.15.0`, from tag
  `openlup-platform-v0.15.0`.

- First publication of `@openlup/platform`, the server substrate for an OpenLup application, with one module subpath each for `http`, `bff`, `scheduler`, `blob`, `data`, `migrations`, `job-ledger`, `kernel` and `composition`.
- Transport-neutral scheduled jobs: a `run(context)` contract, an empty job registry, a lease-aware runner and an authenticated HTTP cron entry, with a constant-time cron secret comparison.
- Per-capability bundle readiness that refuses an unknown bundle and reports every missing scheduler, lock and blob setting together.
- Blob capability selection with filesystem, Vercel Blob, Supabase Storage and S3 bindings; `pg`, `@types/pg` and `@aws-sdk/client-s3` are optional peers, and an adapter refuses a missing peer with `OPENLUP_E_PEER_MISSING`.
