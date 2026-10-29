# M16 R1: company identity and market preservation import

## Outcome and authority

Prepare one draft PR containing the unchanged lookup engine and reusable money
functions in existing `@openlup/platform` subpaths, with preservation evidence.
Author/single writer: this task's Codex supervisor. Accountable human: Bart
Roszkowski <dev@openlup.com>. Coordinator: the existing programme coordinator.
Direct assignment on 2026-10-29 and coordinator decisions CD-M16-1 through 5
admit local work, DCO commit, push and **draft PR only**. Native review, prepare,
receipt, ready, queue, merge, releases and activation are deferred. M15 has
priority; no native SQL, cap changes, new package, policy extraction, application
caller swap, provider integration or adopter mutation belongs to R1.

Source and freshly fetched policy pin: `8faa3232c6858cd219cfa1f16173a9ad00fe7ca6`; code base is the same main revision. Donor extraction identity:
`d311443ada8cf3a764bd55c4e9930ca9d58d9856`. The donor C0/C1 record reports
218 preservation cases in 16 files (18 selectors; two absent), plus six real-PG
cases. These historical counts are not an execution result for this candidate.
No private files, history, fixtures or tests are imported. Existing public source
is the import basis; missing witness scenarios are authored with synthetic data.

## Fit probe, completed before port freeze

Inspected each operation's source, schemas, actual caller and persistence owner.
The seven company/service/handler and money implementation files compared to
C1 are byte-identical on public main. The following mappings freeze behaviour,
including compatibility policy that later R2 may move behind the same witness.

| Operation | Fields and order | Process and cross-run state / R1 mapping |
| --- | --- | --- |
| O1 company | Request: country, identifierKind/value, purpose, optional manualCompany. Company: country, identifierKind/value, legalName, registeredAddress (line1/postalCode/city/country), registryStatus, optional nullable regon/vatStatus. Result: contractVersion/status/verificationLevel/company/sources/warnings; source: providerKind/status/observedAt/evidenceHash. Strict validation and NIP normalization precede lookup. Custom identity is manual only. Sequential providers accumulate source evidence; completion exits early except the existing PL personal-name enrichment rule. Thrown providers abort; returned unavailability is evidence and allows later providers. | Keep core unchanged: its strict schema rejects registry extensions. Platform compatibility schemas preserve them, including manual input. Handler: method → request parse → cache/port → output parse → responder. Cache can retain an invalid output before response validation; preserve this order. Shared maps across factories, UTC-day + country/kind + trimmed lowercase value key; purpose and provider identity absent. TTL 10 minutes, max 5,000, oldest insertion evicted, hits do not refresh insertion. Manual data bypasses cache and dedupe; rejected flight is released for retry. Maps are process memory only; no customer writes or durable lookup state. |
| O2 directory handlers/client | Preserve existing shipping handler and exact host schemas: postalCode, q, localityId, limits; candidate locality/street IDs, country/postal and geographic codes, confidence/resolutionLevel, sources/provenance and optional meta.dataAvailable. The shipping handler validates method/input before its lookup read, then validates output. The managed BFF wrapper first reads environment, composes the service gateway and runs its availability probe **before** invoking that handler, including on a later method refusal. Probe false is distinct from a failed probe (metadata omitted). | Retain current managed reference lane and existing shipping exports. Empty suggestions are valid and never gate manual shipping. No new native search or PostgREST claim. No directory/customer write in a lookup. |
| O3 directory adapter/SQL | Existing active filters, prefix/parent/limit predicates and source revision/status/URL/time mapping. Postal/probe uses actual supported PG gateway; locality/street transport mapping plus direct SQL predicates remain separate evidence. | No migration issued or replayed. Public baseline contains the old June objects; later RLS closure removes directory admin policies. Six C1 scenarios must be reauthored over the selected current installation, with restricted runtime reads and denied anonymous/writes, not treated as proof of historical June installation. No live rows/import/licence action. |
| O4 settlement/fiscal/display | Settlement currency, acceptedCurrencies, exponent, regionCode, minimumProductPayableMinor and fiscalProfile (included/country/category/vatRateBps/legalBasis). Preserve blank/default/malformed distinctions, exact COMMERCE keys and named errors. Currency validated then region, exponent then floor then fiscal. Formatting uses each amount's own currency/exponent; no conversion or historical relabelling. | Package pure record readers/exponent/formatter. Ambient bundler environment read and one-time initializer remain in the existing application wrapper, with repeat-same allowed and conflicting profile refused before money parsing. No application import is swapped; package import reads no process or browser storage. Compatibility defaults remain unchanged until R2, including opaque fiscal category data. |
| O5 locale/routes | Donor URL-owned PL/EN, isolated render instances, no missing-key fallback, namespace-specific resources; stale language storage cannot change route locale. Route tables/resources differ or are absent in public main. | R1 retains public routes and resolveLocale unchanged. Donor content/runtime and explicit neutral resource/route mapping belong to R2, not a new R1 runtime. Existing public route tests are reused; absent private locale suites cannot honestly be reported as 218 newly passing public cases. Preserve the donor 218-case baseline and name this mapping limit in the handoff. |
| O6 shipping/drafts | Donor form/codec/store inspected: invoice lookup/accepted company PII is final-only and omitted from the draft allowlist; public shipping fields and delivery option ID survive reload. Account drafts exclude contact/address fields. Version-2 envelope, step IDs/numeric fallback, legacy migration, 7-day TTL and key scopes remain application-owned. | R1 changes no codec/store/key/SQL/caller. Reuse public draft reload/legacy/TTL and shipping canonical-key witnesses. Preserve historical money through own-currency formatting. Lookup introduces no write port. Never require invoice PII to survive restart. |

Port freeze: package source preserves the already-public implementation bodies;
only module paths, host-neutral HTTP types, injected existing BFF responder,
neutral contract/helper names and pure formatter's direct exponent dependency
change. Browser contracts are types over core plus the existing optional registry
fields; compatibility validators stay outside the contracts entry. No widening of
core or silent stripping is permitted. Separate provider/pack policy extraction
and application delegation wait for R2/R3.

## Proof plan and sufficient evidence

Use existing public tests where adequate; port the ten service and ten handler C1
scenarios into package tests without changing expectations, author the three host
schema scenarios, and add discriminating shared-cache/oldest-eviction/day-key,
manual-extension and initialization/persistence fit cases. Money tests retain
existing assertions against package imports. Existing directory tests retain
mapping/fault/metadata boundaries; six real-PG scenarios use current installation.
A faithful invoice client consumes real packed exports/declarations early, with
found/invalid/manual/unavailable paths and independent EN/EUR/region/fiscal facts.
Exact tarball hashes identify the trial. No workspace source can stand in for it.

Run focused ast-grep, lint, API snapshots/check, published-tree policy/docs,
neutrality, redacted Gitleaks and focused Vitest (at most two workers), real PG.
Measure with existing package-size tooling; retain exceeded caps for the
coordinator after M15 integration. Draft verify uses the assigned external script
only after load <8 and no other verify/Vitest/pgTAP, checking every 60 seconds for
at most 120 minutes; M15/M14 retain priority. Native counted review is deferred
by the explicit assignment. Simplicity pre-check for its later review: reuse the
already public engine and current shipping/persistence owners; another lookup,
formatter, migration or pack registry is unnecessary.

## Execution evidence and remaining gates

Implemented four experimental subpaths, API snapshots, required package witness
selections and cold-consumer entries. No reference production caller changed.
Focused ast-grep, lint (33 pre-existing warnings, zero errors), the five-project
typecheck (zero unresolved edges/errors), API check, UI neutrality and staged
redacted Gitleaks passed. Policy navigation/catalogue are updated; no-impact
trailers explain test-only adapter/browser changes and additive graph/cold-proof
registration without changing contributor checks.

Early actual installed-artifact trial passed both NodeNext and Bundler declarations
and the faithful invoice acceptance/refusal paths (found, invalid, manual,
unavailable, wrong-country acceptance refusal), with EN display, configured EUR,
independent region/fiscal facts and historical JPY formatting. It used these
working-tree tarballs, based on the source pin above:

- Core SHA-256: `b0b2b80b1322778bc62c51053efb6ee506abc11813f9f774ee22ad73e3bd83f5`.
- Platform SHA-256: `7b5552dc5d661d1f5ecd184f4ea728b989a307a671c6a75a5b4db6674c7c37ae`.

Existing `measurePack` over the first useful tarball measured 2,661 total files
against 2,628; 2,607 code files against 2,574 (both +33). Packed 1,963,216 /
2,029,568 bytes; unpacked 9,108,838 / 9,447,424; code gzip 1,695,566 /
1,743,872; docs gzip 58,773 / 73,728, five docs files / ten. Final measurement
follows the committed candidate. No cap is changed; CD-M16-5 defers allocation
until actual M15 integration.

Full-tree neutrality **fails**: newly packaged preserved country, currency and
locale compatibility literals are counted as new per-path debt. This includes
runtime defaults/validation/enrichment and their synthetic preservation fixtures.
No control, baseline, allowance, spelling obfuscation or behaviour was changed to
hide this conflict. The coordinator must reconcile preservation versus neutrality
before arming. Historical 218/218 remains the donor baseline, not a false current
public count: absent locale/content/quote witnesses need their explicit later
mapping. Native review/arming and M15 integration remain later coordinator work.

Focused runtime: **24 files / 2,904 cases PASS**, maxWorkers 2, 36.86 seconds.
This includes package boundaries/cold-proof tooling, the public preservation
counterparts and ten missing fit cases; it does not convert the absent donor
locale/content/quote cases into a current 218-case public claim. Real PostgreSQL:
**1 file / 6 cases PASS**, 1.74 seconds, over exact selected current managed
baseline directory objects plus their three actual RLS policy removals. This
retains the six donor scenario classes, with disclosed managed prerequisites;
it does not prove a complete installation or PostgREST/native search transport.
The helper removed its owned tmpfs container. The initial focused run was
23 files / 2,903 PASS and one new test-spy assertion failure; capturing the
original json spy before the wrapper replaces it fixed the fixture. The final
full focused selection passed without a production change or timeout increase.

The first pre-test waiter yielded behind M14 for eight minutes without running
a test. The requested cheap two-worker selection and small PG proof then ran;
the heavy draft verify still requires its separate quiet-machine admission.
Draft verify/delivery results will be reported with the exact PR head and tree;
no native prepare, review, receipt, ready or merge has run.

Self-retro: the early fit probe separated transient invoice identity from durable
shipping intent and exposed absent locale witnesses before contract freeze.
The first API update lacked a built core prerequisite; building core corrected
that setup failure. Publication validation caught an unregistered documentation
link and fragment over-registration; explicit catalogue rows and existing
fragment pattern admission fixed them without changing controls. Keep those
failures distinct from the unresolved neutrality/witness and cap decisions.
