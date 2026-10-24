- Keep active subscriptions unchanged when the retry ladder is exhausted; the compatibility function emits no pause event and retains historical paused-row recovery.

Migration notes: Exhaustion no longer changes an active subscription to paused. Existing paused records are not rewritten; explicit customer lifecycle commands and historical recovery remain separate.
