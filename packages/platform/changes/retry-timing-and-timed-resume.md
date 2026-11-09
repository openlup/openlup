Fence late retry case observations after lifecycle closure, including after a
later resume. Timed auto-resume now skips ineligible windows without failure,
rolls forward by whole cadences and records one system event; the lifecycle
messenger maps that event to the resumed confirmation.

Expose `createPostgresSubscriptionAutoResume` through `subscriptions` and trusted
`CycleRetryCadence.backoffHours` configuration through native retry stores and
bindings. Defaults and terminating failure-class behavior remain unchanged.
Install the complete native migration catalogue before selecting these entries.

Migration: Existing retry-store callers keep their one-argument construction and
24/72/168-hour defaults. To override timing, pass `{ backoffHours }` as the
store's second argument or `retryCadence` in the native binding's retry options.
Install the complete catalogue including the new timing overload first. Hosts
may then bind `createPostgresSubscriptionAutoResume(executor).run` to their
scheduler; construction schedules no work. No browser policy field is added.
