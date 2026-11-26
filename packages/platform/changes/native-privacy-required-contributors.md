### Native privacy contributor declaration

Native export and erasure check the installed declaration before processing the
subject. The handler returns HTTP 503 (`UPSTREAM_UNAVAILABLE`) with the refusal
code in `error.details.privacyCode` and four facts in `error.details`.

For `PRIVACY_CONTRIBUTOR_MISSING`, `<owners>` is the comma-separated list of
missing installed contributor IDs.

- `observed` — Required installed owners are absent (`<owners>`).
- `cause` — The installed declaration requires those owners.
- `fix` — Register their working owner ports in the serving composition.
- `recheck` — Retry the original request after rollout.

An unavailable or invalid declaration returns `PRIVACY_ASSESSMENT_UNAVAILABLE`.

- `observed` — Native privacy prerequisites could not be verified.
- `cause` — The native store or its installed declaration or receipt evidence is unavailable or invalid.
- `fix` — Check the native handler and store binding, driver, connection and
  TLS, and CONNECT, schema USAGE and EXECUTE privileges. Ask the installation
  owner to recover the exact declared catalogue and its approved migration
  history or the original verified receipt evidence, as applicable.
- `recheck` — Retry the original request.

Migration: Apply the complete native catalogue for the installation profile.
Declare each new required contributor ID in the ordered migration for its
owner feature. Register every installed contributor in the serving registry.
Forward `readRequiredContributorIds` on the held transaction in native store
wrappers. Update strict clients to accept both codes and all four facts. Follow
**Upgrade native privacy operations** in the **Personal data** guide for
handler binding and cutover.
