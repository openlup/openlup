- Add explicit native commerce creation and operator-attempt recording with cancellation composition. Local creation checks settled money, recorded order mode, contact, holds, cycle and reservations before committing a parcel; it makes no provider call.
- Add selected native dispatch candidates and final admission, actual-command shadow fingerprint forwarding, draft promotion/refresh and durable neutral failed/uncertain diagnostics. Operator audit attempts remain separate from command proof attempts.

Migration: install the complete selected catalogue through `20261120110000_fulfillment_dispatch_outcomes.sql` before using these factories or the updated native dispatch store. Select `nativeDispatch: { portKey, providerRef }` or retain the existing host reader/list composition. Supply the adapter's pure `shadowCommandFingerprint` to preserve actual command identity across shadow and stage.

Migration: same-parcel/provider mapped-attempt replay returns the first attempt across draft refresh and promotion. Submitted references retain their mode and command identity. Existing dispatch outcomes stay NULL; no historical contacts, reservations, modes or acceptance proofs are reconstructed. Connected native transfers include the new private operator-attempt table.

Migration: the reference adapter preserves unreadable rejection bodies as network uncertainty, including HTTP 400. Readable definite rejections remain failed. Neither failed nor uncertain outcomes authorize automatic resubmission. No hosted provider qualification is implied.
