# Portable sandbox limits

Status: current draft UI refusals; required native bindings remain pending.

The app's `/limits` and `/ograniczenia` pages render the same canonical table as
the visible action buttons (`shared/limits.ts`). A refusal is an observed
unavailable action, never a simulated success. Codes beginning `starter_` name
application composition limits; they are not claims of exported package errors.

| Limit | Actions | Named refusal |
| --- | --- | --- |
| N1 | Catalogue/prices/promotions are seed data; one owned demo-seed step with the install connection; no runtime catalogue/price administration or checkout promotion codes | `starter_promotion_write_unavailable` |
| N2 | Operator email/phone correction and account linking | `operator_subscription_authority_unavailable` |
| N3 | Order note and order-address correction | `starter_order_correction_unavailable` |
| N4 | Replacement request and complete fulfillment cancellation | `host_binding_required` |
| N5 | Saved addresses, billing profiles, delivery preferences, payment preferences, private-profile views and the profile/address/billing/private-profile views action | `starter_account_preferences_unavailable` |
| N6 | Real PSP, payment method setup, card replacement and unsupported money recovery | `native_prepared_attempt_store_unsupported` |
| N7 | Customer profile edit | `starter_profile_edit_unavailable` |
| N8 | Exact generic recipe/mix/portion commands | `subscription_command_unsupported_action` |
| N9 | Rich OMS, commercial analytics, payment links and saved draft resume | `starter_rich_oms_unavailable` |
| N10 | Google sign-in | `oauth_not_supported` |
| Inventory boundary | Lot traceability, locations and stock movements | `starter_inventory_traceability_unavailable` |

The portable rail has no runtime writer for `catalog_products`, `catalog_skus`,
`price_lists` or `price_entries`. Under N1, `owned/demo-seed.ts` builds their
fictional rows from the same typed configuration; `installation/install.ts`
applies one transactional, idempotent step during `./lifecycle up`, using only
the install connection after installed bootstrap. It refuses absent bootstrap
(`starter_installation_binding_required`), a runtime login or current role
(`starter_seed_runtime_role_forbidden`), a different install identity
(`starter_seed_install_role_required`) and a database without the demonstration
marker (`starter_seed_demonstration_database_required`). The one-shot bootstrap
uses the complete installed history and refuses any pre-existing unmarked database.
Purchase and subscription qualification remain pending.
Promotions remain seed configuration, with no runtime administration.
Clients, stock and settings must use their native writers; never seed them. Purchase, renewal terms and
method states are never replaced by hand-written application rows.

The portable rail has **no lot traceability, locations or stock movements**.
Readers of the supplement and coffee configurations may expect these features;
the examples provide none of them and make no health or compliance claim.
The same statement is visible in both locales on the limits page.

Every N5 action is visible on both account and limits pages in PL and EN and
refuses with `starter_account_preferences_unavailable`, including private-profile
views and the combined profile/address/billing/private-profile views action.

Sandbox payments only are in scope on this rail. Real-money commerce currently needs a
separately qualified rail and provider; this app does not claim real-money
provider independence. An existing subscription is never paused or frozen by
these refusals. The starter does not expose confirmation of an undelivered
replacement parcel.

Other explicit boundaries: monetary refund creation, receiving/restocking
returns and catalogue publication are unavailable; no legacy participant source
exists; media bytes need a proper storage binding. Reduced OMS reads do not
stand in for rich projections. Review grants do not establish account sessions,
and account sessions do not establish authority over an arbitrary research case.

Reviews, acquisition, research and partners are limited to their declared ports.
Partner inquiry does not grant marketing consent, convert a customer or provide
partner privacy export/erasure. Risk is off. Market inputs are not tax-compliance
certification. Normalized ingest has no real marketplace connector.

Required purchase, account, invoice, fulfillment, signed-unsubscribe and identity
bindings are still pending. They return `host_binding_required` or the relevant
authority refusal. Those are implementation blockers, not additional accepted
native limits. In particular, an invalid-grant example does not prove that a
valid grant works. Completion requires the real positive and refusal journeys.
