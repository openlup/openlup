# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.38.0]

- Publishable on the npm `latest` dist-tag as `0.38.0`, from tag
  `openlup-platform-v0.38.0`.

Checkout recovery links for one admitted purchase now coexist until expiry or
payment. Identical-hash replay and cross-order refusal remain unchanged. Pending
renewal-cycle orders refuse checkout issuance. Payment-case links still rotate,
with issuance serialized on the pending order; the separate actor issuer also
retains rotation. Install the complete native migration chain before using the
updated checkout issuer.

Add the opt-in classic package repricer and PostgreSQL preview/apply binding. Content-keyed one-use previews accept a separate apply key; future renewal terms retain accepted line pricing. Both quote and apply read the configured minimum base units. Apply the package-editor forward through the selected migration plan before composing native account reads or the editor. Hosts supply authenticated ownership, composition mapping and a promotion-free server-authoritative quote engine.

- Declare npm `keywords`, a `homepage` pointing at the package README in the
  source repository, and the issue tracker as `bugs`, so registry search and
  package pages lead to the documentation and to issue reports.

Replay a completed classic package-edit key before repricing or configuration reads, preserving its originally recorded result after a price change. Fresh commands still require a matching current quote.

- Export `./package.json`, so tooling and agents can read the installed
  version and metadata with `import.meta.resolve("@openlup/platform/package.json")` or
  a JSON import. It adds no code entry point.

Fence late retry case observations after lifecycle closure, including after a
later resume. Timed auto-resume now skips ineligible windows without failure,
rolls forward by whole cadences and records one system event; the lifecycle
messenger maps that event to the resumed confirmation.

Expose `createPostgresSubscriptionAutoResume` through `subscriptions` and trusted
`CycleRetryCadence.backoffHours` configuration through native retry stores and
bindings. Defaults and terminating failure-class behavior remain unchanged.
Install the complete native migration catalogue before selecting these entries.

Migration: Existing retry-store callers keep their one-argument construction and
24/72/168-hour defaults. To override timing, pass `{ backoffHours }` as the
store's second argument or `retryCadence` in the native binding's retry options.
Install the complete catalogue including the new timing overload first. Hosts
may then bind `createPostgresSubscriptionAutoResume(executor).run` to their
scheduler; construction schedules no work. No browser policy field is added.

- Add an explicitly selected native winback worker with subscription-wide send
  deduplication, configurable cancellation age and retention consent, failed-send
  retry and durable receipt recovery, including retained episode-key acceptances.

Migration: apply `20261106140000_subscriber_winback_policy.sql` through the
complete selected catalogue before composing `createPostgresSubscriptionWinback`.
Provide the existing delivery rail and localized account-link binding. Configure
`subscriber_winback_policy` explicitly; omitted fields retain consent required
and the inclusive 14-day / exclusive 120-day window. Account consent capture and
charge-confirmed reactivation remain host composition.

- Close recovery and unpaid obligations on explicit pause/cancellation. Add
  confirmed order-now/reactivation commands, trusted lifecycle timing terms and
  structured retention evidence through the existing subscription entries.

Migration: apply the lifecycle-closure forward before selecting these command
bindings. Hosts may provide `lifecycleTerms` and `retentionReasonCodes`; existing
SQL signatures retain their prior timing defaults. Send literal charge-timing
confirmation for order now/reactivation. Stored receipt replays keep their
accepted results; legacy survey strings remain supported.

Native subscription reminder production now applies configured eligibility before
consuming the renewal-day identity and retains the exact queued charge instant.
Pause notices use window identity and recheck resolution before delivery. At-risk
notices retain cause/day history for accepted deliveries and disabled templates.
Operator notices use distinct recipients, fresh-only eligibility and fenced claims.

The existing subscriptions entry gains optional notice timing/cap configuration
and an explicit operator binder. Hosts continue to own calendar labels, copy,
delivery-window estimation and recipient-bound rendering through the trusted binder.
Imported or uncorrelated starter history uses standard freshness and may miss an
early reminder. Real provider acceptance/idempotency remains a host prerequisite.

- Fix timed auto-resume remaining paused after its first paid order has been
  delivered. Historical fulfilled orders no longer block; in-flight orders and
  orders in the existing paid/fulfilling/fulfilled allowlist on the next date
  still prevent stacked deliveries. Cancelled pause-closure orders do not block.

Migration: apply `20261109113000_subscription_auto_resume_delivered_history.sql`
through the complete selected catalogue. The function header, privileges, other
eligibility guards, event identity and whole-cadence roll-forward are unchanged.

Add seven exact subscription edit levers through the existing preview/apply
binding, preserving individual line IDs, fixed-total mix, configured plan/portion
sizing, accepted recurring pricing and replay-first receipts. Reduced mode must
strictly reduce units; full restoration is permitted. Install the additive
exact-lever migration after the shared package editor. Host routes and portal
controls remain application composition.

These levers are opt-in and API-only; hosts supply routes and portal controls.

## [0.37.0]

- Publishable on the npm `latest` dist-tag as `0.37.0`, from tag
  `openlup-platform-v0.37.0`.

- @openlup/platform size growth: 987 shipped declaration maps contribute 227,397 packed bytes in an archive comparison, alongside the native commerce, account and fulfillment surfaces and their complete migration histories.

- Ship declaration maps that navigate to the packaged TypeScript sources,
  consumer-first installation guidance and release-tagged agent source citations.
- Allow Node `>=24` while
  retaining Node 24 for contributor verification. Pin exact package versions and
  upgrade the OpenLup set together.
- Add the installed package agent guide, checked subpath maturity table and
  compiled public-export wiring example. Raise artifact limits only for the
  measured declaration-map cost; no runtime, exports or SQL changes.

- Add the Node-only `openlup` application command-line tool and `verifyApp`
  for application-owned upgrade planning, diagnosis and verification. These
  tools preserve explicit host authority and do not activate an application.
- Include two later-phase preparation changes: derive native forward shapes
  from issued registry slots, and omit recognized inventory-admission busy
  rows from renewal batch results without masking other failures.
- Calculate the second-delivery renewal discount with exact integer arithmetic,
  preserving the promised product amount without floating-point rounding drift.
- Use the package quote engine for the starter's first-subscription offer and
  recheck its second-delivery promise against current terms, refusing a stale
  promise before checkout rather than accepting an outdated amount.

- Apply retry recovery effects only after payment truth confirms an applied
  captured settlement. Captures retained for review keep their evidence without
  advancing the renewal counter, restoring stock or recording paid recovery.
- Return `payment_failed` for non-paid recovery readback; the retry driver reports
  a row error for reconciliation. Exact evidence redelivery remains idempotent;
  genuinely paid recovery and its stored receipts retain their behavior.

Migration: install `20261106060000_subscription_retry_recovery_truth.sql` before selecting the updated retry
adapter. Treat a non-paid recovery result as unresolved payment evidence and
inspect its payment-truth review record; do not synthesize settlement or retry a
charge from that result. Existing paid recovery receipts continue to replay.

Historical recovery receipts are checked against payment truth before replay.
Previously misapplied counter or stock changes require reconciliation; this
forward preserves those historical rows instead of reversing them automatically.

- Package the complete canonical PostgreSQL migration histories, including
  qualified-v2 and restricted qualified-admin, with a generated drift-checked
  manifest. Add `createPlatformPostgresMigrationRunner` to `/migrations` for
  explicit installation/status through the existing executor without a checkout.
  The package factory requires an explicit installation selection; the repository
  legacy default and low-level runner API remain unchanged. Existing units
  keep their SQL bytes, ledger paths, hashes and order; no new forward is added.

Migration: fresh consumers select a qualified generation and provision its
existing PostgreSQL 16 role profile before calling apply. Install the optional
`pg` peer. Existing histories cannot change generation. Managed history and
application activation are unaffected.

- Add `runCommunicationsAdapterConformance` and its subject/evidence types to the
  existing communications entry for offline email and marketing-sync fixtures.
  Findings give a bounded fix/recheck; passing fixtures do not qualify a provider.

Add the opt-in PostgreSQL checkout recovery token port for trusted admitted-order
hosts. It supports principal-less contacts, creation-plus-24-hour expiry,
replay-safe issuance and initial subscription facts. Issuing a new link ends the
previous link of the same order.

- Isolate authenticated subscription pause and bundle command keys from system event keys using the existing principal-scoped command hash. New actor events and quotes carry principal-bound derivation provenance; unmarked rows at a derived key refuse as ambiguous rather than replaying.
- Reject supplied keys starting with `command:` at pause, bundle preview and bundle apply, including historical raw keys with that prefix. Non-reserved, unmarked legacy history replays only for the same owner and action, with matching accepted quote proof for bundles. Another customer action refuses; a raw system event is bypassed.
- Graduation, cadence normalization and dunning exhaustion preserve a legacy foreign event at their predictable key and select a prefixed system identity, so old customer keys cannot block or suppress system evidence.

Migration: apply the complete selected catalogue through `20261106050000_customer_command_key_isolation.sql` before serving customer commands. The forward adds nullable quote provenance and replaces function bodies while retaining existing privileges and history. It neither re-keys history nor backfills markers. Keep the matching package runtime for graduation collision handling; rolling back to earlier writers restores the old collision behavior.

- Add actor-owned account choices, grants and withdrawals for the independent
  newsletter and gifts-and-discounts marketing purposes, with durable provenance,
  suppression precedence and idempotent replay. Retain consent history and trusted
  sync target configuration through connected native-store capture and restore.
- Record withdrawals locally even when the email or sync target is unusable;
  successful withdrawals can return a null `workId`. Provider sync requires a
  usable recipient and enabled target. Replay never backfills deferred work.

Migration: apply `20261101232000_customer_account_consents.sql` through the
selected native migration sequence before using these actor routines. Use the
owner-documented unsynced-denial query to inspect withdrawals without work;
reconcile current choices before provider action. Existing actor setters retain
their served behavior. This introduces no provider retry worker or erasure path.

- Add the host-only `createPostgresContactClientRegistrar` identity factory for
  guest checkout contact resolution. Exact email matching converges concurrent
  calls on one client; optional profile defaults and journey facts refresh only
  unlinked contacts. Linked rows remain untouched, and erased shells refuse
  while a freed address starts a fresh contact. Hosts own requester quotas,
  guest response shaping and contact retention.

- Add the experimental `fulfillment/native` `createNativeFulfillmentBinding` locked dispatch-preparation binding
  with host-owned contribution composition and an explicit, default-off captured fulfillment dispatch adapter. Captures
  are offline synthetic evidence, with exact preparation matching and replay;
  they do not qualify a provider or record physical delivery. Native commerce
  list/detail reads retain their existing refusal.

### Native account reads

- Extend account-support with explicit native reads for owned order persistence,
  subscription evidence, existing actor snapshots and newsletter withdrawal.
  Missing saved profile/events sources refuse by section. Historical summaries
  retain recorded amounts while detail without captured money refuses. Paid
  activation gaps appear on owned orders, without invented subscriptions.
  Consent choices/grants use the separate consent lifecycle; saved flags
  never establish evaluator consent.

### Native OMS, returns and support store bindings

Expose the existing PostgreSQL OMS control, reduced control-plane, delivered
system-hold recovery, returns and customer-support journey stores through explicit
platform subpaths. Reference imports delegate to the same factories and error
constructors. Portable support read schemas have a separate browser-safe entry;
the existing contracts entry remains type-only. Existing SQL, replay and named
refusal boundaries are preserved. No rich OMS projection or diagnostic store is
added.

Migration: Existing source imports remain thin facades. Installed consumers select
`commerce/server/postgres`, `account-support/postgres` and, for browser validation,
`account-support/read-contracts`. Supply the existing restricted runtime executor
or connection and trusted operator context; select the optional `pg` peer for
connection-owning stores. No SQL or data migration is added. Rich OMS projections
and the existing unsupported commands retain their refusals.

Expose the existing PostgreSQL bundle admin write store, shared marshalling and error constructors through the catalog entry. Reference facades preserve constructor identity and existing SQLSTATE mapping. The native binding now encodes all three bundle JSON parameters for pg, restoring composition writes while preserving JSON values and SQL null defaults. Shared managed marshalling, SQL, roles and authorization remain unchanged.

- Add `commerce/server/native-checkout` for restricted-runtime native draft
  persistence. It preserves quote and draft money snapshots, replays one durable
  receipt and refuses changed input without superseding or paying the order.
  Existing native money-shape limits remain; no SQL or managed behavior changes.

Add experimental `invoicing/postgres`: explicitly selected captured sandbox
provider, append-only non-fiscal PDFs, and principal-owned native invoice
history and download tickets. Preserve correction lineage, stored currency,
replay and missing-evidence refusals; managed behaviour remains unchanged.

Native order drafts accept
configured threshold delivery after product discounts
and serialize acquisition capacity through a narrow runtime lock helper. The
shipping entry adds a quote presentation helper for paid, free and stale terms;
the local invoice constructor includes effective delivery as a separate line.
Apply the complete native migration chain before selecting the new checkout
behavior. Managed hosts and provider activation are unchanged.

Add native order, subscription and shipment destination authority through
`commerce/server/destinations` and the bounded operator address branch. Exact
replay retains applicability; changed input and stale template versions refuse.
Dispatch-owned parcels keep their frozen address with `applied_from_next_parcel`.
The subscription event and deduplicated confirmation outbox commit atomically;
mail dispatch stays host-bound. Private address and binding rows join bounded
store transfer. No saved address book, destination privacy export/erasure, money
or delivery-alignment change. Hosts must display next-parcel applicability and
install the complete catalogue before composing this experimental entry.

Migration: Install the complete native catalogue before binding
`createPostgresDestinationPort`. Native operator address calls previously
returned the authority-unavailable refusal; they now use the bounded address
routine. Handle `applied_from_next_parcel` explicitly and show that the frozen
parcel retains its old destination. Do not treat it as fully applied current
delivery. The managed result type is unchanged. Hosts must bind checkout and
authoritative shipment reads themselves; no saved-address or mail route is added.

- Native lifecycle delivery now routes operator payment-repair notices through
  their latest customer failure template, requeues transient delivery failures
  and bounds recovered history by current case truth and configurable recency.
- Optional dispatch policy configures claim leases, attempts and retry backoff.
  Recovered policy configures the inclusive window. The run result includes
  requeued notices. Accepted receipts retain acknowledgement recovery.

Migration: Hosts may supply a failed delivery receipt with `retryable: false`
for a final rejection. An omitted disposition means transient. Exceptions retain
the sending lease. Read the lifecycle binding policy before selecting a host.

Native event and reminder policy refusals now terminally complete the original
source. Missing recipients, disabled controls and refused consent remain terminal
after policy changes, restart and connected store transfer. These records do not
assert delivery or change the dunning flow or transactional delivery receipts.

Add native purchase holds through `createPostgresPurchaseReservationPort`: atomic
item batches, keyed release and bounded expiry on the existing reservation tables.
`createPostgresAbandonedCheckoutCompensationPort` cancels an abandoned checkout
and releases its purchase holds atomically without a runtime ledger grant.
Changed keyed input and elapsed initial expiry refuse. Existing ATP, renewal,
stock wait and retry count these hard holds. Lots, locations, balance counters
and movement history remain outside this slice. Hosts bind the checkout seam
and schedule expiry; dedicated promotion cancellation remains unbound. References
may identify people; hosts should use opaque values. No erasure path is provided.
Managed behavior is unchanged. No npm release or automatic host wiring is included.

Fresh stock writes retain shared admission, READ COMMITTED isolation and a
transaction-local 50 ms lock bound. Busy admission remains a named persistence
refusal; committed replay needs no fresh admission. No automatic retry is added.

- Expose native subscription composition, retry, delivery admission and typed
  settlement adapters through the subscriptions entry. Hosts retain readiness,
  the population lease, payment-owner readback and transaction selection.
- Replay matching terminal renewal history before current due eligibility,
  including after cancellation, while refusing changed frozen input and new
  cancelled work. Native retry, recovery-token and stock-wait history join the
  bounded connected-store transfer profile.
- Include durable activation and paid-cycle correlation when selecting normal-due
  stock-wait work for the renewal codec.
- Freeze the immutable destination inside the claim transaction. The original
  zero-shipping registration retains its typed marker; the opt-in retained-terms
  path described below adds cycle shipping quotes.
- Enter shared stock admission inline inside the six existing invoker renewal
  and stock-wait routines, with the helper's busy and isolation codes. Grants
  stay unchanged; custom invoker runtimes need nothing new. Reservation SQL and
  raw errors stay unchanged. The shipment destination view is nonmutating and
  does not acquire dispatch locks.

Expose request-scoped PostgreSQL price authority history reads through the existing commerce server entry. Characterize the unchanged native promotion reader and document its device-evidence and mirror-family limits.

- Add opt-in `createPostgresCommerceQuoteCatalogReadPort` in the existing catalog
  entry. It reuses strict envelopes, guards current payload revision facts and
  requires host schema, semantic identity and digest verification. Bounded
  scans refuse incomplete authority without partial success; current-direct
  consistency does not qualify a publication head or publication-wide snapshot.

Retain renewal delivery and acquisition terms through the purchase attachment.
Second delivery honours the promised price; an unedited subscription graduates
before delivery three, while add-ons and customer-selected normal cadences remain.
Shipping is paid below and free at or above the retained threshold after product
discounts. Frozen retry/terminal history takes precedence over current terms.

Readers of `shippingQuoteRef` can now receive the `retained_shipping` marker because its output union gained a member, and purchase-facts `shippingAmountMinor` widened from `0` to `number`.

Migration: install the selected account-choice forward and its prior SQL approval
before selecting the new reader/writer. Supply a single-connection transaction
runner to both the renewal store and settlement port for retained snapshots.
The original zero-shipping registration and existing native-v1 wires remain valid.
These are explicit preview seams; no host switch, real mandate or npm release is
performed. Existing account-choice history and suppression retain their semantics.

- Add the sandbox-only PostgreSQL payment simulator with durable active-attempt
  fencing and server-observation verification. Browser returns cannot pay an
  order. Captures after cancellation remain terminal operator-review truth;
  no order reopen, refund, real provider store or schedule-rule change is added.
  Requires the complete native chain through the sandbox-attempt forward.
- Preserve microseconds and canonical UTC timestamp identity across database
  sessions for simulator replay, its payment truth and native renewal snapshots.
  Invalid purchase timestamp facts continue to reject asynchronously.

- Preserve renewal authorization for existing terms without a method-state row.
  Purchased subscriptions still receive method state atomically with their
  terms, and explicit unhealthy method states refuse before payment execution.

## [0.36.0]

- Publishable on the npm `latest` dist-tag as `0.36.0`, from tag
  `openlup-platform-v0.36.0`.

Add the existing neutral partner-acquisition schemas, type-only port and unchanged
three-operation PostgreSQL factory through the existing marketing entries.
Partners retains domain/data ownership; host routing, authorization and runtime
selection stay separate. Pipeline `closed_won` does not create a customer or
marketing consent. Partner privacy export/erasure remains unavailable.

Migration: before, partner submit/list/transition required reference-source
contracts and store imports; after, consumers can use the existing marketing,
marketing/contracts and marketing/server/postgres exports against a complete
compatible source catalogue. No SQL, grants, npm export subpaths or automatic
route activation change. Sparse npm SQL assets alone are not a complete install.

- The public reference partner schemas, neutral ports and PostgreSQL factory
  delegate to the existing marketing package exports. Rich managed contracts and
  host authorization, drain, environment selection and connection ownership are
  unchanged. Frozen R1 expectations remain unchanged.
- The shared isolated consumer adds the actual public default-binding journey
  against its existing native catalogue fixture, covering original persisted
  replay and cache/close/reopen without an injected factory.

Migration: before, reference neutral schemas, ports and the PostgreSQL store had
local copies; after, the same reference import paths delegate to the existing
`@openlup/platform/marketing` schemas, `marketing/contracts` types and
`marketing/server/postgres` factory with unchanged observable contracts. Install
no new SQL or grants for this delegation. Existing compatible adopter SQL remains
owned by that adopter; this source refactor grants no publication or activation.
