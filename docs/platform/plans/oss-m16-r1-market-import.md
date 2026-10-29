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
| O1 company | Request: country, identifierKind/value, purpose, optional manualCompany. Company: country, identifierKind/value, legalName, registeredAddress (line1/postalCode/city/country), registryStatus, optional nullable regon/vatStatus. Result: contractVersion/status/verificationLevel/company/sources/warnings; source: providerKind/status/observedAt/evidenceHash. Strict validation and NIP normalization precede lookup. Custom identity is manual only. Sequential providers accumulate source evidence; completion exits early except the existing reference-country personal-name enrichment rule. Thrown providers abort; returned unavailability is evidence and allows later providers. | Keep core unchanged: its strict schema rejects registry extensions. Platform compatibility schemas preserve them, including manual input. Handler: method → request parse → cache/port → output parse → responder. Cache can retain an invalid output before response validation; preserve this order. Shared maps across factories, UTC-day + country/kind + trimmed lowercase value key; purpose and provider identity absent. TTL 10 minutes, max 5,000, oldest insertion evicted, hits do not refresh insertion. Manual data bypasses cache and dedupe; rejected flight is released for retry. Maps are process memory only; no customer writes or durable lookup state. |
| O2 directory handlers/client | Preserve existing shipping handler and exact host schemas: postalCode, q, localityId, limits; candidate locality/street IDs, country/postal and geographic codes, confidence/resolutionLevel, sources/provenance and optional meta.dataAvailable. The shipping handler validates method/input before its lookup read, then validates output. The managed BFF wrapper first reads environment, composes the service gateway and runs its availability probe **before** invoking that handler, including on a later method refusal. Probe false is distinct from a failed probe (metadata omitted). | Retain current managed reference lane and existing shipping exports. Empty suggestions are valid and never gate manual shipping. No new native search or PostgREST claim. No directory/customer write in a lookup. |
| O3 directory adapter/SQL | Existing active filters, prefix/parent/limit predicates and source revision/status/URL/time mapping. Postal/probe uses actual supported PG gateway; locality/street transport mapping plus direct SQL predicates remain separate evidence. | No migration issued or replayed. Public baseline contains the old June objects; later RLS closure removes directory admin policies. Six C1 scenarios must be reauthored over the selected current installation, with restricted runtime reads and denied anonymous/writes, not treated as proof of historical June installation. No live rows/import/licence action. |
| O4 settlement/fiscal/display | Settlement currency, acceptedCurrencies, exponent, regionCode, minimumProductPayableMinor and fiscalProfile (included/country/category/vatRateBps/legalBasis). Preserve blank/default/malformed distinctions, exact COMMERCE keys and named errors. Currency validated then region, exponent then floor then fiscal. Formatting uses each amount's own currency/exponent; no conversion or historical relabelling. | Package pure record readers/exponent/formatter. Ambient bundler environment read and one-time initializer remain in the existing application wrapper, with repeat-same allowed and conflicting profile refused before money parsing. No application import is swapped; package import reads no process or browser storage. Reference defaults remain application-owned and unchanged; the package receives fallback facts explicitly. |
| O5 locale/routes | Donor URL-owned reference-country/EN, isolated render instances, no missing-key fallback, namespace-specific resources; stale language storage cannot change route locale. Route tables/resources differ or are absent in public main. | R1 retains public routes and resolveLocale unchanged. Donor content/runtime and explicit neutral resource/route mapping belong to R2, not a new R1 runtime. Existing public route tests are reused; absent private locale suites cannot honestly be reported as 218 newly passing public cases. Preserve the donor 218-case baseline and name this mapping limit in the handoff. |
| O6 shipping/drafts | Donor form/codec/store inspected: invoice lookup/accepted company PII is final-only and omitted from the draft allowlist; public shipping fields and delivery option ID survive reload. Account drafts exclude contact/address fields. Version-2 envelope, step IDs/numeric fallback, legacy migration, 7-day TTL and key scopes remain application-owned. | R1 changes no codec/store/key/SQL/caller. Reuse public draft reload/legacy/TTL and shipping canonical-key witnesses. Preserve historical money through own-currency formatting. Lookup introduces no write port. Never require invoice PII to survive restart. |

Port freeze now follows the lead design below. The donor fit observations above
remain the preservation basis for ordering, fields and state. Package policy and
fallback facts are caller inputs; reference application behaviour is unchanged. Browser contracts are types over core plus the existing optional registry
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

## Lead disposition and final design

On 2026-10-29 the R1 lead, under the coordinator, directed continuation to
DRAFT_READY. Neutrality must be fixed in code without suppressions, allowances,
baseline/scanner/control changes. Every C1 case must have an explicit disposition;
a missing witness for packaged or touched behaviour is repaired in R1. Package
caps are measured and reported, **not a draft blocker**, with allocation after
M15. This supersedes the initial package freeze and blocker disposition, without
changing the observed donor fit facts above. Dedicated branch, single writer,
DCO/push/draft-only authority and no native review/prepare/receipt/ready remain.
Fresh instruction pin is `6943ac89907cd0b8c818094defdfd2dee190a2f7`; the fork
base remains `8faa3232c6858cd219cfa1f16173a9ad00fe7ca6`. The current instruction
delta adds risk-test placement; no task control is relaxed or copied locally.

The package defines no market defaults or national rules. `CompanyIdentityRules`
contains normalization, validity, fuller-name comparison and continuation hooks;
`defaultCompanyIdentityRules` is identity normalization, non-empty validity and
no fuller-name preference/continuation. The engine retains the custom-identifier
check, completeness preference, provider/evidence order and not-last-provider
condition. The handler retains method → parse → shared cache/port → output parse
→ responder. Key scope, TTL, 5,000 oldest-insertion cap and flight/manual behaviour
are unchanged; rule identity deliberately does not partition that cache. The
schemas, lookup and handler factories accept the same optional rules object.
The neutral default matches the reference's country-without-national-validation
path except its formerly country-independent fuller-name comparison: that
comparison is now explicitly host policy. Synthetic rules prove every hook and
last-provider stop without importing any national algorithm.

Money readers require caller fallback currency, region and fiscal facts.
`readMinimumProductPayableMinor` already receives its currency explicitly and
keeps the exponent-derived floor. Environment keys, blank/absent/malformed
semantics, validation order and error names/messages/fields are retained. No
currency/region/fiscal/display-language constants or language selector remain
in the package. Exponent lookup retains the reference's fixed technical lookup
locale (not a display-language or market default); formatters still require the caller's locale and currency.
Reference ambient initialization, national rules, fiscal facts and all production
callers remain byte-identical to the original task base. R2 chooses pack homes;
R3 delegates application composition. No issued SQL or cap is edited.

## C1 preservation mapping (218 + 6)

Read-only source: donor extraction `d311443ada8cf3a764bd55c4e9930ca9d58d9856`.
No donor tests were copied or executed. Static case enumeration expands inline
parameter tables, the two quote lanes × three profiles, and the 79 SSG paths
from that revision's route manifest. Case ordinals below follow source order.
Titles containing deployment/market labels are rendered as neutral descriptions;
donor path plus ordinal disambiguates the exact original case without publishing those
labels. Identical-public rows collapse a whole byte-identical file as requested.
Donor paths use the donor: prefix to identify the extraction repository, not
executable references in this checkout. All other cases have one row each; public home titles identify actual witnesses,
or an explicitly planned later owner for excluded behaviour.

The two absent selectors are server/adapters/mfVat/mfVatLookupClient.test.ts and
server/adapters/gusCeidg/gusCeidgLookupClient.test.ts: neither contributes a case.
The quote file's 19 cases concern application quote factories, eager module
observation and promotion composition. R1 packages none of those factories and
changes none of their consumers, so they are later:R3. These 19 quote cases have
no public counterpart today. R3 must author their neutral public witness before
it swaps src/lib/currency or quote composition to package delegation. Package settlement, fiscal,
floor refusal and historical formatting remain covered now by the money witness
files, including explicit fallback facts. O5 resources/routes/namespaces are
later:R2, since R1 adds no locale runtime or route composition. These explicit
exclusions are not material proof gaps in the packaged R1 boundary.

| Donor file and case (source ordinal) | Public home and case | Status / reason |
| --- | --- | --- |
| donor:server/domains/company-identity/companyIdentityService.test.ts #1: returns unsupported_country without a registered strategy | server/domains/company-identity/companyIdentityService.test.ts → #1: returns unsupported_country without a registered strategy (unchanged public app case); packages/platform/test/company-identity/companyIdentityService.test.ts → returns unsupported_country without a registered strategy | identical-public + carried-R1: same engine expectations, synthetic rule input |
| donor:server/domains/company-identity/companyIdentityService.test.ts #2: allows custom identifiers only as manual_unverified | server/domains/company-identity/companyIdentityService.test.ts → #2: allows custom identifiers only as manual_unverified (unchanged public app case); packages/platform/test/company-identity/companyIdentityService.test.ts → allows custom identifiers only as manual_unverified | identical-public + carried-R1: same engine expectations, synthetic rule input |
| donor:server/domains/company-identity/companyIdentityService.test.ts #3: rejects invalid national identifier before provider calls | server/domains/company-identity/companyIdentityService.test.ts → #3: rejects invalid national identifier before provider calls (unchanged public app case); packages/platform/test/company-identity/companyIdentityService.test.ts → rejects invalid synthetic identifier before provider calls | identical-public + carried-R1: same engine expectations, synthetic rule input |
| donor:server/domains/company-identity/companyIdentityService.test.ts #4: continues from MF not_found to GUS complete data | server/domains/company-identity/companyIdentityService.test.ts → #4: continues from MF not_found to GUS complete data (unchanged public app case); packages/platform/test/company-identity/companyIdentityService.test.ts → continues from first absent source to later complete data | identical-public + carried-R1: same engine expectations, synthetic rule input |
| donor:server/domains/company-identity/companyIdentityService.test.ts #5: continues past a complete MF personal-name JDG record and prefers a fuller CEIDG name | server/domains/company-identity/companyIdentityService.test.ts → #5: continues past a complete MF personal-name JDG record and prefers a fuller CEIDG name (unchanged public app case); packages/platform/test/company-identity/companyIdentityService.test.ts → continues past a complete first personal-name record and prefers a fuller later name | identical-public + carried-R1: same engine expectations, synthetic rule input |
| donor:server/domains/company-identity/companyIdentityService.test.ts #6: does not call later providers when MF returns a complete company legal name | server/domains/company-identity/companyIdentityService.test.ts → #6: does not call later providers when MF returns a complete company legal name (unchanged public app case); packages/platform/test/company-identity/companyIdentityService.test.ts → does not call later providers when the first provider returns a complete company legal name | identical-public + carried-R1: same engine expectations, synthetic rule input |
| donor:server/domains/company-identity/companyIdentityService.test.ts #7: retains ordered unavailable/not-found evidence without inventing a company | packages/platform/test/company-identity/companyIdentityService.test.ts → retains ordered unavailable and absent evidence | carried-R1: same engine expectations, synthetic rule input |
| donor:server/domains/company-identity/companyIdentityService.test.ts #8: keeps a partial company and its source when later enrichment is unavailable | packages/platform/test/company-identity/companyIdentityService.test.ts → retains partial identity when enrichment is unavailable | carried-R1: same engine expectations, synthetic rule input |
| donor:server/domains/company-identity/companyIdentityService.test.ts #9: distinguishes an exhausted absent chain from an unavailable provider | packages/platform/test/company-identity/companyIdentityService.test.ts → distinguishes exhausted absence from unavailability | carried-R1: same engine expectations, synthetic rule input |
| donor:server/domains/company-identity/companyIdentityService.test.ts #10: propagates a provider fault instead of recording a successful registry observation | packages/platform/test/company-identity/companyIdentityService.test.ts → propagates provider throws and never calls the next provider | carried-R1: same engine expectations, synthetic rule input |
| donor:server/domains/company-identity/companyIdentityHandlers.test.ts #1: coalesces concurrent identical provider lookups | server/domains/company-identity/companyIdentityHandlers.test.ts → #1: coalesces concurrent identical provider lookups (unchanged public app case); packages/platform/test/company-identity/companyIdentityHandlers.test.ts → coalesces concurrent identical provider lookups | identical-public + carried-R1: same HTTP/cache/error expectations |
| donor:server/domains/company-identity/companyIdentityHandlers.test.ts #2: serves a short TTL cache for repeated identical lookup keys | server/domains/company-identity/companyIdentityHandlers.test.ts → #2: serves a short TTL cache for repeated identical lookup keys (unchanged public app case); packages/platform/test/company-identity/companyIdentityHandlers.test.ts → serves a short TTL cache for repeated identical lookup keys | identical-public + carried-R1: same HTTP/cache/error expectations |
| donor:server/domains/company-identity/companyIdentityHandlers.test.ts #3: evicts expired cache entries so the map stays bounded over time | server/domains/company-identity/companyIdentityHandlers.test.ts → #3: evicts expired cache entries so the map stays bounded over time (unchanged public app case); packages/platform/test/company-identity/companyIdentityHandlers.test.ts → evicts expired cache entries so the map stays bounded over time | identical-public + carried-R1: same HTTP/cache/error expectations |
| donor:server/domains/company-identity/companyIdentityHandlers.test.ts #4: refuses methods before parsing or calling the lookup port | packages/platform/test/company-identity/companyIdentityHandlers.test.ts → refuses the method before parsing or lookup | carried-R1: same HTTP/cache/error expectations |
| donor:server/domains/company-identity/companyIdentityHandlers.test.ts #5: rejects an invalid body without provider work: empty body | packages/platform/test/company-identity/companyIdentityHandlers.test.ts → refuses invalid input before lookup: empty body | carried-R1: same HTTP/cache/error expectations |
| donor:server/domains/company-identity/companyIdentityHandlers.test.ts #6: rejects an invalid body without provider work: invalid country | packages/platform/test/company-identity/companyIdentityHandlers.test.ts → refuses invalid input before lookup: invalid country | carried-R1: same HTTP/cache/error expectations |
| donor:server/domains/company-identity/companyIdentityHandlers.test.ts #7: rejects an invalid body without provider work: unknown purpose | packages/platform/test/company-identity/companyIdentityHandlers.test.ts → refuses invalid input before lookup: unknown purpose | carried-R1: same HTTP/cache/error expectations |
| donor:server/domains/company-identity/companyIdentityHandlers.test.ts #8: validates provider output and does not expose an invalid payload | packages/platform/test/company-identity/companyIdentityHandlers.test.ts → validates output without exposing private diagnostics | carried-R1: same HTTP/cache/error expectations |
| donor:server/domains/company-identity/companyIdentityHandlers.test.ts #9: reports a port fault without diagnostic leakage and releases the failed in-flight key for retry | packages/platform/test/company-identity/companyIdentityHandlers.test.ts → redacts a port fault and releases the flight for retry | carried-R1: same HTTP/cache/error expectations |
| donor:server/domains/company-identity/companyIdentityHandlers.test.ts #10: does not deduplicate or cache manual company input | packages/platform/test/company-identity/companyIdentityHandlers.test.ts → bypasses both cache and coalescing for manual company data | carried-R1: same HTTP/cache/error expectations |
| donor:src/domains/company-identity/companyIdentityContracts.test.ts #1: keeps adopter national identifier normalization downstream of the neutral core contract | packages/platform/test/company-identity/contracts.test.ts → normalizes the selected national identifier downstream of core | carried-R1: strict extensions and selected-rule normalization; core unchanged |
| donor:src/domains/company-identity/companyIdentityContracts.test.ts #2: keeps the package request parser country-neutral | packages/platform/test/company-identity/contracts.test.ts → leaves core request parsing country neutral | carried-R1: strict extensions and selected-rule normalization; core unchanged |
| donor:src/domains/company-identity/companyIdentityContracts.test.ts #3: preserves adopter registry extensions outside the core package | packages/platform/test/company-identity/contracts.test.ts → preserves registry extensions and full source evidence | carried-R1: strict extensions and selected-rule normalization; core unchanged |
| donor:server/adapters/ceidg/companyLookupClient.test.ts — all 5 cases | Same path and unchanged case titles/assertions; byte-identical on instruction main | identical-public (5) |
| donor:src/domains/address-canon/contracts.test.ts — all 3 cases | Same path and unchanged case titles/assertions; byte-identical on instruction main | identical-public (3) |
| donor:src/domains/address-canon/addressCanonClient.test.ts — all 3 cases | Same path and unchanged case titles/assertions; byte-identical on instruction main | identical-public (3) |
| donor:server/domains/address-canon/addressCanonLookupHandler.test.ts — all 3 cases | Same path and unchanged case titles/assertions; byte-identical on instruction main | identical-public (3) |
| donor:server/adapters/supabase/address-canon/addressCanonLookup.test.ts #1: reports dataAvailable=false when the localities directory is empty | server/adapters/supabase/address-canon/addressCanonLookup.test.ts → reports dataAvailable=false when the localities directory is empty | public-equivalent: existing probe assertions unchanged |
| donor:server/adapters/supabase/address-canon/addressCanonLookup.test.ts #2: reports dataAvailable=true when the localities directory has rows | server/adapters/supabase/address-canon/addressCanonLookup.test.ts → reports dataAvailable=true when the localities directory has rows | public-equivalent: existing probe assertions unchanged |
| donor:server/adapters/supabase/address-canon/addressCanonLookup.test.ts #3: treats null data as not available | server/adapters/supabase/address-canon/addressCanonLookup.test.ts → treats null data as not available | public-equivalent: existing probe assertions unchanged |
| donor:server/adapters/supabase/address-canon/addressCanonLookup.test.ts #4: issues a limit-one existence probe rather than exact counts | server/adapters/supabase/address-canon/addressCanonLookup.test.ts → issues a limit-one existence probe rather than exact counts | public-equivalent: existing probe assertions unchanged |
| donor:server/adapters/supabase/address-canon/addressCanonLookup.test.ts #5: surfaces a probe error so the caller can decide to omit the hint | server/adapters/supabase/address-canon/addressCanonLookup.test.ts → surfaces a probe error so the caller can decide to omit the hint | public-equivalent: existing probe assertions unchanged |
| donor:server/adapters/supabase/address-canon/addressCanonLookup.test.ts #6: normalizes locality search and forwards bounded active-row query with exact source evidence | server/adapters/supabase/address-canon/addressCanonLookup.test.ts → preserves normalized prefix mapping, bounds and every locality/provenance field | carried-R1: same mapping/refusal, synthetic row country |
| donor:server/adapters/supabase/address-canon/addressCanonLookup.test.ts #7: keeps street search within the requested locality and carries source revision | server/adapters/supabase/address-canon/addressCanonLookup.test.ts → preserves street identity, parent scope, optional prefix and limit | carried-R1: same mapping/refusal, synthetic row country |
| donor:server/adapters/supabase/address-canon/addressCanonLookup.test.ts #8: returns empty query results without a source lookup and omits the optional street prefix | server/adapters/supabase/address-canon/addressCanonLookup.test.ts → keeps valid empty results and skips source queries without rows | carried-R1: same mapping/refusal, synthetic row country |
| donor:server/adapters/supabase/address-canon/addressCanonLookup.test.ts #9: does not invent provenance for a missing source and preserves a disabled-source fact | server/adapters/supabase/address-canon/addressCanonLookup.test.ts → does not invent missing provenance or hide disabled source status | carried-R1: same mapping/refusal, synthetic row country |
| donor:server/adapters/supabase/address-canon/addressCanonLookup.test.ts #10: surfaces a directory read failure rather than representing it as zero matches | server/adapters/supabase/address-canon/addressCanonLookup.test.ts → propagates read faults rather than returning a valid empty result | carried-R1: same mapping/refusal, synthetic row country |
| donor:server/bff/address-canon/shared.test.ts #1: fails closed before gateway composition when Supabase service env is missing | server/bff/address-canon/shared.test.ts → fails closed before gateway composition when Supabase service env is missing | public-equivalent: existing assertions unchanged |
| donor:server/bff/address-canon/shared.test.ts #2: stamps meta.dataAvailable=true on the success envelope when the directory is loaded | server/bff/address-canon/shared.test.ts → stamps meta.dataAvailable=true on the success envelope when the directory is loaded | public-equivalent: existing assertions unchanged |
| donor:server/bff/address-canon/shared.test.ts #3: stamps meta.dataAvailable=false so empty candidates can be read as 'not loaded' | server/bff/address-canon/shared.test.ts → stamps meta.dataAvailable=false so empty candidates can be read as 'not loaded' | public-equivalent: existing assertions unchanged |
| donor:server/bff/address-canon/shared.test.ts #4: omits the hint and never fails the lookup when the probe throws | server/bff/address-canon/shared.test.ts → omits the hint and never fails the lookup when the probe throws | public-equivalent: existing assertions unchanged |
| donor:server/bff/address-canon/shared.test.ts #5: leaves error envelopes from the downstream handler untouched | server/bff/address-canon/shared.test.ts → leaves error envelopes from the downstream handler untouched | public-equivalent: existing assertions unchanged |
| donor:src/lib/currency/platformCurrency.test.ts — all 28 cases | Same path and unchanged case titles/assertions; byte-identical on instruction main | identical-public (28) |
| donor:src/lib/currency/formatMinor.test.ts — all 7 cases | Same path and unchanged case titles/assertions; byte-identical on instruction main | identical-public (7) |
| donor:src/lib/currency/fiscalProfile.test.ts — all 8 cases | Same path and unchanged case titles/assertions; byte-identical on instruction main | identical-public (8) |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #1: createDbBackedCommerceQuotePort denominates the whole quote in reference default | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → createDbBackedCommerceQuotePort denominates the whole quote in reference default | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #2: createStaticCommerceQuotePort denominates the whole quote in reference default | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → createStaticCommerceQuotePort denominates the whole quote in reference default | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #3: createDbBackedCommerceQuotePort denominates the whole quote in EUR | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → createDbBackedCommerceQuotePort denominates the whole quote in EUR | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #4: createStaticCommerceQuotePort denominates the whole quote in EUR | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → createStaticCommerceQuotePort denominates the whole quote in EUR | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #5: createDbBackedCommerceQuotePort denominates the whole quote in CZK | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → createDbBackedCommerceQuotePort denominates the whole quote in CZK | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #6: createStaticCommerceQuotePort denominates the whole quote in CZK | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → createStaticCommerceQuotePort denominates the whole quote in CZK | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #7: names no currency as a default in any file that defines or feeds a quote-port factory | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → names no currency as a default in any file that defines or feeds a quote-port factory | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #8: the DB-backed lane refuses when the price list is denominated in something else | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → the DB-backed lane refuses when the price list is denominated in something else | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #9: the DB-backed lane prices normally when the price list agrees | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → the DB-backed lane prices normally when the price list agrees | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #10: the static lane refuses a price book denominated in something else | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → the static lane refuses a price book denominated in something else | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #11: the static lane prices normally when the price book agrees | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → the static lane prices normally when the price book agrees | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #12: the preview compatibility export shares the first module-evaluation observation | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → the preview compatibility export shares the first module-evaluation observation | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #13: quote imports do not eagerly load administrative preview or code generation | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → quote imports do not eagerly load administrative preview or code generation | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #14: "./commercePromotionPayableFloor.js" refuses a malformed floor during import, before any invocation | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → "./commercePromotionPayableFloor.js" refuses a malformed floor during import, before any invocation | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #15: "./promotionCodePreview.js" refuses a malformed floor during import, before any invocation | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → "./promotionCodePreview.js" refuses a malformed floor during import, before any invocation | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #16: "./quotePromotionV2.js" refuses a malformed floor during import, before any invocation | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → "./quotePromotionV2.js" refuses a malformed floor during import, before any invocation | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #17: "./quotePromotionCodeAdjustments.js" refuses a malformed floor during import, before any invocation | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → "./quotePromotionCodeAdjustments.js" refuses a malformed floor during import, before any invocation | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #18: "./dbBackedCommerceQuotePort.js" refuses a malformed floor during import, before any invocation | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → "./dbBackedCommerceQuotePort.js" refuses a malformed floor during import, before any invocation | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:server/domains/commerce/quoteCurrencyNeutrality.test.ts #19: factory construction observes later settlement while promotion money keeps the imported floor | server/domains/commerce/quoteCurrencyNeutrality.test.ts (planned) → factory construction observes later settlement while promotion money keeps the imported floor | later:R3: application quote/import/promotion composition; none packaged or touched |
| donor:src/i18n/config.test.ts #1: keeps the compatibility instance reference-language regardless of stale device state | src/public-reference/i18n/config.test.ts (planned) → keeps the compatibility instance reference-language regardless of stale device state | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #2: creates independent route-loaded render instances | src/public-reference/i18n/config.test.ts (planned) → creates independent route-loaded render instances | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #3: does not fall back to reference-language when an English key is missing | src/public-reference/i18n/config.test.ts (planned) → does not fall back to reference-language when an English key is missing | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #4: loads localized dog catalog copy without cross-language fallbacks | src/public-reference/i18n/config.test.ts (planned) → loads localized dog catalog copy without cross-language fallbacks | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #5: derives contact default locale from the URL | src/public-reference/i18n/config.test.ts (planned) → derives contact default locale from the URL | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #6: derives contact English locale from the URL | src/public-reference/i18n/config.test.ts (planned) → derives contact English locale from the URL | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #7: derives catalog English locale from the URL | src/public-reference/i18n/config.test.ts (planned) → derives catalog English locale from the URL | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #8: derives feedback English locale from the URL | src/public-reference/i18n/config.test.ts (planned) → derives feedback English locale from the URL | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #9: derives review English locale from the URL | src/public-reference/i18n/config.test.ts (planned) → derives review English locale from the URL | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #10: derives review default locale from the URL | src/public-reference/i18n/config.test.ts (planned) → derives review default locale from the URL | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #11: derives account default locale from the URL | src/public-reference/i18n/config.test.ts (planned) → derives account default locale from the URL | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/config.test.ts #12: loads the exact order-review namespace for both entry paths | src/public-reference/i18n/config.test.ts (planned) → loads the exact order-review namespace for both entry paths | later:R2: O5 render/resource/URL composition excluded from R1 |
| donor:src/i18n/namespaces.test.ts #1: prepares every namespace used by the hydratable homepage tree | src/public-reference/i18n/namespaces.test.ts (planned) → prepares every namespace used by the hydratable homepage tree | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #2: explicitly maps the SSG route / | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route / | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #3: explicitly maps the SSG route /private-label | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /private-label | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #4: explicitly maps the SSG route /en | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /en | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #5: explicitly maps the SSG route /dogs/lamb | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /dogs/lamb | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #6: explicitly maps the SSG route /dogs/venison | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /dogs/venison | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #7: explicitly maps the SSG route /dogs/beef | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /dogs/beef | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #8: explicitly maps the SSG route /dogs/turkey | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /dogs/turkey | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #9: explicitly maps the SSG route /dogs/salmon | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /dogs/salmon | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #10: explicitly maps the SSG route /dogs/pork | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /dogs/pork | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #11: explicitly maps the SSG route /how-it-works | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /how-it-works | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #12: explicitly maps the SSG route /our-story | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /our-story | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #13: explicitly maps the SSG route /terms | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /terms | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #14: explicitly maps the SSG route /privacy-policy | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /privacy-policy | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #15: explicitly maps the SSG route /cookie-policy | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /cookie-policy | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #16: explicitly maps the SSG route /returns | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /returns | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #17: explicitly maps the SSG route /contact | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /contact | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #18: explicitly maps the SSG route /psy/jagniecina | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /psy/jagniecina | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #19: explicitly maps the SSG route /psy/dziczyzna | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /psy/dziczyzna | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #20: explicitly maps the SSG route /psy/wolowina | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /psy/wolowina | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #21: explicitly maps the SSG route /psy/indyk | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /psy/indyk | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #22: explicitly maps the SSG route /psy/losos | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /psy/losos | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #23: explicitly maps the SSG route /psy/wieprzowina | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /psy/wieprzowina | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #24: explicitly maps the SSG route /jak-to-dziala | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /jak-to-dziala | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #25: explicitly maps the SSG route /nasza-historia | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /nasza-historia | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #26: explicitly maps the SSG route /regulamin | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /regulamin | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #27: explicitly maps the SSG route /polityka-prywatnosci | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /polityka-prywatnosci | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #28: explicitly maps the SSG route /polityka-cookies | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /polityka-cookies | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #29: explicitly maps the SSG route /zwroty | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /zwroty | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #30: explicitly maps the SSG route /kontakt | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /kontakt | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #31: explicitly maps the SSG route /rasy | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #32: explicitly maps the SSG route /rasy/maltanczyk | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/maltanczyk | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #33: explicitly maps the SSG route /rasy/owczarek-niemiecki | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/owczarek-niemiecki | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #34: explicitly maps the SSG route /rasy/buldog-francuski | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/buldog-francuski | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #35: explicitly maps the SSG route /rasy/yorkshire-terrier | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/yorkshire-terrier | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #36: explicitly maps the SSG route /rasy/shih-tzu | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/shih-tzu | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #37: explicitly maps the SSG route /rasy/labrador-retriever | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/labrador-retriever | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #38: explicitly maps the SSG route /rasy/chihuahua | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/chihuahua | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #39: explicitly maps the SSG route /rasy/jamnik | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/jamnik | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #40: explicitly maps the SSG route /rasy/miniaturowy-jamnik | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/miniaturowy-jamnik | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #41: explicitly maps the SSG route /rasy/mops | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/mops | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #42: explicitly maps the SSG route /rasy/beagle | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/beagle | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #43: explicitly maps the SSG route /rasy/border-collie | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/border-collie | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #44: explicitly maps the SSG route /rasy/amstaff | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/amstaff | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #45: explicitly maps the SSG route /rasy/golden-retriever | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/golden-retriever | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #46: explicitly maps the SSG route /rasy/rottweiler | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/rottweiler | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #47: explicitly maps the SSG route /rasy/bokser | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/bokser | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #48: explicitly maps the SSG route /rasy/cane-corso | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/cane-corso | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #49: explicitly maps the SSG route /rasy/dog-niemiecki | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/dog-niemiecki | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #50: explicitly maps the SSG route /rasy/wilczarz-irlandzki | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/wilczarz-irlandzki | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #51: explicitly maps the SSG route /rasy/moskiewski-strozujacy | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/moskiewski-strozujacy | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #52: explicitly maps the SSG route /rasy/sznaucer-olbrzym | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/sznaucer-olbrzym | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #53: explicitly maps the SSG route /rasy/bialy-owczarek-szwajcarski | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/bialy-owczarek-szwajcarski | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #54: explicitly maps the SSG route /rasy/owczarek-belgijski-malinois | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/owczarek-belgijski-malinois | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #55: explicitly maps the SSG route /rasy/owczarek-belgijski-groenendael | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/owczarek-belgijski-groenendael | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #56: explicitly maps the SSG route /rasy/siberian-husky | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/siberian-husky | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #57: explicitly maps the SSG route /rasy/samoyed | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/samoyed | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #58: explicitly maps the SSG route /rasy/wyzel-wegierski | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/wyzel-wegierski | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #59: explicitly maps the SSG route /rasy/gonczy-polski | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/gonczy-polski | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #60: explicitly maps the SSG route /rasy/cocker-spaniel | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/cocker-spaniel | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #61: explicitly maps the SSG route /rasy/springer-spaniel-angielski | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/springer-spaniel-angielski | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #62: explicitly maps the SSG route /rasy/bearded-collie | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/bearded-collie | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #63: explicitly maps the SSG route /rasy/pudel | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/pudel | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #64: explicitly maps the SSG route /rasy/pudel-miniaturowy | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/pudel-miniaturowy | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #65: explicitly maps the SSG route /rasy/lagotto-romagnolo | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/lagotto-romagnolo | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #66: explicitly maps the SSG route /rasy/labradoodle | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/labradoodle | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #67: explicitly maps the SSG route /rasy/cavapoo | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/cavapoo | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #68: explicitly maps the SSG route /rasy/bichon-frise | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/bichon-frise | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #69: explicitly maps the SSG route /rasy/hawanczyk | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/hawanczyk | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #70: explicitly maps the SSG route /rasy/biewer-terrier | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/biewer-terrier | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #71: explicitly maps the SSG route /rasy/kokoni | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/kokoni | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #72: explicitly maps the SSG route /rasy/shiba-inu | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/shiba-inu | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #73: explicitly maps the SSG route /rasy/west-highland-white-terrier | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/west-highland-white-terrier | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #74: explicitly maps the SSG route /rasy/sznaucer | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/sznaucer | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #75: explicitly maps the SSG route /rasy/terier-tybetanski | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/terier-tybetanski | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #76: explicitly maps the SSG route /rasy/fox-terrier | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/fox-terrier | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #77: explicitly maps the SSG route /rasy/jack-russell-terrier | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/jack-russell-terrier | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #78: explicitly maps the SSG route /rasy/welsh-corgi-pembroke | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/welsh-corgi-pembroke | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #79: explicitly maps the SSG route /rasy/welsh-corgi-cardigan | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/welsh-corgi-cardigan | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #80: explicitly maps the SSG route /rasy/whippet | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps the SSG route /rasy/whippet | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #81: explicitly maps every localized application route | src/public-reference/i18n/namespaces.test.ts (planned) → explicitly maps every localized application route | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #82: fails closed to common for an unknown CSR path | src/public-reference/i18n/namespaces.test.ts (planned) → fails closed to common for an unknown CSR path | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #83: does not leak homepage-only namespaces into non-home routes | src/public-reference/i18n/namespaces.test.ts (planned) → does not leak homepage-only namespaces into non-home routes | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/i18n/namespaces.test.ts #84: loads the portable order-review copy only on exact capability entry paths | src/public-reference/i18n/namespaces.test.ts (planned) → loads the portable order-review copy only on exact capability entry paths | later:R2: O5 namespace/route inventory excluded from R1; map to selected reference routes |
| donor:src/lib/i18nRoutes.test.ts #1: returns localized paths for known route keys | src/lib/i18nRoutes.test.ts (R2 mapping) → returns localized paths for known route keys | later:R2: O5 route tables differ; R1 preserves current public routes without a swap |
| donor:src/lib/i18nRoutes.test.ts #2: returns localized paths for new EN parity routes | src/lib/i18nRoutes.test.ts (R2 mapping) → returns localized paths for new EN parity routes | later:R2: O5 route tables differ; R1 preserves current public routes without a swap |
| donor:src/lib/i18nRoutes.test.ts #3: builds absolute URLs against the site origin | src/lib/i18nRoutes.test.ts (R2 mapping) → builds absolute URLs against the site origin | later:R2: O5 route tables differ; R1 preserves current public routes without a swap |
| donor:src/lib/i18nRoutes.test.ts #4: finds route metadata for localized paths with or without trailing slashes | src/lib/i18nRoutes.test.ts (R2 mapping) → finds route metadata for localized paths with or without trailing slashes | later:R2: O5 route tables differ; R1 preserves current public routes without a swap |
| donor:src/lib/i18nRoutes.test.ts #5: returns null for unknown paths | src/lib/i18nRoutes.test.ts (R2 mapping) → returns null for unknown paths | later:R2: O5 route tables differ; R1 preserves current public routes without a swap |
| donor:src/lib/i18nRoutes.test.ts #6: maps alternate languages for known routes and falls back home for unknown ones | src/lib/i18nRoutes.test.ts (R2 mapping) → maps alternate languages for known routes and falls back home for unknown ones | later:R2: O5 route tables differ; R1 preserves current public routes without a swap |
| donor:src/lib/i18nRoutes.test.ts #7: maps alternate languages for new hidden routes | src/lib/i18nRoutes.test.ts (R2 mapping) → maps alternate languages for new hidden routes | later:R2: O5 route tables differ; R1 preserves current public routes without a swap |
| donor:src/lib/i18nRoutes.test.ts #8: preserves query and hash when switching language or building localized stateful paths | src/lib/i18nRoutes.test.ts (R2 mapping) → preserves query and hash when switching language or building localized stateful paths | later:R2: O5 route tables differ; R1 preserves current public routes without a swap |
| donor:scripts/m16-address-directory-parity.test.ts #1: retains the existing source/licence status and exposes active rows to a restricted reader | tests/postgres/marketDirectoryPreservation.test.ts → keeps provenance/status and active-only restricted reads | carried-R1: same scenario over actual current directory objects and role closure |
| donor:scripts/m16-address-directory-parity.test.ts #2: denies anonymous reads and authenticated writes despite the admin-all RLS policy | tests/postgres/marketDirectoryPreservation.test.ts → denies anonymous reads and authenticated writes | carried-R1: same scenario over actual current directory objects and role closure |
| donor:scripts/m16-address-directory-parity.test.ts #3: executes the real postal lookup with active filtering and complete source provenance | tests/postgres/marketDirectoryPreservation.test.ts → performs postal adapter reads with full provenance and valid empty results | carried-R1: same scenario over actual current directory objects and role closure |
| donor:scripts/m16-address-directory-parity.test.ts #4: executes locality/street prefix reads against the actual schema with parent scope, limits and provenance | tests/postgres/marketDirectoryPreservation.test.ts → retains actual prefix, parent, limit and provenance predicates | carried-R1: same scenario over actual current directory objects and role closure |
| donor:scripts/m16-address-directory-parity.test.ts #5: distinguishes an empty directory probe from a failed SQL grant | tests/postgres/marketDirectoryPreservation.test.ts → distinguishes probe failure from empty and restores after rollback | carried-R1: same scenario over actual current directory objects and role closure |
| donor:scripts/m16-address-directory-parity.test.ts #6: refuses unsupported country/postal shapes at the actual schema boundary | tests/postgres/marketDirectoryPreservation.test.ts → refuses unsupported country and postal shapes without persisting a change | carried-R1: same scenario over actual current directory objects and role closure |
Mapping counts (224 distinct cases, including six PG): **identical-public: 57**,
**identical-public + carried-R1: 9**, **carried-R1: 25**, **public-equivalent: 10**,
**later:R3: 19**, **later:R2: 104**. The combined status counts each of its nine
cases once; inclusive witness totals are 66 identical-public and 34 carried-R1.
The unchanged public service cases #1–#6 and handler cases #1–#3 remain the
reference witness for the national rule bodies, identifier checksum/normalization
and personal-name continuation. R2/R3 must keep these app cases unchanged when
routing those rules through CompanyIdentityRules; package engine tests complement
rather than replace them.
All packaged/touched classes have a current public witness; zero unmapped cases.

## Continuation evidence

Current new-seam evidence: 26 files / 2,923 focused cases PASS (two workers),
plus the six real-PG cases PASS in the 10-file / 80-case port selection. API
update/check, lint (zero errors, 33 existing warnings), five-project typecheck,
full-tree neutrality (zero increases) and UI neutrality PASS. Required gap repairs
are in the stable
witness files: synthetic normalization/checksum before lookup, injected fuller-name
continuation/replacement, last-provider stop, neutral default comparison, custom
validation ownership, and shared-cache key behavior after normalization. Money
witnesses now supply fallback facts explicitly; original application expectations
remain unchanged in their seven byte-identical files. API/cold-consumer proofs
use the new exported signatures, not the old candidate's defaults. The actual
packed consumer passed NodeNext/Bundler declarations and invoice found, invalid,
manual, unavailable and wrong-country refusal with synthetic policy inputs.
Platform tarball SHA-256: `2394d4c7cc96567077a6fc912f95e784536e48d28c292029e2d9655980220fbf`.
Core SHA-256: `b0b2b80b1322778bc62c51053efb6ee506abc11813f9f774ee22ad73e3bd83f5`.
This is the pre-commit new-seam trial; exact-head artifacts are measured again
after commit. Current measurement is 2,664/2,628 total files, 2,610/2,574 code
files; 1,955,571/2,029,568 packed bytes, 9,091,655/9,447,424 unpacked,
1,688,881/1,743,872 code gzip and 58,862/73,728 docs gzip. The two file-cap
findings are coordinator-deferred, with no cap changes.

The initial mechanical test conversion removed two expected fallback arguments;
two focused attempts exposed the same fixture error. Restoring the explicit
caller-fact expectations resolved both; the subsequent 80- and 2,923-case runs
passed. No runtime refusal, application behaviour or gate was weakened.
Policy/documentation finalization and the supplied draft-verify-r1 script remain
for the committed candidate; no native action is authorized or run.

Self-retro: a per-case inventory distinguishes out-of-scope application composition
from a packaged-boundary proof gap; explicit policy inputs close neutrality without
changing the reference application's behaviour or weakening a scanner.

## Lead review repair (heavy-stage hold)

The lead review of ec8b287f identified an unrecorded exponent lookup change and
incomplete dual-home witness citations. Restored the original fixed technical
lookup locale and call: currencyExponent code is identical to its reference app
file apart from comments. Rechecked all four package currency modules against
their app originals: remaining code differences are explicit fallback injection,
removed market defaults/display-language helpers and the formatter import path.
Reference production and test expectations remain unchanged. Nine mapping rows
now cite the unchanged app case alongside the package engine case; the quote
paragraph makes the missing public witness and R3's pre-delegation duty explicit.

Fresh policy pin: `6828103f4e8d56ca18808cfc27f606b82ea4ddba`; code fork unchanged.
The new instruction delta concerns disposable-container cleanup and its review
lesson; this repair creates no container. The coordinator's heavy-stage hold
supersedes the pending draft verify: no full/draft verify, broad tests, pgTAP,
pack builds, lint or API builds are authorized until lifted. This repair runs
only neutrality and individual package money test files with one worker, then
DCO commit, ordinary push and stop. Prior tarball hashes and measurements above
identify the earlier candidate and are not remeasured under this hold.

Repair evidence: neutrality PASS with zero increases; four package money test
files PASS individually with --maxWorkers 1 (8 fiscal, 8 formatter, 20
settlement and 3 fit cases; 39 total), using Node 24.21.0. Exponent code equality
was confirmed with comments excluded; formatter equality was confirmed after
removing display-language helpers and adjusting its import path. The settlement
and fiscal diffs contain only the approved fallback/default changes and comments.
No heavy gate was started during this repair. An initial log redirection used
the wrong relative directory and was corrected before any test process started.
Self-retro: fixed technical constants preserve behavior; neutrality does not
justify changing them. Dual-home mappings preserve national-rule witnesses as
well as neutral engine coverage for the next delegation step.

## API report follow-up (heavy-stage hold)

The coordinator authorized platform API update/check and publication policy checks
for this follow-up only; the wider heavy-stage hold remains active. Policy was
freshly fetched at `6828103f4e8d56ca18808cfc27f606b82ea4ddba`, unchanged from the
repair pin. Existing core declarations satisfied the prerequisite, so no core
rebuild was needed. Platform api:update rebuilt its declarations and removed one
module-overview comment from market-packs.api.md: after the fixed lookup constant
was restored, that comment precedes a private declaration and is legitimately
absent from the public API report. The exported error class retains its own
precise documentation. No source, signature or runtime behavior changes here;
exponent code remains identical to the app original apart from comments.
There is no root api:check script; the platform workspace owns this check.

Follow-up evidence: platform api:update and api:check PASS; neutrality PASS
with zero increases; oss:published-tree --policy PASS with seven documentation
obligations and zero unanswered. No navigation regeneration was requested.
The source-release binding snapshot remains release-preparation-owned, as
reported by the existing checker; no publication control is changed.
Self-retro: declaration comment attachment can change a generated API report
without changing signatures; regenerate it after restoring private declarations.
No full/draft verify, broad tests, pgTAP, pack builds or lint is run.

## First-candidate evidence (387ab436; retained history)

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
