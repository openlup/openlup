### Fixed

Preserve policy digests across a revision close.

Migration: additive native catalogue position 146 adds `closed_from_open` to
`subscription_price_policy_revisions`. The existing one-time NULL-to-finite
close sets it atomically without changing any original digest input or digest.
This single bit is sufficient because the guard admits no other close shape.
The byte-identical package asset is part of the complete migration catalogue.

Updated native readers verify the original tuple and serve the shortened
half-open window. `SubscriptionPricePolicyRevision.closedFromOpen` is optional;
legacy inputs keep their exact canonical bytes. Already-shortened legacy rows
whose stored tuple cannot verify refuse with
`subscription_price_policy_original_tuple_unverified`. No backfill guesses the
original tuple or replaces a historical digest. Apply schema first, upgrade
readers next, and verify retained history before enabling any later writer.
Old readers retain unchanged-tuple behavior but refuse newly closed revisions;
after a close, rollback must retain the new verifier. Keep schema and rows.

The marker follows the existing AUTHORITATIVE policy capture/restore class and
ordering, including byte-exact restore and replay. No new table, client foreign
key, absorption or privacy-erasure duty is added. Subscription agreements,
renewal terms and operations, orders, quantities and cycle dates are unchanged.
This repair ships unbound: no scheduler, closing command, capability or activation.

Managed divergence design: the managed rail does not supply this feature.
Its future twin adds the same marker and validated CHECK to managed
`subscription_price_policy_revisions`, preserving RLS and existing grants.
Administrative write grants and RLS express the native owner-only mutation
boundary; browser roles cannot close revisions or write the marker. The twin
must update its reader and guard together and prove original-digest verification,
shortened-window serving and legacy refusal. No native-only authorization role
is required and no food-column relaxation applies to this policy-only forward.
