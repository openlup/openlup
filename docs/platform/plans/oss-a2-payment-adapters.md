# A2 payment example adapters

Status: development-preview implementation ledger, 2026-10-21. O-P1 supplies
an opt-in Node example behind M07's neutral payment ports. It makes no stable
framework, account activation or release claim.

## Owner and coordinator decisions

- Owner, 2026-10-21: Stripe and the second example adapter (O-P2) are opt-in,
  default-off example adapters behind M07 neutral payment ports; adopters may
  replace them. O-P1 implements
  Stripe only; the second example adapter (O-P2) remains a separate step.
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
- D3 authorizes only the ui-13 path/token allowance for the adapter source and
  tests, API report, exact registration tokens and this ledger. No baseline
  increase or allowance for another category is authorized. Paired plants keep
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

The second example adapter (O-P2), O-P3 account verification/reference binding, M07 P2
conformance and the additive dispute outcome remain separate work. Committed
native review, broad gates, submission and any release remain with the active
supervisor; these local checks grant none of that authority.
