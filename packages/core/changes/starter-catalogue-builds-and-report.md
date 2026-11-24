### Rebuild starter catalogue packs after applying managed files

- The demonstration installer publishes one verified rules build per adopter pack version. Save and Prepare require that build for the exact declared type. Offline conformance keeps using owned declarations.
  Migration: Restore required exact versions and their rules under `owned/`, follow the owned-module migration in “Consolidate starter catalogue declarations before demonstration installation”, apply managed files and run `./lifecycle up --json`. Repeat the same draft action.
- The demonstration installer requires each pack identity to fit one UTF-8 filename, including the version and suffix. A build publication failure can follow a committed SQL transaction.
  Migration: Check the pack filenames and the installer volume's write access. Restore matching inputs and replay to recreate a missing link. Use new pack and affected type versions for intentional changes.
- Text `up` adds a Fix line to outer refusals and recognizes registered codes and explicit compatibility cases.
  Migration: Keep text checks on the first line, or use `./lifecycle up --json`, `findings[].code` and the process exit status. Check the upgraded application with a missing rules bundle and a failed launcher.
- The managed-file upgrade installs the refusal module and the lifecycle and host changes.
  Migration: Reconcile divergent managed files against the exact predecessor and target snapshots. Keep owned bytes through apply, then rebuild and check the reported type in the operator form.
