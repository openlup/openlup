# Reference market composition

## Outcome and authority

Prepare opt-in reference rules, address schemas, provider recipe, synthetic
examples, unmounted bilingual message data and a neutral market descriptor.
Single writer in the assigned worktree; accountable maintainer Bart Roszkowski
<dev@openlup.com>. Direct assignment and CD-M16-1..12 authorize implementation,
checks and staging. The coordinator accepted the exact-tree API/budget read;
the later direct grant authorized its DCO commit, then predecessor integration,
ordinary push and a stacked draft PR only. That preparation continuation held
native review and heavy verification. The continuation below records the later
direct grant and its current restriction under CD-M16-17.

Current code/stack base: `18f71994475a30963050944b0ebc6fcbb29603ea`, R1
head (draft #431), tree `4a81ab795a94ea674a01279cdb4dcd5c092a05e6`.
Initial implementation base was `c723bb73c57c65e3a77324c943faf1712d1f0a4c`
(tree `b785e3e907bd67b306a751702c18749212a52e54`). Instructions were read
at that head and refreshed at the policy pin below, separately from the code
base. Predecessor updates use sign-off merges, never rebases.
No other task worktree/branch is touched. Dependency install with Node 24.21.0
passed (727 packages); no dependency changes.

Scope excludes caller swaps (R3), market facts/rules in platform (CD-M16-12),
new package, SQL/migrations, provider HTTP changes, environment reads, caches,
i18n runtime, route mounting, changed defaults/refusals or persisted state.
Existing reference implementation changes are missing exports only. Caps,
suppressions, baselines, allowances and controls remain unchanged.

## Fit probe before implementation

- A1 resolved: R1 has CompanyIdentityRules injection on schema/port/handler.
  Reuse it, existing identifier helpers and exported name heuristics. Strict host
  schemas retain regon/vatStatus/address/evidence; core stays narrower. The
  normalization hook receives pre-core values: lowercase country is significant.
  The fuller-name comparison stays ungated, continuation alone is gated, and
  the engine retains the last-provider check. No additional argument is needed.
- A2 resolved: money readers require fallback currency/region/fiscal facts and
  formatting requires locale. Defaults stay in existing application owners.
  Descriptor imports those constants; ambient state stays in platformCurrency.
- A3 resolved against the exact source: frozen files below include fixture,
  cache, PG, persisted-state and packed-consumer witnesses. App national-policy
  tests remain frozen too. Historical R1/donor PASS is not R2 evidence. The
  design's companyIdentityContracts.test.ts and quoteCurrencyNeutrality.test.ts
  selectors do not exist here; R1 contracts plus unchanged service/handler
  witnesses and the R3-owned quote mapping are the actual boundaries.
  CD-M16-10 admits unmounted data only: no new route/namespace runtime or
  import of private copy; absent donor route tests are not new R2 obligations.
- A4 resolved: add descriptor through existing market-packs entry and API
  snapshot, smoke and installed-consumer cases. No new export key/module graph
  node/edge; existing exact inventories continue covering the same subpath.
  CD-M16-12 supersedes the earlier national package entry proposal.
- A5 resolved: measure cumulative package against unchanged caps; actual
  allocation after M15 is coordinator-reserved. Forecasts confer no capacity.

Fields/effects: compare full schema outputs/errors and provider transcripts.
Preserve method -> parse -> shared cache/lookup -> output validation -> responder,
source order, whole-company replacement and thrown-versus-returned failure.
R1 remains the sole cache owner: daily key, TTL, insertion cap, manual bypass and
failed-flight cleanup are unchanged. Directory bundles reuse exact schema objects
and normalizer with unchanged query/mapping bodies and optional manual shipping.
Money order stays currency, region, exponent, floor, fiscal; configured facts are
independent. No draft codec/store/key/allowlist edits: invoice PII stays transient,
address identities and historical own-currency amounts remain unchanged.

Registered follow-up, **not fixed**: isMoreComplete's fuller-name replacement
also applies outside the reference jurisdiction (donor parity, CD-M16-10/11).
Narrowing it is functional work reserved to the owner.

Proof plan: structural/lint/API/policy/neutrality/redacted secret checks first;
new equivalence/refusal/independent-fact tests and frozen affected witnesses
with two workers; selected current-object PG only under Docker/load admission;
existing package measurement and installed-artifact tooling. Missing mandatory
proof is reported. No native counted review before coordinator GO.
Simplicity pre-check: reuse imports, schema objects, one explicit provider chain
and existing money readers; no registry, plugin loader, schema framework, new
cache or translation runtime is needed.

## Frozen predecessor witnesses

All working-tree blobs below match the current approved predecessor, including
imports and expectations. The main-integration note identifies predecessor-owned
updates; original blob identities remain in the earlier task commits.

| File | R1 blob |
| --- | --- |
| `packages/platform/test/company-identity/cacheFit.test.ts` | `97464d29a75bdd8855a707c5fbc439543c69c8e9` |
| `packages/platform/test/company-identity/companyIdentityHandlers.test.ts` | `8d870fd30c21b37ea388659a254fcf5c173b3f98` |
| `packages/platform/test/company-identity/companyIdentityService.test.ts` | `b03ee633e13b052273d8a0fa908f27d163011092` |
| `packages/platform/test/company-identity/contracts.test.ts` | `75bd06b7db599f085b1ba6c00e68221681cde550` |
| `packages/platform/test/company-identity/fixtures.ts` | `3247f97c08c81b8c9c29372e024805759e496cb5` |
| `packages/platform/test/market-packs/fiscalProfile.test.ts` | `a0aebb430bf047beca03ef363d7d652d2d3482d2` |
| `packages/platform/test/market-packs/fixtures.ts` | `b3d0d4c2dd76530b4a122121580805f88b2cf8a6` |
| `packages/platform/test/market-packs/formatMinor.test.ts` | `1690e8c26b363703daf4fd52dbd2e8b776d48227` |
| `packages/platform/test/market-packs/portFit.test.ts` | `c5c82da9ceb4c6c198c7048a67f4f0c3e9d69932` |
| `packages/platform/test/market-packs/settlementProfile.test.ts` | `c8355d401ba8d356ef6f59a90370d12ab0c5596d` |
| `packages/platform/test/packageBoundary.test.ts` | `c545dd247c8d61dba9b96a2b6c72853122f2ff64` |
| `scripts/packages/market-pack-consumer-proof.ts` | `341ef6cecbdeddaf25e47b372a829a89c5deacf4` |
| `server/adapters/supabase/address-canon/addressCanonLookup.test.ts` | `f97f460cfffff92ba35c39bf0790927fca76b4c0` |
| `server/bff/address-canon/shared.test.ts` | `1512ef1c111499daf43d260651a7416cda81b1f4` |
| `server/domains/company-identity/companyIdentityHandlers.test.ts` | `19111e99f1f7d4d0a8cd546b6f6d95d11dede8fc` |
| `server/domains/company-identity/companyIdentityService.test.ts` | `0be80129b52c1e04d90953543e352464daac29c2` |
| `src/checkout/composer/marketIdentityPersistence.test.ts` | `cfc7dba7ba703102735d5238ace44a96a335cfa0` |
| `src/lib/currency/fiscalProfile.test.ts` | `a7d0cd8816a24f2cc45f92f9e376b0727e05c49a` |
| `src/lib/currency/formatMinor.test.ts` | `3e2e12935ca40768943759dc94e5a074d4f198f5` |
| `src/lib/currency/platformCurrency.test.ts` | `cbb615dd102df197dac16f12585e6b0e33b28817` |
| `tests/postgres/marketDirectoryPreservation.test.ts` | `4b2baf418e185063f8352b35c1baec1d39e53f39` |
| `scripts/packages/platform-cold-consumer.test.ts` | `f9bb24551669d29905a13d066c991ce72fe546e0` |
| `src/domains/address-canon/contracts.test.ts` | `7e410e8b917d86ab779dc042088ee29640912a22` |
| `src/domains/address-canon/addressCanonClient.test.ts` | `5d98d8406f20f3920be14a9b91697bfc53d96c5b` |
| `server/domains/address-canon/addressCanonLookupHandler.test.ts` | `9547f0c447681809766f0a19944159aa2f3732a4` |
| `src/checkout/composer/configuratorDraftCodec.test.ts` | `4b113f3308b2fe3b8650353f020535d10cf74b67` |
| `packages/platform/test/shipping/addressConformance.test.ts` | `dd9bb27736f028a4bd97fae074b1c3dba7251191` |
| `tests/platform/shipping/deliveryAddressContinuityCharacterization.test.ts` | `aae9bbc7561be3b034ab4894e0b03a1c48281eee` |
| `src/public-reference/subscriptionMessages.test.tsx` | `9143824ada4ee2d6c3b7abd2c1a4b15033e1a8ce` |

## Candidate evidence and handoff

Six new discovered test files / 32 cases PASS: rules 11, handlers 5, provider
recipe 8, market recipe 6, messages 1, descriptor 1. Focused selection: 32 files /
2,948 cases PASS, followed by the provider file (8 cases, two additive) and the
two type-repaired files (6 cases), all PASS. Unique final selected union:
32 files / 2,950 cases. This is not a newly executed donor 218-case claim.
Real PostgreSQL: unchanged selected-current-object R1 witness, 1 file / 6 cases
PASS; Docker available, admitted after 60 seconds at one-minute load 4.84.
The helper removed its owned container. This proves selected managed objects,
not full installation, live directory data, PostgREST or native search transport.

Ast-grep PASS; final lint PASS (zero errors, 33 existing warnings); package API
check PASS; policy/docs-update PASS with five obligations, zero unanswered;
neutrality PASS with zero per-path increases; Git-history and staged redacted
secret checks PASS. Five-project serialized typecheck PASS, zero unresolved edges
and zero errors. All 29 frozen predecessor/adjacent witness blobs match.
New descriptor is added within the existing market-packs entry; export keys,
module graph and boundary inventories stay unchanged. Smoke and cold-consumer
registration are additive. API generation also removes a stale predecessor
JSDoc header attached to a private constant; exponent source is unchanged.

Built tarball trial over staged package inputs PASS: NodeNext and Bundler
installed declarations, unchanged invoice witness and additive descriptor
transcript, isolated from workspace resolution and optional peers.
Platform SHA-256: `ce5759dfd844340756e61635a0a65bb37913c46c0aa6f500e334c9299a69778d`.
Core SHA-256: `b0b2b80b1322778bc62c51053efb6ee506abc11813f9f774ee22ad73e3bd83f5`.
These are working-tree artifact trial identities, not committed-head/native proof.
Existing measurePack: total 2,667 / cap 2,628; code 2,613 / 2,574;
packed 1,956,340 / 2,029,568 B; unpacked 9,093,916 / 9,447,424 B;
code gzip 1,689,283 / 1,743,872 B; docs gzip 59,057 / 73,728 B, 5 / 10 files.
The two file caps are coordinator-reserved after M15 integration; no cap changed.
packages:check refused the intentionally uncommitted platform tree; its existing
measurePack/checkPackBudget helpers measured the actual tarball separately.
No full verification, native review/session, DCO, commit or external write ran.

R3 dependencies: reference rules/schemas, address bundle, explicit provider
selection and descriptor are available. Retain the existing exported pure policy
functions as owners; delegating isValidCompanyIdentifier back through this same
rules object would recurse. No caller was swapped. Existing host locale fallback
and ambient currency initialization remain separate and unchanged.

Failed attempts retained: the initial witness inventory found an absent design
selector before any record was written. Publication checks required registering
new carrier paths, removing an inadmissible per-file fragment row (existing
pattern admission owns fragments), and reconciling staged/materialized bytes.
Initial typecheck found one test-only ES library mismatch and two partial request
casts; those were repaired and their six tests rerun. A subsequent typecheck
concurrent with lint's dist rebuild observed transient missing declarations;
that result was invalidated and replaced by the passing serialized run.
Native repair cycles/review budget consumed: zero; no counted review occurred.

Self-retro: the PG load admission cost one minute. Reusing imported policy and
schema owners avoided a second engine or schema API. The invalid concurrent
check demonstrates why build-dependent proof must follow the completed lint
build; serializing that rerun resolved the diagnostic without changing controls.

## Lead repair evidence

The proof carrier is now
[scripts/packages/market-descriptor-consumer-proof.ts](../../../scripts/packages/market-descriptor-consumer-proof.ts).
Its import, contributor link and publication carrier are updated. The contributor
addition is one sentence. This task record's path and title are also neutral;
all other new public paths, exported symbols and headings were checked. Only
the change fragment retains the explicitly permitted predecessor naming convention.
`referenceCompanyCountry` reads the existing address-canon locality schema's
country literal: that schema already owns the reference directory jurisdiction,
so company composition reuses that fact without a new token or string splitting.

Own shipped increment, derived without rebuilding the predecessor from the retained
candidate tarball and exact predecessor Git blobs: three new entries,
src/market-packs/marketDescriptor.ts 671 B,
dist/market-packs/marketDescriptor.js 322 B,
dist/market-packs/marketDescriptor.d.ts 519 B (1,512 B total).
Modified shipped bytes, predecessor -> candidate:
README.md 112,830 -> 113,390 (+560 B); release-gates.json 31,526 -> 31,580 (+54 B);
src/market-packs/index.ts 149 -> 188 (+39 B), dist/market-packs/index.js
149 -> 188 (+39 B), dist/market-packs/index.d.ts 149 -> 188 (+39 B).
The two emitted index files are export-only and exactly equal the source bytes;
their predecessor bytes are derived by removing the exact added export line,
not by compiling or packing the predecessor. No other shipped entry is added
or changed by this task. Total own increment: +3 files (+3 code), +2,243 unpacked B
(1,512 new +731 modified); inferred predecessor inventory 2,664 total / 2,610
code files and 9,091,673 unpacked B, versus cumulative candidate 2,667 / 2,613
and 9,093,916 B. Compressed tarball growth is not additive and is not inferred.
The retained candidate tarball and cumulative measurements remain unchanged.

Fresh instruction pin for this repair: `6828103f4e8d56ca18808cfc27f606b82ea4ddba`;
the initial implementation base remains recorded above. The current instruction
delta concerns risk witness placement and owned-container cleanup; these rename-only repairs create no container or new proof lane.
The prior implementation evidence remains attributed to the earlier candidate;
this repair runs only the lead-selected policy, neutrality, structural, focused
ESLint and cold-consumer unit checks, plus staged whitespace validation.
Self-retro: neutral carrier naming is part of the public surface check. Deriving
the own file/byte increment from retained artifacts avoids a predecessor rebuild
and separates cumulative size pressure from this task's three shipped additions.

The repair policy check initially treated inline tarball-relative names as
repository links; plain tarball-entry text resolved that documentation error.

Repair verification PASS: policy/docs regeneration and policy-only check (five
obligations, zero unanswered), zero-increase neutrality, ast-grep, ESLint on the
two changed TypeScript files, and the unchanged cold-consumer unit suite
(1 file / 89 cases, two workers, 37.70 seconds). Staged whitespace and all 29
frozen witness blobs pass. Package/runtime/test bodies are unchanged from the
prior staged candidate; no package build or predecessor rebuild was rerun.
No DCO, commit, push, native review or external mutation occurred.

## Predecessor integration and draft delivery

The direct continuation grant names predecessor
`373481a4e3795ab6f78ce05e19278cdb0f8bc6cd`. Its fetched remote ref matches;
it descends from the initial implementation base. Merge
`6621e282774a21aa450bf46f34e9b3f7f0fbd382` retains both parents and the
maintainer identity/sign-off, with no conflicts. R1 changes only its task record
and regenerates the stale exponent API comment. The stacked API diff now has
only the descriptor export and declarations; no comment removal remains.
No generated conflict or regeneration delta requires another implementation
commit. All 29 frozen witness blobs match the new predecessor. No R1 witness
was touched by its API/documentation-only update, so no additional R1 test
rerun is selected. Prior artifact measurements are unchanged: this integration
changes no shipped package bytes. Required focused checks use the new stack
base; native review and heavy verification wait for the later authorized stage.
Self-retro: the sign-off predecessor merge retained the exact reviewed package
bytes while attributing the stale API-report correction to its original owner.

Integration checks PASS: platform workspace API check; publication policy with
five answered obligations; zero-increase neutrality; ast-grep; six focused
files / 32 cases with two workers. The final stacked DCO range is checked before
submission. No native or heavy verification was run under the retained hold.

## Companion registration integration

Predecessor `5f221ac8c23c6084b3fc8d5b179c72652c066457` matches its fetched
remote ref and descends from `373481a4e3795ab6f78ce05e19278cdb0f8bc6cd`.
Sign-off merge `b7d1b8cbec586e0d3001e2be3213a6ecc9433fe1` completed without
conflicts. It retains both the predecessor's type-only browser-entry budget and
module-boundary test registration and this task's descriptor smoke selection.
No production implementation, API declaration or frozen witness is changed by
that predecessor update.
The added companion registration witness itself also matches the predecessor.
The later one-line handler test repair remains; every assertion is unchanged.
Fresh instruction pin: `8046797ace978e148556c30767d8ed231a0dd6e3`, separate
from this code/stack base. The current contribution delta concerns labeled disposable-container cleanup
defaults; this continuation creates no container or helper change. It does not
admit heavy verification. This continuation
runs the two named companion suites and six task suites only after one-minute
load falls below eight, with a bounded 60-second polling loop. The expected
real-pack file-cap finding remains coordinator-reserved; no cap is changed.
Native review, preparation, receipt, ready and draft verification remain held.

Prior tarball byte measurements remain historical: this predecessor adds a
shipped release-gates entry, while this continuation adds no shipped file.

Continuation evidence: companion admission after 60 seconds at load 7.74;
ESLint import-map 122/122 PASS, package-size-policy 46/47 with exactly one
expected real-platform-pack failure containing only code files 2,613 / cap
2,574 and total files 2,667 / cap 2,628. Every other companion assertion passed,
including the newly registered browser entry. This is a cap finding, not a
passing full artifact-budget gate. No cap, timeout or assertion was weakened.
The six task test files passed 32/32 cases after separate load admission at
6.57, 193 seconds from the start of the bounded wait. API check, publication
policy (five answered obligations), zero-increase neutrality and ast-grep PASS.
All 29 frozen witnesses and both named companion files match the predecessor.
Owner-driven documentation regeneration produced no tracked output delta.
Self-retro: separate load admission for each Vitest invocation protected the
running predecessor verification and kept the expected budget finding distinct
from registration or behavior regressions. No native/heavy verification ran.

## Main and risk union integration

Predecessor `f05668d67b50a211e89a98f578cc37bb57b68fd6` matches its fetched
remote ref and descends from `5f221ac8c23c6084b3fc8d5b179c72652c066457`.
Sign-off merge `759c3ebc229639badfd7e51639cad7910e3d00bb` keeps both parents.
Four authored documentation files conflicted. Saved resolutions were inspected,
then rebuilt as explicit unions so incoming policy/risk guidance and this task's
market composition survive. Package-source navigation follows the incoming
README's current-main link convention. The incoming catalogue, risk subpaths,
module graph, package boundary/import-map witnesses and all budget values remain
intact; the package gate diff adds only this task's descriptor smoke witness.
API and documentation owner regeneration produced no tracked generated delta.
The new precise documentation owner required a reference-composition row in the
existing adapter capability map; no ownership rule or scanner was changed.

The current frozen table carries the predecessor's updated packageBoundary and
platform-cold-consumer unit-test blobs from main's risk integration. These are
predecessor-owned witness updates; no R2 test expectation was changed. All other
original frozen blobs remain identical. Current instruction/main pin is
`8046797ace978e148556c30767d8ed231a0dd6e3`, separate from the stack base.
Earlier pre-main artifact byte/cap measurements remain historical; the selected
real-pack witness measures this integrated candidate under main's current caps.
The six reference test files and two companion files run only after load is
below eight, with bounded 60-second polling. No native or heavy verification is
admitted by this continuation, even though main's risk programme has landed.


Integrated proof: the companion suites were admitted after 420 seconds at load
4.77. ESLint import-map passed 123/123; package-size-policy passed 47/48, with
one expected real-platform-pack case containing only code files 2,664 / cap
2,656 and total files 2,719 / cap 2,712. Every other content/browser budget
assertion passed. This retains a budget finding, not a passing full package gate;
no cap, test, timeout or assertion was weakened. The six reference files passed
32/32 after separate admission at load 5.51, 432 seconds into the wait.
API, structural scan, six answered documentation obligations and zero-increase
neutrality passed. All 29 current frozen blobs, both companion files, the risk
manifest/module graph and package boundary match the integrated predecessor.
No generated output changed after the owner commands. A predecessor-owned blank
line at the end of its historical cleanup plan appeared in the whole merge's
whitespace diagnostic; the scoped delta against this predecessor remains clean.
Self-retro: inspecting saved conflict resolutions prevented lost reference prose.
Using the existing capability-map owner closed the documentation gap without
adding routing controls. The load wait cost seven minutes; the only remaining
package finding is the explicitly deferred file-cap allocation.

## Allocated budget and fixture predecessor

Predecessor `18f71994475a30963050944b0ebc6fcbb29603ea` is reachable from the
fetched R1 remote and descends from `f05668d67b50a211e89a98f578cc37bb57b68fd6`.
The prior main-integration merge was confirmed on the pushed R2 branch before
sign-off merge `076a97ee35170283a44d31413ec83bef04b026e3`, which had no conflicts.
The package pack object matches R1 exactly: CD-M16-16 allocated 2,774 total
and 2,718 code files, with its capReason; byte/docs caps are unchanged. This task
made no independent cap edit. Earlier file-cap findings remain historical.
The predecessor also owns the bounded PostgreSQL fixture lifecycle repair;
its current blob is recorded in the frozen table, with all scenario assertions
unchanged. No other frozen blob advanced in this continuation.
Current instruction/main pin is `15a708a6b5b34f8a6d27b25f4867787425084bf7`,
separate from the stack base. Its worker-default guidance was read; this task
still selects two workers explicitly and admits each test phase only below
one-minute load eight. No native or heavy verification is authorized here.


Allocated-budget proof: both companion files PASS, 171/171 cases (ESLint
import-map 123; package-size-policy 48, including the formerly failing real-pack
budget case). Admission loads were 6.88 and 7.70 for companion and reference
phases, with no polling delay. The six reference files PASS 32/32 cases.
The existing measurePack/checkPackBudget helpers, over the same npm working-tree
pack dry-run entries as the required real-pack witness, report zero findings:

| Measure | Current candidate | Incoming R1 cap |
| --- | ---: | ---: |
| Total files | 2,719 | 2,774 |
| Code files | 2,664 | 2,718 |
| Packed bytes | 1,990,177 | 2,029,568 |
| Unpacked bytes | 9,277,699 | 9,447,424 |
| Code gzip bytes | 1,714,663 | 1,743,872 |
| Docs gzip bytes | 60,705 | 73,728 |
| Docs files | 5 | 10 |

API, six answered documentation obligations, neutrality with zero increases,
ast-grep and full lint PASS (zero errors, 33 existing warnings). Build-dependent
checks were serialized after the tests. All 29 current frozen witnesses match
the requested predecessor, including its fixture repair. No generated output
or cap value was edited by this continuation. Native/heavy verification remains
held; the fixture scenarios were not rerun beyond the requested focused selection.
Self-retro: consuming the delegated budget unchanged closed the real-pack
finding without weakening its assertion. This integration needed no conflict
resolution, test repair or load wait; only the predecessor identity and its
fixture blob advanced in the current record.


## Native review before the post-S1 predecessor

The owner assigned Codex as active supervisor for PR #434 in the existing
`claude/oss-m16-r2-market-packs` worktree. The later arming grant under CD-M16-1
permits delivery after the required predecessor. CD-M16-17 dequeued R1 until
the M15 S1 0.32.0 release PR merges; R1 will integrate main and acquire a new
head. The binding follow-up limits this run to the task-record update, Bart
Roszkowski <dev@openlup.com> DCO commits, fast-forward pushes, native prepare
and two independent fresh counted reviews on the current exact R1 pin.
Full local verification, ready/main retargeting, receipt and queue/merge wait
for R1's post-S1 head to be merged into R2 and integration-reviewed. Heavy
priority is M15, then M14, then M16. This run does not invoke canonical
`verify-local --pgtap` or make ready, receipt or queue writes.

Current policy revision is `ef99742de560bb88865794a8a1694884d65d06ea`, separate
from the unchanged exact stack pin
`18f71994475a30963050944b0ebc6fcbb29603ea`. No catch-up main merge or rebase
is authorized here. The supplied arming runbook governs the permitted steps;
exact-candidate native history and terminal evidence remain under
`.context/scratch/agent-review/`. There is no earlier native session or consumed
repair cycle. Three changed-tree repair cycles are permitted, with no automatic
continuation. New functionality, changed fallbacks, accepted regressions,
settings, credentials, releases and caps remain owner-reserved. The existing
maintainer read and CD-M16-10/11/12/14 remain applicable; CD-M16-16 is consumed
unchanged through R1. No adopter endpoint is in scope.

Acceptance remains the frozen R1 witness bytes, host extension fields, provider
and validation order, shared cache scope, defaults, fallbacks and refusals.
The descriptor and language/currency/pricing-region/fiscal inputs remain
independent; bilingual data and the source recipe remain opt-in and unmounted.
No caller swap, SQL/migration, vendor change, export-key addition, neutrality
increase or cap edit is admitted. This run requires two counted fresh PASS
reports and native `reviewed`. Those reports provide prior source coverage for
the later integration review, subject to native lineage and expiry checks;
they do not prove the future integrated tree or replace its required final
verification. Terminal evidence, remaining work and self-retro extend this
task's ignored execution summary without changing reviewed tracked inputs.
