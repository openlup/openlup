# Starter routes

Use these localized paths when linking to the starter store. A path or typed
reference selects a page; the host still verifies the session or scoped grant
needed by its action.

## Localized paths

`shared/routes.ts` defines the routes. Product detail appends an encoded slug to
the product-list path. The message-links page uses the same route map; its sample
query values are deliberately invalid credentials.

| Destination | English | Polish |
| --- | --- | --- |
| Home | `/` | `/pl` |
| Product list | `/products` | `/produkty` |
| Product detail | `/products/<slug>` | `/produkty/<slug>` |
| Builder | `/build-your-box` | `/skomponuj-pakiet` |
| Cart | `/cart` | `/koszyk` |
| Checkout | `/checkout` | `/zamowienie` |
| Customer dashboard | `/account` | `/konto` |
| Classic package editor | `/account/edit-package?subscription=<uuid>` | `/konto/edytuj-pakiet?subscription=<uuid>` |
| Size-aware editor | `/account/edit-sizes?subscription=<uuid>` | `/konto/edytuj-rozmiary?subscription=<uuid>` |
| Payment repair | `/account/payment/recover` | `/konto/platnosc/napraw` |
| Checkout completion | `/account/complete-payment` | `/konto/dokoncz-platnosc` |
| Returns | `/returns` | `/zwroty` |
| Terms | `/terms` | `/regulamin` |
| Invoice and order actions | `/account/orders` | `/konto/zamowienia` |
| Operator landing | `/admin` | `/pl/admin` |
| Partner inquiry operator panel | `/admin#partners` | `/pl/admin#partners` |
| Signed unsubscribe | `/unsubscribe` | `/pl/unsubscribe` |
| Legacy unsubscribe | `/unsubscribe/legacy` | `/pl/unsubscribe/legacy` |
| Sign-in | `/auth/sign-in` | `/pl/auth/sign-in` |
| Sign-in callback | `/auth/callback` | `/pl/auth/callback` |
| Support | `/support` | `/pomoc` |
| Public tracking entry | `/tracking` | `/przesylka` |
| Review | `/review` | `/opinia` |
| Acquisition application | `/participate` | `/zgloszenie` |
| Research entry | `/research` | `/badanie` |
| Public partner inquiry | `/partners` | `/partnerzy` |
| Application limits | `/limits` | `/ograniczenia` |
| Sample message links | `/destinations` | `/linki` |

## Entry authority and effects

Editor links select a session-owned subscription. The invitation from a classic
subscription to size-aware editing adds `optIn=1` to the size-aware editor URL.
Entering or leaving that page does not change the offer; applying the opt-in
requires a priced review and explicit confirmation of consent.

Checkout completion accepts a scoped recovery token and removes it from browser
history before loading configuration or rendering. It grants no account or
subscription-command access. See
[recovery ownership](../concepts/starter-ownership.md#checkout-continuation-and-recovery).

The partner operator panel requires a native operator session to read intake.
The public partner pages persist inquiries through the native partner port.
Support shows static contact text and an account link, without a form.
The terms and returns copy describes a fictional demonstration; replace it with
your application's policy.

The signed-unsubscribe page requires an explicit user action, but its
`unsubscribe.apply` action has no host binding and refuses with
`host_binding_required`; opening or submitting this page changes no permission. Legacy unsubscribe refuses with
`native_legacy_tester_source_unavailable`. Review submission requires a live
order grant and does not grant marketing consent. Public tracking lookup refuses
with `starter_tracking_access_unavailable`; the route does not establish a
carrier delivery claim. Research submission refuses with
`host_binding_required` until an authorized case binding exists.

Use local destinations and genuinely scoped tokens in your own message
composition. Keeping a compatible path does not require adopting another
application's UI or link helpers.
