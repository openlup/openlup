### Use the installed renewal horizon in the starter editor

Take the target extraction's `host/editor-ports.ts` through the managed upgrade
plan and apply. Reconcile local edits to the managed file against the predecessor
and target, and retain application-owned files. Keep the app stopped until the
managed snapshot and installed OpenLup versions match.

The running editor reads the installed horizon on its next stock read. This
upgrade needs no separate policy write or runtime privilege.
