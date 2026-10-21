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
- Coordinator Decision 1 permits implementing against M07 P1: the single
  `mapStripeOutcome` function refuses donor dispute events as `unsupported-event`
  until M07 P2 adds their distinct outcome. The donor normalizer stays unchanged.
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

O-P3 account verification/reference binding, M07 P2
conformance and the additive dispute outcome remain separate work. Committed
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

The adapter declares only its supported market currency. It offers bank-redirect
and one-time-code flows, Model O alias activation and unattended alias charging;
Model M and unknown mandate models refuse before dispatch. No recurring card
capability is claimed. Account-dependent offers remain `verification_pending`
until O-P3 owner TEST readback; protocol witnesses do not establish activation.
Refund creation, split authorization/capture, close and exact absence are
unsupported. Transaction-ID readback is neither a complete bounded search nor
absence proof. Refunded/chargeback readback stays unknown for host manual review.

Named deltas from the contributed donor:

1. Verify certificate validity and notification freshness. Root and prefix are
   required construction inputs; signing and root certificate validity windows
   use the injected clock. A verified protected-header `iat` is interpreted as
   UTC seconds. Maximum notification age defaults to seven days, a generous
   assumption while the provider retry schedule is unconfirmed. A missing
   assertion leaves provider time null; the host deduplicates by exact event
   identity and fingerprint. No receipt timestamp becomes provider time.
2. Transaction event identity combines the payment reference and verified outcome
   class. Method identity combines event/alias and method outcome. The donor
   normalizer retains its original identity mapping; only factory glue adds the
   neutral envelope identity. Fingerprints exclude receipt time and secrets.
3. Receipt time participates only in signed notification freshness.

CHARGEBACK is a `refunded` money observation with explicit `full-reversal`,
`reason: "chargeback"`, original money and a stable operation ID. Missing original
money or currency refuses. No M07 P2 disputed outcome is required.
Donor source and tests retain behavior except import relocation and private
identity removal: neutral aliases/labels/hosts/return paths and subject keys,
explicit synthetic payer fixtures instead of a manufactured payer, and removal
of the mapper's host environment reader. The synthetic certificate fixture adds
root lifetime and signed issued-at controls for the named validity/freshness
cases. Other donor outcomes outside M07 remain in one named refusal mapping;
unrecognized alias lifecycle events refuse `unsupported-event`.

O-P2 donor witnesses are moved-pending: OpenLup root source retires in O-P3 and
the private donor suite in C5. New glue cases are counted separately in task
evidence; no donor case is trimmed to satisfy the estimate. M07 P2 conformance
remains a TODO without a stub. Git, staged inventory, full gates and native
candidate review remain with Claude.
