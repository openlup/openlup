### Find catalogue tasks and owned files in the starter

The extracted agent guide maps catalogue tasks to application-owned inputs and
installed recipes. Managed files point to the owned extension point. The
extracted ownership guide lists Dockerfile, HTML, CSS and JSON paths under
**Managed files without a header**.

Migration: Replace a pristine `AGENTS.md` with the target extraction's copy.
For a customized guide, explicitly reconcile the catalogue task section and
preserve local instructions. Use the target extraction for managed files.
This change requires no startup or policy action.
