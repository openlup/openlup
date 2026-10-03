# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise.

## [Unreleased]

### Added

- `./outbox`: the outbox event envelope `OutboxEventRow`, field for field as
  the claim returns it, with its persisted column names in
  `OUTBOX_EVENT_ROW_FIELDS`.
- `./outbox`: the handler contract `OutboxHandler`, whose `handle(row, signal,
  ctx)` takes a structural `OutboxAbortSignal`, which any host `AbortSignal`
  satisfies, and one extensible `OutboxHandlerContext` (`setPhase` today), and
  its outcomes `OutboxHandlerOutcome` (`processed`, `retry`, `discard` with
  `benign`, `snooze`), with the persisted names in
  `OUTBOX_HANDLER_OUTCOME_KINDS`.
- `./outbox`: the platform event-type vocabulary `PLATFORM_OUTBOX_EVENT_TYPES`,
  39 types as OpenLup's platform SQL emits them, typed entry by entry, each
  with an owner, and
  `OutboxEventTypeDeclaration` with `matchOutboxEventTypeDeclaration` for
  ignored or dormant types, exact or by prefix.
- `./readiness`: the `Contribution` and `PackageManifest` shapes, with
  `ScheduleDeclaration`, `ScheduleRunResult`, `RouteDeclaration` and
  `RequiredSchema`; the codes `READINESS_CODES`; and `checkReadiness`, which
  reports every failure at once and reaches the database only through a
  `SchemaProbePort`.
- `./readiness`: `buildSchemaProbe` and `readSchemaProbe`, a pure catalogue
  query and its reader, and `./platform-runtime`'s structural `SqlExecutor`
  that runs it.
- `./standard-schema`: the `StandardSchemaV1` and `StandardTypedV1` types,
  copied from the Standard Schema specification 1.1.0, so a validation contract
  needs no schema library.
- `./platform-runtime`: the job lease port `JobRunLeasePort`
  (`claimJobRun`, `finishJobRun`) and its `PlatformJobInvocation`,
  `PlatformJobTriggerKind`, `PlatformJobClaim`, `PlatformJobFinishStatus` and
  `PlatformJobFinishSummary` types.

### Changed

- `AGENTS.md` gains a required "Using this package in an application" section: do not edit or
  patch the installed package, change behaviour through its seams, and upgrade every
  `@openlup/*` package together. `docs:check` refuses a guide without it.

## [0.12.0]

### Removed

- **API REMOVAL: the `./checkout` subpath.** It held only an
  `Idempotency-Key` header-shape helper that no checkout path used.

  Migration: replace

  ```ts
  import { validateCheckoutIdempotencyHeader } from "@openlup/core/checkout";
  ```

  with an application-owned validator, or delete the call if, like the
  reference checkout, your checkout carries its idempotency key in the
  request body.

### Changed

- **BEHAVIOUR CHANGE for the subscription status matrix.** `cancelled` is no
  longer terminal: `cancelled -> active` is now an allowed edge. This is the
  owner win-back that the managed SQL guard
  `public.subscription_guard_status_transition` already admits. Only the new
  `reactivateSubscription` takes that edge. `resumeSubscription` still leaves
  `paused` only and still refuses a cancelled subscription. `completed` stays
  terminal. A caller that treated `cancelled` as final must now expect a
  reactivated subscription to renew again.
- **BEHAVIOUR CHANGE: an exhausted retry ladder now has a modelled outcome.** A
  renewal whose refusals ran past the last rung may pause an active
  subscription through `pauseSubscriptionForExpiredDunning`, which is the
  sanctioned non-payment rule. It is the only engine path that suspends a live
  subscription for a reason the owner did not choose. A ladder cut short by a
  terminating refusal class, or a failure that still has a retry after it, is
  refused as `dunning_not_exhausted` and leaves the subscription active.
  `recordPaymentFailure` is unchanged and still never touches the subscription.
- `SubscriptionEngineErrorCode` gains `missing_payment_method` and
  `dunning_not_exhausted`. An exhaustive `switch` over the union must handle
  both.

- `release-gates.json` sets `packageRelease.versionRule` to `0.N.P`. Below
  1.0 every `@openlup/*` package carries one set version: a minor set for any
  API, behaviour or schema change, a patch set for a fix only.

  Migration: a tool that reads `versionRule` expects the set rule. Before:
  `"versionRule": "0.<n>.0"`. After: `"versionRule": "0.N.P"`.

- Publishable on the npm `latest` dist-tag as `0.12.0`, from tag
  `openlup-core-v0.12.0`.
- Publishable on the npm `preview` dist-tag as `0.11.0`, for source preview
  `openlup-source-preview/11`.
- Publishable on the npm `preview` dist-tag as `0.10.0`, for source preview
  `openlup-source-preview/10`.
- Publishable on the npm `preview` dist-tag as `0.9.0`, for source preview
  `openlup-source-preview/9`.
- Publishable on the npm `preview` dist-tag as `0.7.0`, for source preview
  `openlup-source-preview/7`.
- Publishable on the npm `preview` dist-tag as `0.6.0`, for source preview
  `openlup-source-preview/6`. Directory `npm publish` stays refused.

- **BREAKING for `slugSchema`'s accepted language.** The `./catalog` schema no
  longer trims its input, so a slug with leading or trailing whitespace is now
  rejected rather than normalised and accepted, which is what the published
  `catalogSlugFormat` it tests against always described. A caller that relied on
  that normalisation must trim before validating.
- **BREAKING for the retry ladder's semantics.** `nextRetryAttemptAt` now
  TERMINATES past the end of the ladder instead of capping at its last slot: an
  attempt beyond the configured backoff length answers `null`, which is the pause
  signal, rather than repeating the final interval forever. The stored schedule
  this kernel mirrors has always terminated, so the two rails now agree; the
  previous capping behaviour meant a caller asking for attempt 4 (or 9) was told
  a fourth charge was scheduled when none was. Callers that guarded with
  `attempt <= maxRetryAttempts()` before calling should drop the guard — asking
  for the next slot IS the decision, and a second copy of the budget check is how
  the two rails drifted apart in the first place.

### Added

- `AGENTS.md` ships in the tarball. It states the package's kind and each
  subpath's maturity, gives one wiring example that compiles in CI, points to
  the shipped sources and declarations, and lists the readiness codes the
  package raises (none yet).
- `release-gates.json` schema 5 declares the package kind (`"kind": "kernel"`)
  and splits the pack budget. Code files (dist JavaScript, declarations and
  shipped sources) and root documentation and metadata files each have their
  own caps on packed bytes and files; the tarball total stays as a backstop.

  Migration: a tool that reads `release-gates.json` checks `schemaVersion: 5`.
  Before: `"pack": { "maxPackedBytes": …, "maxFiles": … }`. After: `"pack": {
  "code": { "maxPackedBytes": …, "maxFiles": … }, "docs": { … },
  "maxPackedBytes": …, "maxFiles": … }`.
- Add neutral checkout recovery evidence, method, operation and action contracts
  to the existing payment surface. They describe guidance only and do not change
  payment admission, renewal classification or enabled payment methods.
- Export neutral lookup normalization from `./company-identity` for extensions.

- `SUBSCRIPTION_STATUS_TRANSITIONS`, the frozen status matrix, and
  `canTransitionSubscriptionStatus` on `./subscription`. The matrix mirrors the
  managed SQL guard over the engine's four statuses, and a contract test
  enumerates every ordered pair.
- `reactivateSubscription`, the win-back from `cancelled`. It needs a stored
  payment method and restarts the schedule `RESTART_LEAD_DAYS` (two) days out,
  never earlier than the stored `nextCycleAt`.
- `isDunningLadderExhausted(cycle, cadence?)` on the retry ladder. It holds when
  a cycle is `payment_failed`, has nothing scheduled, and its attempt is past
  `maxRetryAttempts(cadence)`.
- `pauseSubscriptionForExpiredDunning` and
  `resumeSubscriptionFromExpiredDunning`. The resume is the customer's recovery
  from the non-payment pause: it takes an optional replacement method, skips the
  uncollected cycle, and restarts the schedule like a win-back.
- `recordPaymentFailure` takes an optional `cadence`, so a deployment ladder
  reaches the schedule and the exhaustion check alike. Callers that pass none
  keep the shipped ladder.
- `recordPaymentFailure` accepts an optional neutral `failureClass` and passes it
  to the canonical retry-ladder decision. Existing callers remain
  source-compatible. The shipped terminating-class set is exactly
  `["hard_do_not_retry"]`: that refusal gets no later rung, while every other
  class keeps the existing 24h/72h/168h schedule.
- Class-aware retry termination on `./subscription`.
  `CycleRetryCadence` gains an optional `terminatingFailureClasses`, the new
  `ladderTerminatedByClass(failureClass, cadence?)` answers whether the REASON
  for a refusal ends the ladder, and `nextRetryAttemptAt` / `shouldScheduleRetry`
  take an optional trailing `failureClass`. `DEFAULT_CYCLE_RETRY_CADENCE` ships
  only `hard_do_not_retry`. The predicate fails open for an absent or unlisted
  class, for a listed class the taxonomy does not recognise, and for a listed
  class that `failureClassDecision` still permits. Only explicit membership plus
  the taxonomy's existing refusal can end the ladder early.
- Injectable retry cadence on `./subscription`: `CycleRetryCadence` and the
  frozen `DEFAULT_CYCLE_RETRY_CADENCE` (24h/72h/168h). `nextRetryAttemptAt`,
  `shouldScheduleRetry` and `maxRetryAttempts` each take an optional cadence and
  default to the shipped one, so a deployment can publish its own ladder without
  forking the kernel and nothing changes for a caller that passes none.

- Pack budgets raised (packed 98 KiB -> 106 KiB, unpacked 448 KiB -> 480 KiB;
  file count unchanged at 186): the new allocation kernel ships as one source file
  plus its two build artifacts, and its adopter-facing JSDoc — the floor-clamp
  rule, the two-line split rationale and the failure-versus-throw split — is most
  of the added bytes. The docs are the deliverable, so the budget moves rather
  than the docs. Measured, not estimated: clean base packs 98532/446519/183 and
  this change packs 106488/475826/186.
- Experimental bundle target-price allocation on `./pricing`:
  `allocateBundleTargetPrice`, the pure kernel that turns ONE operator-set price
  for a composed bundle into exact per-component money. Largest-remainder
  (Hamilton) split weighted by each component's own reference subtotal, all in
  BigInt, ties broken by component code so output never depends on input order.
  Two rules bound it — a component never allocates below its minimum payable per
  unit (and a component priced under that minimum is held to its own reference
  price, because no floor may lift a component above what it is worth), and never
  above its reference unit price. A quantity whose allocated subtotal does not
  divide evenly emits TWO lines rather than a rounded unit price, so the
  `unitPrice x quantity === lineSubtotal` identity every quote line refines still
  holds. The single asserted invariant is that the emitted lines sum to the target
  exactly. Three refusals stay data rather than exceptions: nothing to weigh
  against, a target above the sum of the parts, and a target that cannot cover
  every minimum payable. No clock, no randomness, no I/O.
- Line-scoped `bundle` component in the pricing breakdown vocabulary, with an
  optional `bundle_allocated_discount_minor` on the line input: positive on the
  way in, emitted as one negative component, absent or zero emits nothing. It is
  line-scoped rather than order-scoped because a bundle prices a subset of the
  cart, and refunding one line must return exactly what that line was charged.
- Pack budgets raised (packed 90 KiB -> 94 KiB, unpacked 416 KiB -> 432 KiB,
  files 180 -> 186): one new kernel module ships as a source file plus its build
  artifacts and their maps, and its adopter-facing JSDoc is most of the added
  bytes. The docs are the deliverable, so the budget moves rather than the docs.
- Experimental payment-method lifecycle vocabulary on `./payment`: the five
  transitions a rail may report about a method it holds on file
  (`method_registered`, `method_updated`, `method_revoked`, `method_expired`,
  `method_suspended`), the neutral event an adapter translates its own event
  names into, and the three published facts (`schemeLabel`, `lastDigits`,
  `expiresAt`) a transition may carry — never the instrument number. Plus two
  pure helpers: `endsStoredMethodUsability`, the single place that answers
  whether a transition means the method can no longer back a charge (a rotation
  is not a death), and `expiryInstantFromMonthYear`, which pins the convention
  that a month-and-year validity runs to the LAST instant of that month in UTC.
  No rail is named and no clock, network or storage is read.
- Pack budgets raised (packed 88 KiB -> 90 KiB, unpacked 400 KiB -> 416 KiB): the provider-capability contracts
  add ~0.9 KiB of shipped declarations and their adopter-facing JSDoc; the
  docs are the deliverable, so the budget moves rather than the docs.
- (formatting) the block-reason alias is declared single-line so the
  generated declaration snapshot carries no trailing whitespace.
- Experimental payment-provider capability contracts on `./payment`: a
  descriptor an adapter publishes so renewal and dunning can decide from
  CAPABILITIES — whether stored consent evidence must be read and whether it
  is chargeable unattended, which provider flow an unattended charge uses,
  what payer context the request needs, and what a stored method must satisfy
  before a charge — plus a registry contract keyed by provider kind. Types
  only, with no provider named and no runtime consumer yet; branching on
  provider identity is unchanged.
- Experimental payment-failure taxonomy on `./payment`: a pure classifier that
  resolves a refusal into one of seven neutral classes from optional evidence
  (scheme retry advice, adopter-asserted neutral hints, an opaque decline code
  read through an adopter-supplied hint table, and the internal reason key),
  with a documented precedence order, a frozen per-class retry decision record,
  and a scheme retry ceiling helper pinned at 15 attempts per 30 days. The
  kernel embeds no acquirer code tables and has no runtime consumer yet; retry
  scheduling is unchanged.
- Experimental provider-neutral payment-decline evidence on `./payment`, with
  a provider code (never free-form prose) and retryability hint that lets
  adopters classify synchronous PSP refusals without persisting customer data.
  Extended with optional `declineCode` and `adviceCode`, so a refusal keeps the
  finer bank reason and the provider's retry recommendation — both codes, never
  messages — for a later classification policy to read. Extended again with
  optional `neutralReasonHints`, so an adapter can carry its OWN reading of a
  refusal — already translated out of its code vocabulary — and a classifier
  never has to learn which adapter refused.
- `PAYMENT_FAILURE_CLASSIFICATION_SOURCES` on `./payment`: the classification
  sources published as a value as well as a type, so a boundary schema can
  validate `decidedBy` against the kernel's own vocabulary instead of restating
  it. The type is unchanged and still derives from the same four members.
- Additive `evaluatePromotionAdjustmentsV2` API in the existing candidate
  `./promo` subpath. It chooses one best product and shipping adjustment,
  interprets product percentages as target-effective basis points against a
  trusted reference subtotal, and requires an adopter-defined product floor.
  The legacy evaluator and DB-shaped types remain unchanged for compatibility;
  downstream applications can adopt the package boundary before any separately
  flagged runtime cutover.
- Experimental `./fulfillment` normalized-fact contract with explicit schema,
  strict N/N-1 parsing, adopter-supplied canonical-status validation,
  discriminated provenance, application-minted evidence references, comparable
  provider ordinals, deterministic fingerprint/dedupe, and self-contained
  transition-conflict diagnostics with strict stream/decision validation.
- The then-current package identity and extracted-root governance evidence;
  this is historical evidence, not authorization for a separate repository or
  release channel.
- Package-local documentation and governance material for the portability
  boundary.
- Candidate and experimental maturity metadata for the package surface.

### Changed

- Marked candidate/experimental declarations `@beta` and testing-only
  declarations `@internal`, without changing package exports or runtime shapes.
  Removed the private `./testing` neutrality matcher after moving all packaged
  leak classes into the packed-artifact audit.
- Reclassified all declaration snapshots as private package-surface drift proof;
  this changes no exports, runtime behavior, dependencies, or publish refusal.
- Raised the reviewed packed/unpacked artifact ceilings by 4/16 KiB to admit
  the additive promo v2 declarations and implementation.
- Replaced public-surface and freeze language with the private package-surface
  inventory: 16 current exports have package smoke evidence but no public
  stability claim.

### Removed

- Removed the unused `./external-effects` API, implementation, snapshot, and
  self-conformance fixture before any public release. The application
  one-writer cleanup left no runtime consumer, so external-effect retry
  semantics stay adopter-owned instead of becoming a fourth core concern.

### Security

- Recorded the private vulnerability-reporting contact for this proof package.

## Release Status

Versions up to `0.11.0` were published on the npm `preview` dist-tag without
sections of their own, so the `0.12.0` section also lists the changes they
carried. A release-preparation pull request turns the Unreleased section into
the next version's section; its release tag and npm record when it is
published. No version establishes a stable package API or supported upgrade
channel.
