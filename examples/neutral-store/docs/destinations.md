# Message destinations

Status: localized navigation checked on base-version development candidates.
Valid-grant and durable-action proof remain pending.

`shared/routes.ts` owns the application routes and the sample message-link
inventory. The message-links page follows the same table. Query values in
samples are deliberately invalid. Authentication and access grants must be
verified by the host binding; no route infers authority from a typed reference.

| Destination | English | Polish |
| --- | --- | --- |
| Builder | `/build-your-box` | `/skomponuj-pakiet` |
| Customer dashboard | `/account` | `/konto` |
| Classic package editor | `/account/edit-package?subscription=<uuid>` | `/konto/edytuj-pakiet?subscription=<uuid>` |
| Size-aware editor/invitation | `/account/edit-sizes?subscription=<uuid>` | `/konto/edytuj-rozmiary?subscription=<uuid>` |
| Payment repair | `/account/payment/recover` | `/konto/platnosc/napraw` |
| Checkout completion | `/account/complete-payment` | `/konto/dokoncz-platnosc` |
| Returns | `/returns` | `/zwroty` |
| Terms | `/terms` | `/regulamin` |
| Invoice/order action | `/account/orders` | `/konto/zamowienia` |
| Operator landing | `/admin` | `/pl/admin` |
| Signed unsubscribe | `/unsubscribe` | `/pl/unsubscribe` |
| Legacy unsubscribe | `/unsubscribe/legacy` | `/pl/unsubscribe/legacy` |
| Host sign-in | `/auth/sign-in` | `/pl/auth/sign-in` |
| Partner inquiry operator view (T07-12) | `/admin#partners` | `/pl/admin#partners` |
| Static support (T07-13) | `/support` | `/pomoc` |
| Tracking | `/tracking` | `/przesylka` |
| Review | `/review` | `/opinia` |

The terms and returns pages explicitly describe a fictional demonstration.
Editor references select a session-owned subscription; a URL grants no authority.
Only the classic invitation adds `optIn=1`. Entry and abandonment do not change
the offer, and confirmation requires priced review and explicit consent.
The inquiry message opens the operator partner panel, which requires a native
operator session to read intake. Support is static contact text and an account
link; it contains no form. Public partner intake lives at `/partners` and
`/partnerzy` and persists through the native partner port. Tracking is captured sandbox evidence, not a carrier claim.
Signed unsubscribe requires an explicit user action and changes only the signed
permission. Legacy unsubscribe returns
`native_legacy_tester_source_unavailable`. Review submission requires a live
order grant and does not grant marketing consent.

Captured message composition must use these local URLs and real scoped tokens
when its bindings land. The native compatibility destinations retained here do
not authorize importing the reference application's UI or link helpers.
