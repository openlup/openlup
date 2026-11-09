- Add configured checkout reminder waves with distinct live links, atomic event/token capture, recent-payment suppression and confirmed first-send evidence before the final wave.
- Add reservation-backed one-time checkout expiry, provisional initial-checkout abandonment and idempotent expired-notice reconciliation. Live subscriptions and renewal-cycle checkout recovery remain excluded.
- Add lazy scheduled-job and authenticated HTTP composition plus a recovery-specific confirmed-send receipt adapter; other mail paths retain their behavior. Host schedules, pages, browser journeys and expired-order recreation require separate composition.

- Fix a defect: an expired-checkout notice must not carry a link that is already expired; emit the same notice without a token when its recovery deadline has elapsed.

- Package size: code measures 2,338,375 gzip bytes against its prior 2,336,415-byte cap (+1,960 B), setting a new cap of 2,385,143 B. Documentation measures 79,487 gzip bytes against its prior 79,312-byte cap (+175 B), setting a new cap of 81,077 B. Both caps are measured × 1.02, rounded up; tarball, unpacked and file caps are unchanged.

Migration: Apply the complete platform chain through `20261110100000_checkout_recovery_waves.sql`. The widened order-status CHECK retains `NOT VALID` and does not revalidate historical rows. New service entry points use closed execution grants; existing entry-point headers and ACLs remain unchanged. Supply a distinct delivery profile and explicit host timing, lease, batch and copy configuration before enabling a job.
