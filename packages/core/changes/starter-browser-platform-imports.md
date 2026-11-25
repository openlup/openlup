### Starter browser code imports platform values from browser-safe entries

The starter's `client/quote-acceptance.ts` and `shared/offer-estimate.ts` now take
`acquisitionTermsSchema` and `deriveSubscriptionUnitPrice` from
`@openlup/platform/pricing/browser`, and `ACQUISITION_TERMS_CAPABILITY` from
`@openlup/platform/pricing/contracts`, instead of the Node-oriented
`@openlup/platform/pricing` entry. Behaviour is unchanged. In your own
`client/` or `shared/` code, import runtime values only from a browser entry
(`…/contracts`, `account-support/read-contracts`, `pricing/browser`, `commerce`,
`marketing`, `operations`, `storefront`), use `import type` for types, and keep
host-only modules under `host/`.

Migration: Upgrade replaces pristine copies of both files. If apply reports that
a managed file has local edits, keep your edits separately, restore the file
from the installed starter version, rerun apply and reconcile your edits with
the replacement. A customised copy that still imports from
`@openlup/platform/pricing` keeps working; change those imports to the browser
entries when convenient. This upgrade requires no installed-policy step.
