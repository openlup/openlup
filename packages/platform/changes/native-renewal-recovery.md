- Expose native subscription composition, retry, delivery admission and typed
  settlement adapters through the subscriptions entry. Hosts retain readiness,
  the population lease, payment-owner readback and transaction selection.
- Replay matching terminal renewal history before current due eligibility,
  including after cancellation, while refusing changed frozen input and new
  cancelled work. Native retry, recovery-token and stock-wait history join the
  bounded connected-store transfer profile.
- Include durable activation and paid-cycle correlation when selecting normal-due
  stock-wait work for the renewal codec.
