Apply the checkout recovery reminder guard and episode pin migrations before
using the target installer. Pinned episodes keep their timing and are exempt
from the schedule-change guard. An older pending checkout order with a wave
and no pin blocks a change regardless of age with
`checkout_recovery_schedule_change_blocked_open_episodes`.
The same refusal applies to an unpinned pending abandoned cart with a wave, a
valid draft receipt and no settlement intent. Keep the current schedule until
the blocking orders close or their carts stop qualifying.

Changed installs and reminder producers at `REPEATABLE READ` or `SERIALIZABLE`
refuse with `checkout_recovery_schedule_isolation_unsupported`. With an installed
schedule, a compacted checkout wave consumes both stages and the later stage
is skipped. With no schedule installed, historical hours identify its stage.
