- Fix timed auto-resume remaining paused after its first paid order has been
  delivered. Historical fulfilled orders no longer block; in-flight orders and
  orders in the existing paid/fulfilling/fulfilled allowlist on the next date
  still prevent stacked deliveries. Cancelled pause-closure orders do not block.

Migration: apply `20261109113000_subscription_auto_resume_delivered_history.sql`
through the complete selected catalogue. The function header, privileges, other
eligibility guards, event identity and whole-cadence roll-forward are unchanged.
