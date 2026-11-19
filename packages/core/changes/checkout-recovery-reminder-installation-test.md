Apply the checkout recovery reminder guard migration before using the target
installer. A pending checkout order with a wave blocks schedule changes
regardless of age with `checkout_recovery_schedule_change_blocked_open_episodes`.
The same refusal applies to a pending abandoned cart with a wave, a valid draft
receipt and no settlement intent. Keep the current schedule until those orders
close or the carts stop qualifying.

Changed installs and reminder producers at `REPEATABLE READ` or `SERIALIZABLE`
refuse with `checkout_recovery_schedule_isolation_unsupported`. With an installed
schedule, a compacted checkout wave consumes both stages and the later stage
is skipped. With no schedule installed, historical hours identify its stage.
