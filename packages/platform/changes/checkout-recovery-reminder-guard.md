- Create each reminder stage at most once per order. A pending checkout order
  with a wave blocks schedule changes regardless of age with
  `checkout_recovery_schedule_change_blocked_open_episodes`. The same refusal
  applies to pending abandoned carts with a wave, a valid draft receipt and no
  settlement intent. Changed installs and producers at `REPEATABLE READ` or
  `SERIALIZABLE` refuse with `checkout_recovery_schedule_isolation_unsupported`.
  With an installed schedule, a compacted checkout wave consumes both stages
  and the later stage is skipped. With no schedule installed, the historical
  hour rule applies.
