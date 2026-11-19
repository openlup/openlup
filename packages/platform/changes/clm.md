For the next 1.x release. On the native rail, closed-from-open provenance can
only be set by a guarded close or a native restore.

Migration: apply the additive native forward with the matching connected-store
restore implementation. Existing readers can continue to verify stored policy
tuples. No data rewrite is needed. Use the updated restore implementation for
targets that have applied the forward. An earlier restore implementation
refuses the new INSERT trigger.

Managed divergence design: a managed twin could add the same INSERT guard to
the policy revision table and use a transaction-keyed capability table with
RLS. A trusted restore role could hold the narrow table grants and policies
needed to restore and clear the capability in one transaction. Ordinary
writers would have no capability privileges. The managed rail does not supply
this feature.
