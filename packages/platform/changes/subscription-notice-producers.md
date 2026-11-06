Native subscription reminder production now applies configured eligibility before
consuming the renewal-day identity and retains the exact queued charge instant.
Pause notices use window identity and recheck resolution before delivery. At-risk
notices retain cause/day history for accepted deliveries and disabled templates.
Operator notices use distinct recipients, fresh-only eligibility and fenced claims.

The existing subscriptions entry gains optional notice timing/cap configuration
and an explicit operator binder. Hosts continue to own calendar labels, copy,
delivery-window estimation and recipient-bound rendering through the trusted binder.
Imported or uncorrelated starter history uses standard freshness and may miss an
early reminder. Real provider acceptance/idempotency remains a host prerequisite.
