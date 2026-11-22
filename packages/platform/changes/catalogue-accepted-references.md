### Preserve accepted catalogue identity through commerce and transfer

Native owner transactions can retain accepted SKU references on orders, edits
and subscription templates. Renewals retain those references beside their
existing pricing snapshots. The archive census reports outstanding obligations
and incomplete evidence while archive remains unavailable.

Migration: connected-store restore admits only the target's current inventory.
An earlier capture or a source whose column was dropped or retyped is refused
with `schema_conflict`. Upgrade the source, within its installed profile, to
the migration level of the OpenLup version doing the restore, and restore into
a pristine target that this version installed with the same qualified profile.
Then capture the source again. If no such target can be provisioned,
connected-store restore is unavailable for that pair.
