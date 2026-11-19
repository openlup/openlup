### Use the installed renewal horizon in the starter editor

Take the target extraction's `host/editor-ports.ts` through the managed upgrade
plan and apply. If local edits cause a conflict, move them to an application-owned
file outside both snapshots and restore the exact predecessor bytes in
`host/editor-ports.ts`. Replan and apply with the same snapshots. Keep the app
stopped until the managed snapshot and installed OpenLup versions match.

The running editor reads the installed horizon on its next stock read. This
upgrade needs no separate policy write or runtime privilege.
