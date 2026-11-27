- `@openlup/platform/communications/klaviyo` handles storage failures during HTTP `429` cooldown persistence in `events.exportEvent` by quarantining the account and returning `{ kind: "retryable", reason: "cooling", afterSeconds }` instead of `{ kind: "unknown", reason: "acceptance_ambiguous" }`, and trims and caps `Retry-After` cooldown values at 86,400 seconds (24 hours) across all adapter HTTP paths.

Migration: No action required; all exported symbols and signatures in `@openlup/platform/communications/klaviyo` are unchanged.
