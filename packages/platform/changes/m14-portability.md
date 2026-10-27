### Added

Add the experimental Node-only `@openlup/platform/portability` entry for verified,
bounded object copy/resume and compatible PostgreSQL row capture/restore through
injected transaction handles. Object reads distinguish absent, denied and
unavailable; private filesystem publication preserves bytes, metadata and source
lineage with an explicit process-owner access policy. Row replay is exact and
conflicts refuse atomically; every enabled user INSERT trigger refuses.

Filesystem publication and readback share one encoded-descriptor byte ceiling
covering admitted Unicode metadata; oversize encodings refuse before publication.
Filesystem locators hash JSON-encoded logical keys, preserving distinct admitted
strings including lone UTF-16 surrogates. This first unpublished layout has no
legacy-format migration or fallback.

The bounded M14 B budget reads approved the initial code-gzip minimum of
1,650,493 bytes, exactly 128 bytes for that necessary Unicode repair and 10 bytes
for exact string-key identity. The current measured minimum is 1,650,631 bytes,
cumulatively 2,631 above 1,648,000.
This allocates no additional forecast headroom. Other byte, file, docs and
browser limits and the released baseline are unchanged by this decision; later
candidates still need their own actual package measurement.

### Migration

Select the entry explicitly. Install the canonical target catalogue
and qualify the source/target privileges separately; this API does not install
schema, copy migration ledgers, map managed identities or activate executors.
Changed-row catch-up, guarded-domain import and hosted effect-time fencing remain
M14 dependencies. Local synthetic proof does not certify complete-store transfer,
provider revocation or a stable migration service.
