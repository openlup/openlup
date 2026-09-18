# Changelog

Notable changes to this private portability proof are recorded here. Declaration
snapshots track internal candidate drift; they do not define a public release or
Semantic Versioning promise before the phase-5 platform activation.

## Unreleased — checkout recovery contracts

- Add neutral checkout recovery evidence, method, operation and action contracts
  to the existing payment surface. They describe guidance only and do not change
  payment admission, renewal classification or enabled payment methods.

## [Unreleased]

### Changed

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

No public version has been released. `0.1.0-rc.1` is the current private proof
version, not a planned public candidate. The package remains private; any public
governance and distribution decision belongs to the complete platform monorepo
at phase 5. Do not add a dated release section until an authorized platform
release has actually occurred.
