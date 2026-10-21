- Enable native flat-rate read/save through a named role-free capability lane.
- Require the native port and Core readiness for the shipping seed migration.
- Refuse missing-row saves; native audit remains explicitly unsupported and best effort.

Migration:
Apply the complete portable chain through 20261021120000_shipping_flat_rate_seed.
The seed preserves an existing rate and inserts zero only when absent; no ACL or
role changes are made. New code on an unmigrated schema keeps refusing. Old code
ignores the row, but older runners refuse the extended ledger. Application rollback
does not reverse the migration. Managed host-save authority remains pending.
