# Native fulfillment commerce reads

Status: destination reader rebind committed after the accepted public API read.
The row packed limit is 9,000 bytes; behavior and accepted limits remain unchanged.
The predecessor has landed and the row is based on main. This step authorizes
the bounded UUID comparison repair, its checks, the existing draft update and
two independent full reviews. Canonical verification and landing remain later steps.

## Outcome and boundary

Supply reduced native PostgreSQL commerce fulfillment list/detail through the
existing `@openlup/platform/fulfillment/native` entry, including its compiled
installed consumer and restricted-role proof. This row ports the reference
adopter's read mechanisms with the explicit native limits in
[Native parity boundaries](../ARCHITECTURE_AND_EXTENSIONS.md#native-parity-boundaries).
No additional package entry or default route binding is introduced.

The public API read and rebind commit are complete. The bounded comparison repair,
DCO commit, checks, existing draft update and independent full review are authorized.
Canonical verification and landing need their later explicit grants. No release,
hosted resource or settings action is granted. Other worktrees and branches are
outside scope.

Policy pin and original base: `4d78e855cf8bbd57704f9503cd7bae28f96453a5`.
The predecessor has landed at `0c9e80633c6eca879346459bcf832ba372751a67`.
That commit is the row's merge base with main; no stack pin is used.
The shipment destination and purchase reservation facts depend on the SQL stream.
The default destination reader calls the predecessor's nonmutating
`commerce_view_shipment_destination(uuid)` through the supplied executor. An
explicitly injected reader retains precedence. Routine unavailable and
owner-mismatch errors map to the existing native refusals; all other errors
propagate unchanged. The port retains its own client ownership check. Restricted
runtime execution and before/after counts of every public table prove that an
unprepared shipment read creates no binding or other row.
No SQL, migration, grant, routine, checkout, returns, starter composition,
subscription/inventory/payment source, managed operation or default unsupported
behavior changes belong to this row. No table or transfer-set addition is made.

## Mapping and response seam

Native shipment id identifies the fulfillment row; order id remains the commerce
order id. Stored shipment status uses the existing fulfillment vocabulary. List
filters precede paging, total remains unpaged, and ordering is updated time
descending without an extra id tie-break. Detail prefers the explicit fulfillment
id; order-id detail selects descending sequence then descending id. Missing ids
and orders without shipments return null. Stored string timestamps and reservation
status/expiry are forwarded without read-time clock interpretation.

The existing newest-first reservation builder supplies inventory summary. Native
held/committed reservations express reserved state. There is no quantity-coverage
override, SKU-based reservation association, second operation ledger, direct-port
request parsing/defaulting or identity fallback. Only required native vocabulary
conversions and fail-closed unavailable-fact errors remain. Eligibility policy and
order-mode interpretation are supplied by the host.

An internal schema factory constructs order/list/detail validators
from an address schema. The existing managed constants use the unchanged managed
address schema and retain their existing names and validation. The existing
managed order type is unchanged. Response containers and the read port receive
additive defaulted generics; no existing type's default shape is widened.

The existing two served handlers and two builders accept optional
`responseSchemas`; absent the option they use the managed validators. Builder
overloads retain the managed default output and allow the additive native output.
The native entry exports its response-schema variant and additive native order/read
port types. Only that variant permits a null saved-address id. Builders accept an
optional explicit shipping gate fact: detail uses a boolean and list uses an
order-id map. When absent, the original saved-address pointer truthiness remains.

Both destination identity aliases are removed. Native output has `addressId: null`;
the context pointer is null, and the explicit gate fact records successful
shipment destination resolution. A missing destination retains its named refusal.
The native factory returns its new response type and can be served by the existing
handlers when their schema option is explicitly selected.

## Named limits and documentation impact

The single public limits list owns FR01–FR08 and FR10–FR18. FR09 is closed: the
existing builder already supplies the reservation summary mechanism. In
particular, FR06 means a null saved-address id denotes no saved-address record in
this store's native model; no destination id is substituted. FR18 records the
shipping gate difference: a resolved shipment destination can satisfy the gate
without an order saved-address pointer. Snapshot authority/timing, captured header
identity, parcel-specific lines, exact reservation links, payment lifecycle,
tracking activity, operation evidence, contact provenance and correction surfaces
retain their individual named limits rather than fabricated equivalents.

The architecture's fulfillment/native parity section documents the schema and
gate options and both limits. The package README documents explicit composition.
The public contract snapshots expose the additive variant and options; existing
managed order shape and default validation remain unchanged. Test placement,
fixture ownership and proof requirements in the contribution guide remain
correct: this row adds witnesses in the existing PostgreSQL and package roots.
Any emitted test documentation obligation requires the change's own later commit
trailer; no commit or trailer sign-off is manufactured before the API read.

## Acceptance and sufficient evidence

Run real PostgreSQL through the restricted runtime role on the qualified chain:
status filter, paging/total, both detail selectors, missing id, holds, payment,
destination refusal, purchase reservations, and replay-free repeated reads.
Installed-consumer proof uses local tarballs only, once with a new empty npm cache
offline and once normally, executing the compiled public factory.

Capture managed regression expectations from the pinned base files in a scratch
copy before modifying the seam. Literal expectations cover valid rows, null,
missing and malformed saved-address ids, other invalid order fields, list/detail
envelopes, default handler success/INVALID_RESPONSE and full default builder output
with and without a shipping pointer. The native variant accepts null identity,
rejects missing/malformed identity and retains the other refusals. Test explicit
gate overrides and default behavior independently. All 31 existing fulfillment
test files stay byte-identical to HEAD and run unchanged alongside the new suite.

Required additional evidence: API snapshots, source-tree scanners, strict
published-tree typecheck, lint, neutrality with zero increases, ast-grep, publication
policy/navigation and official packed/code comparison against the pinned base.
The current comparison base is the landed main commit above. The row stop remains 9,000
packed bytes. Absolute ceilings come from `packages/platform/release-gates.json`:
`pack.code.maxPackedBytes` is 2,055,017 and `pack.maxPackedBytes` is 2,595,000.
Do not trim behavior to fit. Canonical verification is not part of this run.

## Evidence history and execution boundary

Earlier proof established seven restricted-role PostgreSQL cases, 32 native
package/consumer cases and all 31 existing fulfillment files (222 cases), plus
unchanged source scanners, typecheck, lint, neutrality and API checks. Those
results preceded the response seam and do not establish its regression proof.
The last earlier official measurement was +5,338 packed / +4,821 code bytes;
that measurement is superseded only by a completed comparison for this seam.

Earlier stopped states concerned missing nonmutating destination authority,
predecessor catalog sorting, donor mapping and the saved-address representation
and served wiring. Their owner rulings now permit only the explicit schema and
gate seams above. No test assertion failure was retried; prior asynchronous
admission completion was corrected before counted stages. Native review cycles
remain zero. No SQL or lookup workaround is permitted by these recoveries.

Self-retro: identity and existence are separate facts. An additive schema variant
and explicit gate input preserve that distinction while default regression cases
protect existing managed behavior; a parallel handler or shared nullability
relaxation is unnecessary.

## Proof history and export placement

The earlier official comparison measured +8,540 packed / +8,081 code bytes.
The candidate is 2,461,366 packed bytes versus 2,452,826 at base; code is 1,965,332
versus 1,957,251, below 1,970,000. Unpacked size is 11,591,835 versus 11,538,316
(+53,519), with 3,035 versus 3,032 files (+3). The accepted row packed stop is now
9,000 bytes. The export-placement repair below is followed by a fresh comparison;
nothing was trimmed.

The previous focused run passed PostgreSQL 7/7 and the 51 native cases, but the
unchanged parent-entry inventory test rejected an added runtime factory export.
The bounded repair removes that parent-entry export. The factory stays internal,
imported by relative path in the native module and its new regression tests. No
other path used it through the parent entry. The type re-export was also removed:
the API extractor already follows the option signatures' internal type imports,
so no parent re-export is needed. The parent entry is byte-identical to base.
All 31 existing fulfillment tests remain unchanged. No behavior or native-entry
export changes are included in the repair.

The renewed declaration/source comparison passed 68 default-shape checks.
The regenerated API snapshots pass their standard check. PostgreSQL passes 7/7;
all 32 fulfillment files pass, totaling 273 cases (222 existing and 51 native).
The 31 existing test files and three helpers remain byte-identical to HEAD.
The installed native consumer passes with an empty offline cache and once normally.
All five published-tree typecheck projects pass with zero additional errors or
unresolved edges; lint passes with zero errors, neutrality has zero increases,
and ast-grep passes. The unchanged source scanners also pass: package boundaries
2,954, import map 123 and outcome projection 7. Final policy and size evidence
is recorded below. The prior failing assertion was not rerun on the same input; the export
placement cause was repaired under explicit authority before new proof.

The only new lint failure was a restricted direct-dist import in the scratch
baseline probe. Replacing it with the existing public package entry fixed the
error without changing the recorded base expectations or tracked implementation.
The repaired lint run passed; no test assertion was retried.

Self-retro: an internal schema-construction seam does not need a parent runtime
export. Keeping that boundary internal preserves the exact existing public entry
and avoids changing a characterization witness.

The renewed official comparison after export placement is +8,486 packed bytes,
+8,047 code bytes, +53,196 unpacked bytes and +3 files against the pinned base.
Candidate: 2,461,312 packed / 1,965,298 code / 11,591,512 unpacked / 3,035 files.
Base: 2,452,826 packed / 1,957,251 code / 11,538,316 unpacked / 3,032 files.
This is below the accepted 9,000-byte row stop and 1,970,000-byte code ceiling.
The final official comparison is repeated after the last tracked evidence edit.
That historical comparison predates the frozen predecessor merge and default
destination view binding; the fresh read packet records their final measurement.

Publication policy/navigation completed against the explicit stacked base: three
documentation obligations, with only the uncommitted `tests` obligation at
`CONTRIBUTING.md#development-preview-checks` unanswered. The `fulfillment-package`
source responsibility at
`docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#fulfillment-contracts` is answered by
the substantive native projection/parity text: internal schema construction,
optional response schemas, unchanged managed defaults, explicit shipping gate
fact and both address limits. Catalog sorting and generated navigation pass.
The committed-binding snapshot notice is informational, refreshed at release prep.
No other policy/navigation error remains. Lint has zero errors and 57 warnings
in unchanged source/copied scratch files; neutrality inventories 7,048 text and
57 binary files with zero increases.

Exact emitted deferred trailer template:

```text
OpenLup-Doc-Impact: {"unit":"tests","digest":"sha256-33de92948b14764ccb90f335e56b4efbdba3ed542b336aa92719a9f240de20fa","reason":"<why this section stays correct>"}
```

Proposed scoped reason for a later authorized own commit, not a sign-off:

```text
OpenLup-Doc-Impact: {"unit":"tests","digest":"sha256-33de92948b14764ccb90f335e56b4efbdba3ed542b336aa92719a9f240de20fa","reason":"Extends native fulfillment reads, schema/default compatibility and installed-consumer witnesses within the existing PostgreSQL and package test roots using the qualified installation and restricted runtime fixture. Test placement, fixture ownership, required commands and proof rules remain unchanged."}
```

No commit or DCO is created to answer that obligation before the API read. The
source/tests are frozen; final staged identity and exact binary patch are recorded
in the read packet after the last tracked edit and final official measurement.

## Destination view rebind

The frozen predecessor merge is conflict-free and preserves the row's own delta.
Only the destination option becomes optional; its existing shape and all other
public inputs and response schemas remain unchanged. FR01–FR08 and FR10–FR18
retain their identifiers and meaning. The default view returns the existing
reader facts only; revision and pinned metadata are not exposed. No SQL, routine,
grant or managed-rail change is included in the rebind.

The row's two new test files exercise default reads, both mapped refusals,
unchanged unmapped errors and injected precedence. The PostgreSQL suite runs in
the default session zone, Etc/GMT-9 and Etc/GMT+5, verifies the effective zone on
both connections, and uses explicit UTC instants in fixtures. Existing fulfillment
tests remain byte-identical to the frozen predecessor. Strict typecheck command:
`npm run oss:published-tree -- --typecheck`.

Self-retro: using the predecessor's existing view removes the pinning dependency
without a second destination mechanism or a wider public type change.

Self-retro: a clean predecessor merge preserves the accepted behavior while
refreshing its documentation comparison base; no implementation repair is needed.

## Canonical UUID matching

The destination owner check compared UUID spellings and could falsely refuse a
correctly owned destination supplied by an injected reader. A private helper
now forms comparison-only UUID keys, accepting case differences, optional braces
and hyphen-less hexadecimal spelling, with exact comparison for other text.
The check alone uses these keys; stored values and echoed fields remain unchanged.
The response contract accepts only the hyphenated form and therefore never echoes
the other two spellings. Different owner values retain the same named refusal;
injected-reader precedence and unmapped-error propagation are unchanged.
There is no public API, SQL, export, dependency or budget change in this repair.
This is recorded as a permitted defect fix for the adoption receipt list.

The sweep below covers the new native source and the optional seam edits.
Line numbers identify the repaired source; grouped SQL sites retain each separate
operand's classification. No site consumes both a database UUID and an identity
text value. Existing managed associations outside the optional seam are unchanged.

| Site (file:line) | Type of the other side | Decision |
| --- | --- | --- |
| `packages/platform/src/fulfillment/native/commerceReads.ts:37` | database uuid | Destination lookup already casts the request id through `$1::uuid`; preserve SQL value matching. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:43` | database uuid | Settlement order join is UUID-to-UUID in SQL; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:44` | database uuid | Cycle lookup is UUID-to-UUID in SQL; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:45` | database uuid | Hold order lookup is UUID-to-UUID in SQL; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:46` | database uuid | Item order lookup is UUID-to-UUID in SQL; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:47` | database uuid | Operation shipment lookup casts `$2::uuid`; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:49` | database uuid | Tracking shipment join is UUID-to-UUID in SQL; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:50` | database uuid | Tracking order lookup is UUID-to-UUID in SQL; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:52` | database uuid | Purchase reservation lookup is UUID-to-UUID in SQL; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:53` (renewal id) | database uuid | Renewal reservation lookup is UUID-to-UUID in SQL; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:53` (fingerprint) | caller-written stored text | Fingerprint equality is identity; preserve exact bytes. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:54` | database uuid | Order lookup casts `$1::uuid`; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:65` | database uuid | Compare the reader client id with the order client id using private comparison-only keys. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:124` | database uuid | Both detail selectors reach SQL through `$n::uuid` casts; unchanged. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:96` | none | Echo the reader client id without rewriting; destination id is not compared or substituted. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:104` | provider reference | Forward the payment reference unchanged; no UUID interpretation. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:106` | provider reference | Forward the tracking reference unchanged; role selection remains a literal SQL filter. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:73` | none | Snapshot lookup uses an ordinal, not an identifier. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:87` | none | Operation map keys are status vocabulary, not identifiers. |
| `packages/platform/src/fulfillment/native/commerceReads.ts:88` | none | Evidence role comparisons select vocabulary, not provider-reference values. |
| `packages/platform/src/fulfillment/commerceFulfillmentReadModel.ts:105` | none | The optional gate map uses the host projection's own order-id key; no stored-side comparison or transformation is added. |
| `packages/platform/src/fulfillment/handlerSchemas.ts:107`; `packages/platform/src/fulfillment/commerceFulfillmentHandlers.ts:49,94`; `packages/platform/src/fulfillment/contracts/read.ts:20`; `packages/platform/src/fulfillment/native/index.ts:88` | none | Schema selection, generic containers and re-exports add no identifier comparison or lookup; existing UUID validation remains unchanged. |

Package witnesses exercise detail and list success for the exact uppercase and
lowercase finding pair with unchanged echoes. Braced and hyphen-less matching
owners reach the existing schema refusal; different owners retain the ownership
refusal. A real PostgreSQL witness supplies the fixture client's uppercase UUID
through the served detail and list handlers and verifies different-owner refusal.
The database suite retains its default, Etc/GMT-9 and Etc/GMT+5 sessions.
Existing fulfillment tests remain unchanged; the two existing new test roots
contain the added witnesses.

Self-retro: separating ownership acceptance from response representation avoids
widening a schema to prove a private comparison repair. The first brief's witness
ambiguity was resolved before any repair or review cycle was consumed.

The first pre-commit lint run refused a test import across the package export
boundary. The database witness now keeps its response stub local and imports
only declared package entries; no shared fixture or lint exception is added.
Self-retro: use a local structural response stub for an isolated served-handler
witness instead of importing another test root's fixture.

Strict typechecking then identified numeric page values in the new HTTP witness.
The served calls now use query-string values, while direct port calls retain
numeric paging. Self-retro: model the actual HTTP request boundary in served
witnesses and check its types before the final repair commit is frozen.
