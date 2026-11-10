- Fixed timed auto-resume after a paid first order whose native shipment has been delivered. Historical paid cycles and completed activations no longer keep a finite pause open; next-cycle orders and unfinished renewal or activation work still block safely.

Migration: `20261109150000_subscription_auto_resume_paid_history.sql` replaces only `subscription_auto_resume_due(integer,timestamptz)`, preserving its remaining guards, event, monotonic cadence roll-forward, header, owner and execution privileges.
