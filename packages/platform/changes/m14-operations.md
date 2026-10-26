### Added

- Experimental operations contracts/browser/server subpaths expose existing
  settings, pipeline-read, alert overview, watchdog delivery and control-plane
  behavior through injected host ports. The public reference binds these owners.

### Migration

- Existing reference imports remain compatible. Select the new operations entries
  explicitly; imports register no route, job or provider. Identity membership and
  tracking effects retain their existing owners.
- Native control-plane storage requires the complete canonical native prefix,
  including the job ledger and `20260814010000_platform_control_plane.sql`.
  The packaged SQL is a sparse unchanged projection. Supply current capability-local
  operator authority, routine EXECUTE and underlying relation grants; no managed
  parity or hosted-provider certification is established.

### Packaging

- Code/total file limits are 2,547/2,601. After the M13 integration, the operations
  candidate measures 2,526 code files and 2,580 total files. The remaining 21
  files are allocated to the seven already-authored B/C/D production TypeScript
  files (4/2/1), each packaged as source, JavaScript and declarations. This is a
  finite source-derived forecast, not an executed B–D package result or capacity
  for later modules. Each stacked candidate must pass its actual pack checks;
  additional files or byte-limit crossings need another bounded review.
- Byte, documentation-file and browser limits are unchanged. Combining or deleting
  contracts solely to reduce the count would add ownership and proof churn without
  changing the required capability.
