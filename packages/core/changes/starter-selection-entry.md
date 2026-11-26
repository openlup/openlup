### The starter cart opens with a selection from its address

The neutral starter's cart route now accepts a selection in its query string:
`line=<sku>:<quantity>` (repeated), `mode` (`one_time` or `subscription`) and
`cadence` (days, subscription only), for example
`/cart?mode=one_time&line=<sku>%3A2`. A buy link or a verification harness can
open checkout in a fresh browser without seeding browser storage. Build links
with `selectionEntryPath` from the new managed `shared/selection-entry.ts`.

- The cart validates the selection with `validateCart` against the storefront
  catalogue. It waits for the catalogue answer, and leaves the address unchanged
  when the catalogue answers with an error.
- A valid selection replaces an empty cart. A cart that holds anything else
  shows a question, "Use the selection from the link" or "Keep my cart", and
  offers no other cart control or checkout until the buyer answers. The entry
  never merges lines.
- An invalid selection shows its own refusal with the cart's texts, prints no
  raw link text and writes nothing.
- Once decided, only `line`, `mode` and `cadence` leave the address, with one
  history replacement. Every other parameter stays with its bytes and has no
  effect; no price, amount or currency is ever read.
- The cart's checkout button carries
  `data-openlup-action="proceed_to_checkout"`, written from `storefrontAnchor`.
  The starter now imports that value from the experimental
  `@openlup/platform/storefront` entry.
- `PageContext` gains an optional `catalogueSettled` field, and `navigate`
  takes an optional `{ replace: true }` second argument.

A link over an emptied cart after an order was placed in the same tab cannot
create a second order: the next submit reuses the tab's checkout key and the
host refuses a changed payload under it with `starter_checkout_changed`,
`starter_checkout_paid` or `starter_checkout_not_payable`. That safety comes
from the host's refusal of a changed payload; a host that updated the order in
place would behave differently.

Migration: Upgrade adds `shared/selection-entry.ts` and its test, and replaces
pristine copies of `client/pages/storefront.ts`, `client/main.ts`,
`client/context.ts` and `docs/customization.md`. If apply reports that a managed
file has local edits, keep your edits separately, restore the file from the
installed starter version, rerun apply and reconcile your edits with the
replacement. A store that owns its cart page or `client/main.ts` keeps its copy
and gets neither the entry nor the anchor; to add them, import
`decideSelectionEntry` and `withoutSelectionEntry` from
`shared/selection-entry.ts`, and set `catalogueSettled` from the catalogue
request, or accept that the entry validates before the catalogue answers. This
upgrade requires no installed-policy step.
