- Unpaid operator cancellation now serializes with payment attempts and truth,
  refuses unresolved or moved money, records one audit and releases exactly the
  order's held purchase reservations. Late captures retain operator review.
- Manual external-refund marking records paid-to-refunded status without a
  provider call or refund notification/accounting reversal event. Genuine refund
  sources retain their duties; active subscriptions remain unchanged.

Migration: Apply the complete native catalogue through
`20261110200000_operator_order_commands.sql` before using these command semantics.
Existing function headers and privileges remain unchanged; private attempt reads
use a bounded owned command rather than additional table grants.

- Package size: documentation measured 83,296 B against an 83,177 B cap
  (+119 B); the documentation cap is now 84,962 B, including 2% headroom.
  The whole-tarball packed cap is unchanged.
