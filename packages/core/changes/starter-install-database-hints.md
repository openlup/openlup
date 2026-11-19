### Show database hints during starter installation

Take the target extraction's `lifecycle.mjs` through the managed upgrade plan
and apply. If local edits cause a conflict, move the local launch behavior to
an application-owned launcher outside both snapshots that delegates to
`lifecycle.mjs`. Restore the exact predecessor bytes in `lifecycle.mjs`, then
replan and apply with the same snapshots. Keep the app stopped until the
managed snapshot and installed OpenLup versions match.

When the schedule guard refuses installation, the starter prints the existing
message first and the retry hint on the next stderr line. Other installer
errors with a database hint use the same format. Installation retains the same
exit status and refusal codes. This file upgrade requires no additional
settings write or database grant.
