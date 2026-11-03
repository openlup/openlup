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

Every N5 action is visible on both account and limits pages in Polish and English and
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

Demonstration sessions run in a single process, expire after one hour, have
capacity 1000 and are lost on restart. This is not a production session store.
The captured demonstration mailbox is not a real mailbox; its private file
contains sign-in tokens and requires runtime filesystem access.

With the runtime URL supplied by lifecycle, native customer challenges and
opaque host sessions bind reduced profile/subscription-control reads, selected
owned order headers/detail, newsletter read/withdraw and reduced OMS order
list/detail. Full account projection sources remain unavailable
(`starter_account_projection_binding_required`); newsletter grants and other
purposes wait for the consent lifecycle and refuse `host_binding_required`.
The account order response does not claim a rich customer-order projection.
Native detail preserves `native_account_order_money_unavailable` when a historical
order lacks captured money; it never reconstructs purchase truth.

Purchase, invoice history/artifacts, shipment list/detail and dependent label,
handoff, delivery and tracking bindings, signed unsubscribe and other unmounted
workflows remain pending. Shipment reads follow destination/reservation facts;
dispatch preparation alone does not provide them.
`operator.returns` waits on returns reader; r1a continues to refuse it with
`host_binding_required`.
Unbound operations return
`host_binding_required` after customer/operator admission. These are implementation
blockers, not additional accepted native limits. An invalid-grant example does
not prove a valid grant works. Completion still requires the real purchase,
account and operator browser journey in both configurations.

Both example catalogues price in `XTS` test units for fictional market `ZZ` at
`UTC`. These choices make no real tax, shipping or compliance claim. The selected
configuration is a non-secret `--configuration` argument. The one-command
installation target defaults from the owned registry. CLI transport does not
supply an installation capability.

## Partner intake and reviews

No generic contact form; the partner inquiry is the durable intake.
Support is static and shows optional validated `supportEmail` as plain text,
with an account link. Missing contact configuration is stated explicitly.
The application declares 52 operations. With a runtime connection, the partner
submit/list/transition and review read/submit/list/moderation actions are mounted.
Without that connection they remain unbound, like the other native actions.

Partner requester quotas use a hash of the socket peer, never the email or a
forwarded header. A proxy therefore shares one requester quota across its users;
this local host does not establish trusted proxy admission. Native quotas are
five requester attempts and three email attempts per 60-minute window; command
replay precedes the quotas, and repeated contact submits conflict. The native
contact deduplication has no time-based expiry. Public success returns only the
case reference; contact details are visible through the authorized operator view.

Review read and submit require an accepted, unexpired native order review grant.
Invalid references do not prove positive grant behavior. Expired-grant refusal,
positive review submit/read, publish/hide with a real review, grant expiry and
revocation, and purchase-generated grant ownership remain acceptance duties of
the purchase composition contribution. This slice claims none of them.
Operator list/moderation admission reuses native human membership, rechecked on
requests; a customer session supplies no operator authority.

Tester application submission is a public durable write through the native
acquisition case port. The adopter-owned seed follows the owner-loaded registry
contract in the acquisition foundation migration header, lines 16-17. The owned
fictional address registry is loaded only by the install connection in the same
marked demonstration transaction as the catalogue seed. Repeating installation
verifies the existing tuple; a changed provenance or inactive row fails with
`starter_acquisition_seed_conflict` and rolls back. The browser submits a choice
identifier, email, explicit consent and locale only. The host refuses extra fields
including raw reference/source/revision/provenance, supplies the tuple, policy
revision and fixed source path, and derives requester identity exactly as partner
intake does. Native replay, contact conflict and peer/email quotas still apply.
Names are not collected or stored. Public success exposes only the case reference;
no operator acquisition endpoint is declared.

Operator customer search and detail remain unbound: the native support journey
reader additionally requires an active communications operator roster entry,
which the human session does not provision. No second operator authority is
seeded or inferred. Bundle and catalogue administration remains unbound; N1 is
unchanged.

Research remains `host_binding_required` until the host can authorize ownership
of the research case (`authorizeResearchCase`); normalized ingest also remains
`host_binding_required`. Neither action is mounted merely to return a refusal.
