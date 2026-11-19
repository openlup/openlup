- Fresh cycles and expired claims both get space in a normal Native PostgreSQL
  renewal batch when both have eligible work.

Migration: Apply the ordered Native PostgreSQL catalogue through
`20261123150000_subscription_renewal_due_fairness.sql`.
