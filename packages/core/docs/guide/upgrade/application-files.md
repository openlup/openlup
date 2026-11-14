# Upgrade application files

Reconcile the files your application explicitly manages between a predecessor
and a candidate snapshot. Use `planAppUpgrade` and `applyAppUpgrade` from
`@openlup/platform/lifecycle`, and keep application-specific brand, content,
policy and integration composition outside that managed inventory.

## Prepare snapshots

Keep immutable `from` and `to` values of type `AppVersionSnapshot`. Each names
a version, an inclusive schema range (`schema.min` and `schema.max`) and a
`files` record mapping relative paths to exact UTF-8 contents. Include a file
only in `to` to create it, or only in `from` to remove it.

Pass both snapshots, `root` and `schemaVersion` as `AppUpgradeInput`. Obtain
`root` with `realpath` from `node:fs/promises`: it must be the absolute canonical
path of an existing ordinary application directory. The schema ordinal must
be a nonnegative safe integer inside both snapshots' ranges. Observe the
database and choose those ranges separately; the primitive trusts the values
you supply and performs no database probe.

## Plan and reconcile conflicts

Call `planAppUpgrade(input)` and inspect its `files` actions and `conflicts`.
Planning only reads the application tree. The upgrade preserves local edits to
files that did not change between the snapshots, and
refuses divergent changed files before writes: a managed file whose local edits
match neither snapshot is a conflict. Reconciliation follows these rules:

| Snapshot and current contents | Result |
| --- | --- |
| The file is identical in both snapshots | Keep local contents or local deletion; report `unchanged` or `preserved`. |
| A changed path already has exact candidate bytes, or an intended removal is already absent | Report `already-applied`. |
| A changed path matches the predecessor, including absence for a creation | Plan `create`, `replace` or `remove`. |
| A changed path matches neither snapshot | Add a conflict: `current bytes match neither predecessor nor candidate`. |
| A path is unlisted in both snapshots | Leave it application-owned. |

Comparison uses exact bytes, without normalizing text or line endings. Reconcile
a divergent managed file before applying; the primitive does not merge local
edits. Replan after reconciliation and retain the final snapshot pair for
recovery.

Unsafe paths, case or Unicode-normalization aliases, file-parent collisions,
symbolic links and nonregular managed files refuse. Directory prefixes must
have one exact spelling across both snapshots, including directories that do
not yet exist. Existing managed components must match their directory-entry
spelling. An alias does not make an unlisted entry managed.

## Apply in a maintenance window

Hold an exclusive maintenance window over the application tree before calling
`applyAppUpgrade(input)`. Prevent other application writers and editors from
changing it until the operation and any recovery finish. The primitive does
not acquire a filesystem lock or defend against a hostile concurrent writer.

Apply inspects the whole input again before writing. A previously clean plan
does not bypass this preflight. If conflicts remain, apply throws
`AppUpgradeConflictError` before any file or directory mutation. Invalid
snapshot or path structure can throw an ordinary error instead.

Each create or replacement writes a temporary file in the destination's
directory and renames it into place. Removal unlinks the managed file.
Individual replacements are atomic on a local filesystem; the complete upgrade
is not a transaction. Replacement preserves ordinary permission bits, but not
ownership, access-control lists, extended attributes or special permission
bits. These operations do not establish power-loss durability.

## Resume interrupted work

After an I/O failure or process interruption, keep the tree exclusive and call
apply again with the same immutable predecessor and candidate snapshots. Exact
completed creates, replacements and removals are recognized as `already-applied`;
remaining actions continue. A third byte value still conflicts. Reconstructing
the predecessor from the partly upgraded tree would lose the original comparison.

Abrupt termination before rename can leave an unreferenced temporary file. It
is not adopted as a managed file or used as resume state.

## Verify the rest of the upgrade

File application performs no SQL, dependency installation, version-marker
write, deployment or user hook. Schema-range admission only compares
caller-supplied numbers. It certifies neither a real database upgrade or
backfill nor dependency provenance, runtime behavior or a rollback path.
Perform [database migration](./database-migrations.md) and application checks
separately before resuming service.

The published-set qualification also exercises the neutral starter from the
previous complete published set through the target release's public upgrade
CLI. Managed snapshots come from each starter's ownership inventory. The check
customizes owned theme and fragment files, refuses a divergent managed file,
interrupts apply with a process kill, resumes with identical snapshots and
requires replay to make no changes. A harness check refuses incomplete file
or declared-versus-installed dependency state; this is not an automatic serving
guard added to the application by the CLI.

The harness then installs the target's exact dependencies using a regenerated,
verified lock and checks typechecking, build, application tests and the local
development loop. Owned customization bytes must survive. The receipt names
both versions, extraction identities, the plan digest and phase results. The
previous set is the greatest stable core release tag below the target visible
in every package's npm version history. Historical starters are explicitly
labelled reconstructed. This proves only the checked neutral-starter file and
dependency transition; it provides no SQL migration, browser/provider coverage,
rollback guarantee or stable/support claim.
