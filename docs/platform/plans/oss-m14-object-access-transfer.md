# M14 object access transfer task

Status: local candidate prepared for native review. This is a bounded development-preview parcel of the existing-store transfer programme.

## Outcome and boundary

Complete the declared synthetic object-transfer scope: reconcile an independently owned source inventory with authenticated traversal; verify bytes, required versions and metadata; compare effective anonymous, customer and operator access at the actual serving routes; stage a fresh inactive generation; and retain pending uploads, partial objects and cleanup duties. Refuse unexplained absence, divergent content, access widening or loss before activation. The later connected catch-up task owns whole-store activation and writer fencing.

This parcel owns the S3 and filesystem object source, publication and serving adapters and their focused tests and documentation. It excludes the database business graph, restricted connected restore, catch-up journey, hosted bucket lifecycle and release. Any missing integration hook in another parcel must be referred to its owner.

Authority: the active supervisor may make local edits, run checks, commit with the required DCO identity, submit and merge only after applicable reads, fresh native review, full verification and live delivery gates. Security-control changes require a maintainer read before DCO. No hosted resource, credential, settings, production or release grant is implied.

## Acceptance and proof

Use a bounded, declared fixture with an independently enumerated reference/obligation inventory, S3 source and filesystem or S3 target. Prove filtered listing, missing object, changed bytes/metadata, access widening and loss, interrupted-copy resume and inactive publication refusal. Reconcile the actual source and target serving routes under anonymous, customer and operator identities. Record tested generation and ownership assumptions; a source listing alone is insufficient.

Before submission run policy/inventory checks, focused structural scan and tests, lint and the required full local verification. Native review requires two independent fresh-context FULL reviews on the committed tree. The publication budget is measured before adding files or growing a package surface. A security-control read packet is due before DCO.

## Execution note

Initial source: `15a708a6` from `origin/main`. Existing S3 capture proves authenticated listing and GET readback only; the portable object copy already checks descriptors and bytes and recognizes exact replay. Existing filesystem media capture includes temporary files, while its restore requires host-held writer exclusion and a fresh inactive root. Initial measured tracked inventory: 6,612 files / 49,809,402 bytes. The platform package cap is 2,712 total files and 2,656 code files; new package files need a measured cap check.
This parcel adds no package file or package export, so no package cap is changed.

The current working candidate adds independent source-reference reconciliation with stable source snapshot identity and obligation record identities. The declared S3 profile refuses a returned native version ID because ListObjectsV2 cannot prove older version history. It requires independent no-tags and no-multipart feature facts; unsupported physical multipart state cannot be silently omitted. Filesystem media references are reconciled against both final and temporary files, and a separate inactive generation is read back before route probes compare source and target effective access. The later whole-store caller must supply the fenced source reference snapshot, expected domain grants and host activation barrier.

Working checks on pinned Node 24.21.0/npm 11.19.0: `npm ci` completed; policy with documentation regeneration and inventory passed; structural scan, neutrality and redacted Gitleaks passed on the working tree. Focused tests passed 40/40 across four files, including filtered listing, missing reference, byte and metadata drift, access widening/loss, and inactive generation replay/refusal. The pinned Versity S3 fixture passed 6/6, including interrupted-copy resume and anonymous denial without leaked object bytes. `npm run lint` passed with zero errors and 33 unrelated existing warnings; `tsc -p tsconfig.api.json --noEmit` passed. The security-control maintainer read was accepted for the exact staged tree and diff (local evidence: `.context/scratch/object-access-transfer/maintainer-read-20261029.md`). DCO commit, native review and broad gate remain pending.

Known limits from that read: the census compares JSON strings. Captured keys are sorted by the same lexical comparison as reference keys, and captured metadata keys are sorted before comparison to sorted reference metadata; an unexpected ordering mismatch refuses rather than qualifying. The serving probe requires an exact `Content-Length`, so chunked serving without one refuses. Versioned S3 source admission belongs to a separately read 10O profile; this parcel refuses it.

Risk: a storage ACL label is not an effective serving grant. Route observations and independent source references must be binding facts, or the transfer refuses. Inactive staging and cleanup obligations require explicit readback before any later activation.

Self-retro: A direct Vitest attempt after a clean install could not resolve unbuilt workspace exports. Running the existing lint prerequisite built them; the focused and Versity tests then passed. No new test harness was needed.
