- Add configured checkout reminder waves with distinct live links, atomic event/token capture, recent-payment suppression and confirmed first-send evidence before the final wave.
- Add reservation-backed one-time checkout expiry, provisional initial-checkout abandonment and idempotent expired-notice reconciliation. Live subscriptions and renewal-cycle checkout recovery remain excluded.
- Add lazy scheduled-job and authenticated HTTP composition plus a recovery-specific confirmed-send receipt adapter; other mail paths retain their behavior. Host schedules, pages, browser journeys and expired-order recreation require separate composition.

Migration: Apply the complete platform chain through `20261110100000_checkout_recovery_waves.sql`. New service entry points use closed execution grants; existing entry-point headers and ACLs remain unchanged. Supply a distinct delivery profile and explicit host timing, lease, batch and copy configuration before enabling a job.
