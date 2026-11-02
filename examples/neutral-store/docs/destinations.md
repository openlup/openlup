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
| Payment repair | `/account/payment/recover` | `/konto/platnosc/napraw` |
| Checkout completion | `/account/complete-payment` | `/konto/dokoncz-platnosc` |
| Returns | `/returns` | `/zwroty` |
| Terms | `/terms` | `/regulamin` |
| Invoice/order action | `/account/orders` | `/konto/zamowienia` |
| Operator landing | `/admin` | `/pl/admin` |
| Signed unsubscribe | `/unsubscribe` | `/pl/unsubscribe` |
| Legacy unsubscribe | `/unsubscribe/legacy` | `/pl/unsubscribe/legacy` |
| Host sign-in | `/auth/sign-in` | `/pl/auth/sign-in` |
| Inquiry | `/inquiry` | `/zapytanie` |
| Support | `/support` | `/pomoc` |
| Tracking | `/tracking` | `/przesylka` |
| Review | `/review` | `/opinia` |

The terms and returns pages explicitly describe a fictional demonstration.
Inquiry and support capture locally through their bound capability; they do not
send real email. Tracking is captured sandbox evidence, not a carrier claim.
Signed unsubscribe requires an explicit user action and changes only the signed
permission. Legacy unsubscribe returns
`native_legacy_tester_source_unavailable`. Review submission requires a live
order grant and does not grant marketing consent.

Captured message composition must use these local URLs and real scoped tokens
when its bindings land. The native compatibility destinations retained here do
not authorize importing the reference application's UI or link helpers.
