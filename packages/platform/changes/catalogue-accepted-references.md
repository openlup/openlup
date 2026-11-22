### Preserve accepted catalogue identity through commerce and transfer

Native owner transactions can retain accepted SKU references on orders, edits
and subscription templates. Renewals retain those references beside their
existing pricing snapshots. The archive census reports outstanding obligations
and incomplete evidence while archive remains unavailable.

Migration: connected-store restore converts captures from the admitted earlier
inventories. Their accepted references restore as NULL and the edit quote table
as empty. Other earlier captures, and a source whose column was dropped or
retyped, refuse with `schema_conflict`: upgrade the source, then capture.
