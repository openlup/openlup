Widen native subscription edit-quote CHECK, actor preview and command preview
cadence admission to 1..3660 whole days, matching `MAX_CADENCE_DAYS` in Core.
The two current function definitions change only their upper cadence bound;
headers, security, search paths, ownership, ACLs and replay behavior stay intact.
The validated CHECK uses the reviewed integer-range superset capability.

Migration: apply the complete selected native catalogue through
`20261122190000_subscription_cadence_bound.sql` before using longer cadences.
The forward replaces the validated CHECK and takes the usual table DDL lock;
plan installation around concurrent edits. No stored rows change. The managed
chain has no corresponding cap and receives no migration. Do not downgrade
history; unbind longer offers if rolling back application composition.
Checkout-command and saga-fallback replay above 3660 remains a follow-up for
unreleased development data. No release or activation is included.
