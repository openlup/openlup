### The starter checkout page keeps one checkout key per purchase

The neutral starter's managed checkout page now keeps one `checkout.create`
key for each purchase in the browser tab. It stores the key in tab storage
under `neutral-store:checkout-continuation:v1:<configuration>` before the first
request leaves the browser. After a lost response, a reload or a retry
continues the same order instead of creating a second order and a second stock
hold. The page starts a new key only after the host confirmed that the earlier
order is closed, or that no order exists and none can still arrive. "No order"
counts as final only 15 seconds after the last create settled; when the browser
lost that create in transport, only 35 seconds after it was sent. For a record
from an earlier page load, it counts as final no earlier than 15 seconds after
the reload and 35 seconds after the create was sent. A refusal that wrote
nothing keeps the key, and the panel does not appear on load after it.

Changed details, or a later purchase in the same tab while an unpaid order
exists, answer `starter_checkout_changed` and open a panel. The panel also
appears on load when the tab holds an earlier order or an uncertain create. It
offers "Complete payment for the earlier order", which shows the order's total
and then its payment link. It also offers "Cancel the earlier order and start
over", which cancels the unpaid order and releases its stock. After
`starter_checkout_not_abandonable` or `starter_checkout_expired` it also offers
"Start a different purchase". That choice leaves the earlier order open until
the store settles it; a payment already started for it may still complete. The
checkout form no longer has the "Start a new action" button; other forms keep
it. The completion page ends the key when it shows the order under it as paid,
cancelled or expired.

A browser that blocks tab storage sees `starter_storage_unavailable`. Its form
keeps the key in the page across retries and refused totals, until a reload or
changed details, or the buyer chooses "Start a new action". The page raises `starter_checkout_session_changed` when an
answer belongs to another sign-in state: sign in or out as when the order was
placed. If the host answered with an order of the current sign-in state, the
page also shows that order, and says when it was cancelled. It raises
`starter_checkout_in_progress` when an earlier create may still be running. An
order cancelled from the panel carries `checkout_started_over`.

Apply the application file upgrade to replace pristine managed files:
`client/forms.ts`, `client/purchase.ts`, `client/pages/checkout.ts`,
`client/quote-acceptance.ts`, `client/api.ts`, `shared/api.ts` and
`shared/limits.ts`. If it reports a
conflict, reconcile your customised files with the target starter. The buyer
texts of the panel and its answers are the managed `checkoutContinuationCopy`
export in `shared/limits.ts`; re-apply any customised text after the upgrade.

If your store owns its checkout page, follow the guide's rules: one random
version 4 key per purchase, stored before the first request; a new key only
after a confirmed end, never after a transport error; "no order" final only
after your request timeout plus 15 seconds; and the key treated as a
credential, never logged or reused. Changed details under the key answer
`starter_checkout_changed`, so the page need not compare details itself.
