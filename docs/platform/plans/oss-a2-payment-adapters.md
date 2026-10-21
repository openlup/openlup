# A2 payment example adapters

Status: development-preview implementation ledger, 2026-10-21. O-P1 and O-P2 supply
opt-in Node examples behind M07's neutral payment ports. It makes no stable
framework, account activation or release claim.

## Owner and coordinator decisions

- Owner, 2026-10-21: Stripe and Tpay are opt-in,
  default-off example adapters behind M07 neutral payment ports; adopters may
  replace them. O-P1 implements
  Stripe; O-P2 implements Tpay.
- Owner “Approve O1–O3 (Recommended)”: O1 preserves observed behaviour only.
  Refund creation and an authorization/capture split are honestly `unsupported`.
  O2 injects the host's structural SDK client: no SDK dependency or SDK import
  is added anywhere in packages. O3 keeps account-dependent capabilities
  `verification_pending` until owner TEST readback in O-P3.
- C1 freezes exactly three public symbols: `createStripePaymentAdapter`,
  `type StripePaymentAdapterConfig`, `stripePaymentCapabilities`.
- Ruling C retains donor modules and their characterization logic unchanged,
  except mechanical import/fixture relocation, neutral reference identity and
  Decision 2 currency/provider-kind fixture neutralization.
  New glue composes these modules into M07 without changing the neutral ports.
  Host environment and feature flags, SDK construction, credentials and provider
  configuration remain outside this entry.
- D3 authorizes the ui-13/ui-14 path/token allowance for the adapter source and
  tests, API report, exact registration tokens and this ledger. The market currency token is allowed only in the Tpay source/test directories. No baseline
  increase is authorized. Paired plants keep
  outside vocabulary counted.
- M07 requires refund evidence. Stripe `amount_refunded` is an explicit
  cumulative snapshot with the original payment money and stable charge ID.
- Coordinator Decision 1 permitted a temporary dispute refusal against M07 P1.
  With M07 P2 integrated, `mapStripeOutcome` preserves the donor dispute outcome
  as `disputed`, with the original payment identity and the dispute amount. The donor
  normalizer stays unchanged.
- Coordinator Decision 2 makes currencies host-declared through the required
  `supportedCurrencies` config: a non-empty list of upper-case three-letter
  codes, validated at construction. The exported descriptor has an empty list;
  each constructed adapter advertises its host list. Currency fixtures use EUR
  and eur; the provider-kind fixture includes only this adapter. No allowance
  or baseline changes accompany this neutralization.

## O-P1 boundary and host responsibilities

`@openlup/platform/payments/stripe` shares the existing platform package and its
release and maintenance lifecycle. Importing installs no route or binding and
performs no provider I/O. The host explicitly constructs the adapter, supplies
its structural client and signing secrets, selects live/test mode and owns
account readiness, customer association, timeouts, transport and SDK policy.
`clock` returns UTC seconds. Signature tolerance defaults to 300 seconds.

The structural client's create call follows the donor input contract; the host
must translate that input to its selected SDK. In particular an off-session
request must be confirmed server-side and associated with the saved method's
customer. The host must restrict the offered interactive methods to the stated
card/wallet contract. This package does not construct an SDK or read environment.
Pure intent-mapping helpers remain private implementation details.

The adapter offers client-confirmed payments, saved-method unattended charges,
verified money/method observations and purpose-sensitive readback. The host
declares supported currencies through the required adapter config. A client
exposing cancellation additionally enables close; otherwise the callable is absent and close is unsupported.
No refund creation or authorization/capture split is offered.

Exact absence is unsupported and its optional port is absent. The donor metadata
search returns IDs for a local intent without an exact attempt/money identity
or completeness proof. It cannot establish M07's bounded exact absence.

Provider event IDs remain the event's own ID; fingerprints omit receipt time,
raw bodies, provider prose and transient secrets. Missing provider time stays
null. Setup and payment-method observations use the method evidence union;
refund observations require a validated cumulative snapshot. A synchronous
issuer decline is a neutral refusal with unknown dispatch, never invented
pre-dispatch evidence. Ambiguous transport errors retain their thrown result.
The host keeps one-time handoffs in memory and persists only safe diagnostics.

The current descriptor has no verification-state field. Card/wallet availability,
unattended charging, account currencies and cancellation remain
`verification_pending` at the account level pending O-P3 TEST evidence. The
published supported fields describe witnessed protocol behavior only.

## Evidence and remaining work

Offline donor characterization and new glue tests use synthetic injected
clients. The installed-consumer proof imports the exact subpath without an SDK
or ambient network access and checks its runtime export inventory, injected
execution and refusal boundary. No provider-account verification is claimed.
Detailed per-file provenance, unchanged-versus-glue comparisons, exact case
counts, timings and local check results belong to the existing task evidence.

The O-P1 offline conformance witness now runs the M07 P2 runner against two
distinct intents and attempts, with replay, outcome changes, cumulative refunds
and verification refusals. The adapter carries donor-filtered source event type,
refund charge identity and failure provenance as audit facts outside the
fingerprint; absent donor facts remain absent.

O-P3 account verification/reference binding
remain separate work. Committed
native review, broad gates, submission and any release remain with the active
supervisor; these local checks grant none of that authority.

## O-P2 boundary and named deltas

`@openlup/platform/payments/tpay` exports exactly `createTpayPaymentAdapter`,
`type TpayPaymentAdapterConfig` and `tpayPaymentCapabilities`. The host explicitly
supplies HTTP credentials/fetch, callback and return URLs, mode, Model O
activation policy, certificate root, HTTPS certificate directory prefix ending
in `/`, and an asynchronous certificate resolver. Importing performs no I/O,
reads no environment and installs no route or default binding. The resolver
owns redirect and egress policy. Clock values are UTC seconds.

The adapter declares only its supported market currency. Bank-redirect,
one-time-code and unattended Model O alias attempts are supported when the host
supplies payer and method selection through the canonical M07 P3 attempt input.
The temporary local intersection has been removed; donor behavior is unchanged.
Explicit transient payer context is required for all three flows. Bank redirects
use the selected channel; code attempts use transient customer authorization;
unattended charges use the stored reference and recorded Model O mandate.
Missing payer/channel/code, Model M and unknown mandate models refuse before
dispatch with neutral data-correction evidence. The return envelope admits only
neutral diagnostics, excluding payer, authorization and donor request/response
payloads. API transaction ID drives readback; notification title remains distinct.
The public factory does not offer alias registration or recurring cards.
Account-dependent offers remain `verification_pending`
until O-P3 owner TEST readback; protocol witnesses do not establish activation.
Refund creation, split authorization/capture, close and exact absence are
unsupported. Transaction-ID readback is neither a complete bounded search nor
absence proof. Refunded/chargeback readback stays unknown for host manual review.
Pending and refused readback report validated configured transaction money,
including when the paid amount is zero, retaining the donor's pending/failed
classification for both purposes. Succeeded readback requires the donor's paid
amount to equal expected money; underpayment and overpayment stay unknown for
manual review. Identity, configured-money and reversal checks reuse the donor
recovery function. The reversal guard uses the
donor's status fallback fields as well as its primary status field.

Named deltas from the contributed donor:

1. Verify certificate validity and notification freshness. Root and prefix are
   required construction inputs; signing and root certificate validity windows
   use the injected clock. A verified protected-header `iat` is interpreted as
   UTC seconds. Maximum notification age defaults to seven days, a generous
   assumption while the provider retry schedule is unconfirmed. Future signed issue
   time beyond `maxClockSkewSeconds` (default 300) after receipt refuses as stale. A missing
   assertion leaves provider time null; the host deduplicates by exact event
   identity and fingerprint. No receipt timestamp becomes provider time.
2. Transaction event identity combines the payment reference and verified outcome
   class. Method identity combines event/alias and method outcome. The donor
   normalizer retains its original identity mapping; only factory glue adds the
   neutral envelope identity. Fingerprints exclude receipt time and secrets.
3. Receipt time participates only in signed notification freshness.
4. Attempt glue consumes the canonical optional payer/method contract fields,
   refuses missing context before dispatch and excludes transient payer and
   authorization from its return envelope. Missing or blank payer name uses
   the donor neutral display label `Customer`. Only typed donor no-charge errors
   return exact before-dispatch evidence with core's transient retryable refusal;
   other execution errors propagate unchanged as ambiguous.
5. Neutrality admits the reporting zone only on the exact readback declaration
   line at its exact source path, with paired outside-line/path refusal plants
   and no baseline increase.

CHARGEBACK is a `refunded` money observation with explicit `full-reversal`,
`reason: "chargeback"`, original money and a stable operation ID. Missing original
money or currency refuses. No M07 P2 disputed outcome is required.
Donor source and tests retain behavior except import relocation and private
identity removal: neutral aliases/labels/hosts/return paths and subject keys,
and removal of the mapper's host environment reader. The private execution
slice keeps the donor customerRef payer fallback with a neutral display label;
the public factory requires explicit transient payer context before that slice.
The donor witness retains its customerRef-only base fixture.
The synthetic certificate fixture adds
root lifetime and signed issued-at controls for the named validity/freshness
cases. Other donor outcomes outside M07 remain in one named refusal mapping;
unrecognized alias lifecycle events refuse `unsupported-event`.

O-P2 donor witnesses are moved-pending: OpenLup root source retires in O-P3 and
the private donor suite in C5. New glue cases are counted separately in task
evidence; no donor case is trimmed to satisfy the estimate. The offline M07 P2
conformance witness now exercises two distinct intents and attempts, separate
amounts and provider references, replay, chargeback and verification refusals.
Both subjects supply transient payer email and non-empty name, exercising the
runner's payer exclusion checks without changing case counts.
The audit carrier preserves the donor's filtered transaction and alias dialect
(`eventKind`, `event`, `aliasType`); absent failure provenance and prose remain
absent. Payer, authorization, certificates and raw bodies are excluded, and audit
facts do not change fingerprints. Git, staged inventory, full gates and native
candidate review remain with Claude.

## Case ledger (coordinator budget ruling A)

The programme budget of +100 cases / +30 s counts net-new cases. A test carried unchanged from the adopter is a move, and stays `moved-pending` until its source copy retires: the OpenLup root reference copy at O-P3, the adopter copy at its C5 swap-in. A2 is not done while any row is still `moved-pending`; a source copy that cannot retire turns its cases into new ones. Generated package-boundary rows are excluded, consistent with M07. The +30 s time budget is measured on hosted CI.

### O-P1 Stripe

| Source (adopter) | Destination (`packages/platform/test/payments/stripe/`) | Cases | Status |
|---|---|---:|---|
| server/adapters/stripe/a2StripeKeysAndDeclinesCharacterization.test.ts | `a2StripeKeysAndDeclinesCharacterization.test.ts` | 3 | moved-pending: adopter copy retires at C5 |
| server/adapters/stripe/a2StripeRefundCharacterization.test.ts | `a2StripeRefundCharacterization.test.ts` | 2 | moved-pending: adopter copy retires at C5 |
| server/adapters/stripe/a2StripeSignatureCharacterization.test.ts | `a2StripeSignatureCharacterization.test.ts` | 3 | moved-pending: adopter copy retires at C5 |
| server/adapters/stripe/a2StripeStatusCharacterization.test.ts | `a2StripeStatusCharacterization.test.ts` | 3 | moved-pending: adopter copy retires at C5 |
| — | `conformance.test.ts` | 1 | net-new |
| server/adapters/stripe/declineFailureHints.test.ts | `declineFailureHints.test.ts` | 41 | moved-pending: root `server/adapters/stripe/declineFailureHints.test.ts` retires at O-P3; adopter copy at C5 |
| server/adapters/stripe/executionDecline.test.ts | `executionDecline.test.ts` | 10 | moved-pending: root `server/adapters/stripe/executionDecline.test.ts` retires at O-P3; adopter copy at C5 |
| — | `factory.test.ts` | 16 | net-new |
| server/adapters/stripe/stripeFailureEvidence.test.ts | `stripeFailureEvidence.test.ts` | 16 | moved-pending: root `server/adapters/stripe/stripeFailureEvidence.test.ts` retires at O-P3; adopter copy at C5 |
| server/adapters/stripe/stripeIntentConfirmationEvidence.test.ts | `stripeIntentConfirmationEvidence.test.ts` | 12 | moved-pending: root `server/adapters/stripe/stripeIntentConfirmationEvidence.test.ts` retires at O-P3; adopter copy at C5 |
| server/adapters/stripe/stripePaymentReconciliationProvider.test.ts | `stripePaymentReconciliationProvider.test.ts` | 33 | moved-pending: root `server/adapters/stripe/stripePaymentReconciliationProvider.test.ts` retires at O-P3; adopter copy at C5 |
| server/adapters/stripe/stripeRefundEvidence.test.ts | `stripeRefundEvidence.test.ts` | 20 | moved-pending: adopter copy retires at C5 |
| server/adapters/stripe/stripeSandboxPaymentExecutionAdapter.test.ts | `stripeSandboxPaymentExecutionAdapter.test.ts` | 39 | moved-pending: adopter copy retires at C5 |
| server/adapters/stripe/stripeWebhookNormalizer.test.ts | `stripeWebhookNormalizer.test.ts` | 26 | moved-pending: root `server/adapters/stripe/stripeWebhookNormalizer.test.ts` retires at O-P3; adopter copy at C5 |
| server/_lib/payment/webhookSignature.test.ts | `webhookSignature.test.ts` | 4 | moved-pending: root `server/_lib/payment/webhookSignature.test.ts` retires at O-P3; adopter copy at C5 |
| — | `scripts/packages/platform-cold-consumer.test.ts` (Stripe entry) | 1 | net-new |
| — | `scripts/public-ci-payment-allowance.test.ts` | 1 | net-new |

### O-P2 Tpay

| Source (adopter) | Destination (`packages/platform/test/payments/tpay/`) | Cases | Status |
|---|---|---:|---|
| — | `conformance.test.ts` | 1 | net-new |
| server/adapters/tpay/declineFailureHints.test.ts | `declineFailureHints.test.ts` | 12 | moved-pending: root `server/adapters/tpay/declineFailureHints.test.ts` retires at O-P3; adopter copy at C5 |
| — | `factory.test.ts` | 61 | net-new |
| — | `readbackParity.test.ts` | 5 | net-new: all 40 status/purpose/amount combinations, plus both success aliases (48 observations) |
| server/adapters/tpay/tpayCreateTransactionInput.test.ts | `tpayCreateTransactionInput.test.ts` | 12 | moved-pending: adopter copy retires at C5 |
| server/adapters/tpay/tpayDeclineEvidence.test.ts | `tpayDeclineEvidence.test.ts` | 71 | moved-pending: root `server/adapters/tpay/tpayDeclineEvidence.test.ts` retires at O-P3; adopter copy at C5 |
| server/infra/tpay/tpayDispatchFailure.test.ts | `tpayDispatchFailure.test.ts` | 7 | moved-pending: root `server/infra/tpay/tpayDispatchFailure.test.ts` retires at O-P3; adopter copy at C5 |
| server/adapters/tpay/tpayFailureEvidence.test.ts | `tpayFailureEvidence.test.ts` | 15 | moved-pending: root `server/adapters/tpay/tpayFailureEvidence.test.ts` retires at O-P3; adopter copy at C5 |
| server/infra/tpay/tpayHttpClient.test.ts | `tpayHttpClient.test.ts` | 18 | moved-pending: adopter copy retires at C5 |
| server/infra/tpay/tpayHttpFailure.test.ts | `tpayHttpFailure.test.ts` | 6 | moved-pending: root `server/infra/tpay/tpayHttpFailure.test.ts` retires at O-P3; adopter copy at C5 |
| server/adapters/tpay/tpayPaymentExecutionAdapter.test.ts | `tpayPaymentExecutionAdapter.test.ts` | 56 | moved-pending: adopter copy retires at C5 |
| server/adapters/tpay/tpayPaymentReconciliationProvider.test.ts | `tpayPaymentReconciliationProvider.test.ts` | 46 | moved-pending: root `server/adapters/tpay/tpayPaymentReconciliationProvider.test.ts` retires at O-P3; adopter copy at C5 |
| server/infra/tpay/tpayTransactionPayload.test.ts | `tpayTransactionPayload.test.ts` | 14 | moved-pending: adopter copy retires at C5 |
| server/infra/tpay/webhookJwsVerifier.test.ts | `webhookJwsVerifier.test.ts` | 8 | moved-pending: root `server/infra/tpay/webhookJwsVerifier.test.ts` retires at O-P3; adopter copy at C5 |
| server/infra/tpay/webhookNormalizer.test.ts | `webhookNormalizer.test.ts` | 28 | moved-pending: adopter copy retires at C5 |
| — | `scripts/public-ci-payment-allowance.test.ts` (market token, reporting-zone and subtraction plants) | 7 | net-new: 8 current cases minus the 1 O-P1 case |
| — | `scripts/public-ci-neutrality.test.ts` (adoption and communications subtraction plants) | 4 | net-new: 32 current cases minus 28 existing cases; 3 adoption lanes and 1 ui-12 lane |
| — | `scripts/packages/platform-cold-consumer.test.ts` (second adapter entry) | 0 | existing case extended |

Recounted with `npx --no -- vitest list --json` for every new or changed test
file: the Tpay suite has 360 cases (293 moved-pending donor, 61 factory, 5 parity and 1
conformance); payment allowance has 8 and neutrality has 32. The changed
package-boundary file has 1,375 cases; its generated per-source additions are
excluded from net-new under ruling A. The cold-consumer file has 45 existing
cases and no O-P2 case addition.
O-P2 adds 78 net-new cases (67 adapter, 7 payment allowance and 4 neutrality),
bringing O-P1 plus O-P2 to 97 net-new cases. Moved-pending donor and generated
boundary cases do not count toward that total; no donor retirement is claimed.
