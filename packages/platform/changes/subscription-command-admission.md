Unreleased; next minor. Add stable `SubscriptionCommandAdmission` in the existing
subscriptions/contracts subpath and optional `admitSubscriptionCommand` on the
native command binding. Omitting it preserves existing behavior. Fresh preview
and apply evaluate effect-free owned policy after ownership, key locking and
receipt/fingerprint replay, before translation, pricing or writes. Thrown named
errors propagate with no durable refusal receipt. Native lifecycle, payment and
delivery fences remain unconditional. Completed matching commands replay after
policy narrows; payload conflicts still refuse before admission.

The source starter owns account action lists and pause choices in
`owned/renewal.config.ts`. The account pause form preselects the preset default
(`2_weeks` in the demo) and the cancellation save offer keeps its own
`retention.pausePreset` (`1_month`), so starter defaults are unchanged.

Migration: no SQL, schema or installed-policy changes. This additive stable API
requires the next minor set, not a 1.0.x patch; no release is prepared here.
Opt in through host composition; never place the callback in a browser payload
or perform I/O from it. When upgrading starter application files, add
`subscriptionCare.actions` and `pausePresets` to the owned input. Invalid lists
or defaults refuse startup. A removed choice affects fresh work only.
