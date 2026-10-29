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

## Package tooling follow-up (fix 3)

The coordinator's draft-verify-3 on 373481a4 ran 2,172 files / 22,400 tests
and reported four failures: the sanctioned server-module inventory, two browser
entry inventory refusals, and the already deferred platform pack file caps.
Following 6ad6c530, the expected server extras now include company-identity/server;
that is the only edit in eslint-import-map.test.ts. Following b9808a96, a NEW
browserEntries budget key for ./company-identity/contracts is added for the
coordinator's budget read. This is not a raise of any existing cap or budget.

The actual existing browserEntryBytes tooling, over the current built
./dist/company-identity/contracts/index.js entry, measured **20 minified+gzip
bytes**: the type-only entry produces an empty bundle. The new key is therefore
20, matching the actual measurement, rather than the anticipated 32. No tool,
contract source, other budget or file cap changes. Known platform file findings
remain code 2,610/2,574 and total 2,664/2,628, pending coordinator disposition.
The measurement is recorded locally in fix3-browser-entry.json under this task's
scratch directory; no package rebuild is needed for this configuration-only fix.

Fresh instruction pin: `8046797ace978e148556c30767d8ed231a0dd6e3`, code fork
unchanged. The instruction delta adds scoped documentation/link review and
updates disposable cleanup; no native review or container work is in this fix.
The heavy hold is lifted, but this assignment remains light: run each specified
tooling test file alone with --maxWorkers 1, then neutrality and publication
policy, DCO commit, ordinary push and stop. The coordinator owns draft verify.

Fix 3 evidence: the two files ran separately with --maxWorkers 1 on Node
24.21.0. eslint-import-map: 122/122 PASS (13.33 seconds); package-size-policy:
46/47 PASS (3.72 seconds), with only the unchanged platform file-cap case
failing on the two known excesses above. Both browser-entry inventory refusals
and the new actual contracts browser bundle check PASS. Neutrality and policy
results: neutrality PASS with zero increases. Initial publication policy found
one fresh tooling obligation because the inventory test changed; this commit
supplies its scoped no-impact trailer, checked again after commit. The platform
README already documents the experimental subpaths and existing budget route.
The added key is explicitly submitted for the coordinator budget read above;
no previously allocated cap is increased.
Self-retro: the focused selection missed the package tooling tests that enumerate module directories and browser entries; include scripts/packages/{eslint-import-map,package-size-policy}.test.ts whenever subpaths or module directories are added.

## Main integration and measurement (coordinator GO)

On 2026-10-29 the coordinator authorized merging main into R1 (no rebase),
resolving module inventories as unions, regenerating artifacts, running the
listed cheap gates, signing/pushing the integration and measuring R1 and the
full M16 packages stack. Current policy/main pin:
`8046797ace978e148556c30767d8ed231a0dd6e3`; the code comparison base becomes
that main revision after the merge. The freshly read AGENTS/CONTRIBUTING and
Documentation maintenance rules include M15's scoped ownership and #433's
link/command checks. No native prepare/review/receipt/ready/verify-local/arming
or cap allocation is authorized in this phase. PR #431 stays a draft.

Five conflicts are resolved by union: generated publication catalogue rows;
release gate browser keys (main risk unchanged, identity contracts 20 retained);
package-boundary sanctioned entries; lint graph sanctioned server splits; and
cold consumer imports/proofs (both risk workflows and the market proof retained).
Main's caps, risk source/tests/SQL and existing browser budgets are unchanged.
R1 behavior and all company/money witness files remain unchanged. API reports
are regenerated from a fresh core/platform build. The catalogue is regenerated
with the existing constructor from both sets of descriptors, and navigation
with --policy --docs-update. M15's narrower routing requires two new R1 owner
sections: existing company/money guidance is moved intact into those sections,
and only their R1 source/test/API selectors are added to documentation routing.

Local signed merge: 167455e4762be181ded0ef412e50c68dc573d230. Focused
ast-grep PASS; lint PASS (zero errors, 33 existing warnings); platform API check
PASS; UI neutrality PASS; Gitleaks PASS with 1,056 commits scanned and no leaks;
branch neutrality PASS with zero increases against main. Focused Vitest at two
workers ran 28 files / 3,150 cases in 45.17 seconds: 3,149 PASS, with only the
known platform cap case failing (code files 2,661/2,656 and total 2,716/2,712).
The cap-only result is left for the explicitly pending coordinator decision;
no behavior witness fails and no cap is changed. Git comparisons confirm both
R1 runtime/witness directories match 5f221ac8 and M15 risk source/test/SQL match
main. An initial pre-merge policy run saw the old fork plus main's ownership
transition; after the local merge, only four fresh R1 no-impact answers remain
(adapters, ownership, graph configuration and tooling). This evidence commit
refreshes those delta-bound trailers; policy is checked again before push.
Publication policy then PASSed with 10 obligations and zero unanswered. The
integration and evidence were pushed as b1c0fd8fc15ba9ab6c36ef826cc3466a967fecf4;
PR #431 remained a draft with auto-merge disabled.

Measurements use actual platform tarballs and the existing measurePack and
checkPackBudget tooling, with main's unchanged current caps. R1-only is packed
at that pushed integration head. The full stack starts at the same head in a
disposable detached worktree. R2 head, read through ls-remote:
`8278ab56835423efde7a0cd2b2280e477810a664`; R3 PR #436 head:
`257c5f8e70db56bd3919030f1bfa3ceaf8510ca3`. Both descend from R1
`5f221ac8c23c6084b3fc8d5b179c72652c066457`. Their packages-only diffs against
that R1 base are byte-identical; R3's incremental package diff over R2 is empty.
The R2 patch did not apply cleanly to the relocated README section, so the
permitted scratch merge fallback combined both heads. README resolution retains
all R2 descriptor documentation beside the R1 market section; unrelated
non-package conflicts retain the integrated version because this experiment
measures package inputs only. R2 descriptor source, witness and fragment match
their branch byte-for-byte. R1 and the full stack have identical cap objects.
No R2/R3 branch was changed. The detached worktree was removed after packing.

| Metric | Main cap | R1-only | Full M16 stack |
| --- | ---: | ---: | ---: |
| Total files | 2,712 | **2,716 (exceeds by 4)** | **2,719 (exceeds by 7)** |
| Code files | 2,656 | **2,661 (exceeds by 5)** | **2,664 (exceeds by 8)** |
| Docs files | 10 | 5 | 5 |
| Packed bytes | 2,029,568 | 1,989,426 | 1,990,053 |
| Unpacked bytes | 9,447,424 | 9,275,165 | 9,277,408 |
| Code gzip bytes | 1,743,872 | 1,714,330 | 1,714,663 |
| Docs gzip bytes | 73,728 | 60,391 | 60,562 |

R1 tarball SHA-256:
`1c77d6927a59604674716da121f9b7ab02c18c34c08069f7c1514de05d70232a`.
Full-stack tarball SHA-256:
`0c507e13fa309f62de2d93f7df438707599313933d4379f67943ad96d584e181`.
Local measurement JSON, tarballs, patches and stack provenance remain in this
task's scratch directory. This final task-record-only commit changes no package
input, so the measured package bytes remain those of the delivered integration.
No cap is changed: the coordinator owns the CD-M15-6a decision after reading
these numbers. Work stops here, without any native review, preparation, receipt,
ready transition, verification or arming.
Self-retro: integration must preserve scoped documentation ownership as well as
module inventories; regenerating output exposes missing owner selectors early.

## Authorized delivery and CD-M16-16 cap allocation

The owner's direct 2026-10-29 continuation installs this task's active Codex
supervisor as the R1 author/delivery supervisor under the M16 PROC-27 module
merge grant, after M15 landing. The coordinator is the owner's delegate under
master §1.0; CD-M16-1 through 16 and the recorded GO bind this continuation.
The grant now includes DCO commit/push, two fresh native reviews, official local
verification, PR body/readiness, receipt posting, arming and the bounded direct
enqueue fallback. Stop at actual queue confirmation or merge. This supersedes
the earlier draft-only stops; no release, activation, adopter change or unrelated
scope is added. This same thread is the sole implementation/supervisor context;
its CODEX_THREAD_ID is used by native prepare and retained in ignored evidence.
No reviewer context has implemented or supervised this candidate. Initial native
review has not yet been prepared; no native cycles or reviewer contexts have
been consumed in this task. Preserve any subsequently discovered session history.

Current fetched policy revision is
`8046797ace978e148556c30767d8ed231a0dd6e3`, separately from the candidate
identity; R1 is independent with OPENLUP_STACK_BASE unset. The assigned arming
runbook is read in full. Its snapshot predates #433: current rules additionally
require each actual native report's documentation assessment. The live native
scripts match main and implement that requirement. Pinned Node 24.21.0,
npm 11.19.0, Gitleaks 8.30.1, Docker and Supabase CLI 2.98.2 are available.
No openlup-dev installation is found, so the public native verify-local route
applies. Task evidence after candidate freeze stays in ignored scratch or PR
records; no tracked after-review bookkeeping edit is planned.

CD-M16-16 records the coordinator's maintainer/budget read and authorizes only
platform file caps: total 2,712 → 2,774 and code 2,656 → 2,718. Derivation:
ceil(2,719 × 1.02) = 2,774; ceil(2,664 × 1.02) = 2,718. Byte caps, docs caps,
browser budgets (including identity contracts 20) and all other gates stay
unchanged. The exact supplied reason is:

M16 company-identity + market-packs subpaths; measured full M16 stack on M15 main (integration f05668d6) at 2,719 total / 2,664 code files; ×1.02 rounded up (CD-M15-6a rule, CD-M16-16)

The current JSON and M15's original cap commit have no cap-reason member; retain
the derivation as pack.capReason metadata alongside these caps and in this task
record. No parser/scanner/control is changed. The committed-package checker
requires clean package inputs, so run the focused real-pack witness and other
working-tree checks, make the DCO cap commit, then run packages:check before
pushing. Working-tree cap checks: package-size-policy 48/48 PASS, including
the real platform pack; policy/docs-update PASS (10 obligations, zero unanswered);
neutrality PASS (zero increases); lint PASS (zero errors, 33 existing warnings).
All required checks and final official verification still apply.

The smallest adequate alternative considered was keeping market defaults in the
package behind a neutrality allowance. The coordinator refused that allowance;
with none, the injected rules/fallback seam is the smallest neutral route.
Review criteria retain unchanged engine/cache/money order and effects, explicit
policy inputs, reference callers unchanged, full C1 mapping with no R1 proof gap,
zero neutrality increases, identity browser budget 20 and the approved file caps.
Policy extraction, caller swap, R2/R3 pack homes and core widening stay excluded.
Three native repair cycles are available; do not use continue. After two
nonconverging evaluations, follow the existing regroup rule before further work.

Self-retro: cap approval follows measured full-stack evidence; reserve the final
tracked authority/criteria packet before native review so bookkeeping cannot
invalidate the verified tree. Later execution observations remain in scratch.

## Native repair cycle 1: PostgreSQL fixture lifecycle

Both initial fresh native review executions completed on cap candidate
26f33955d1369c8e532310ddfd9012d8112843cb. The session retains one material
finding, M16-R1-PG-LIFECYCLE: the directory fixture's literal 120-second setup
budget could expire during the helper's permitted 300-second cold pull, and
unbounded pool closes could prevent container removal. The second independent
report established no additional finding. This is one completed candidate
evaluation, not two repair cycles. Actual context identities/reports and their
execution observations are retained in ignored native-session evidence.

Repair only the new fixture lifecycle: use existing postgresSetupTimeoutMs and
postgresTeardownTimeoutMs, and closePostgres(container, [reader, owner]). The
existing helper bounds the shared close phase and attempts container removal
after failure or stall. All six test titles, SQL, role/refusal assertions and
package behavior remain unchanged. No helper, runner, timeout constant or new
mechanism is changed. Focused real-PG and existing cheap checks precede the DCO
repair commit; two new fresh contexts must review this committed tree and close
the material finding explicitly. Initial reports remain in history and do not
count as current-tree approval. The intent and 44-path scope are unchanged. Repair checks: focused real-PG
6/6 PASS (1.94 seconds); focused ast-grep PASS; lint PASS (zero errors, 33
existing warnings); neutrality PASS (zero increases). The changed fixture delta
requires a fresh tests no-impact trailer, supplied in the repair commit and
checked before re-preparation. No package runtime or artifact input changes.

Self-retro: use the canonical integration fixture lifecycle from the outset;
a passing warm-image run does not establish safe cold acquisition or bounded
teardown. This repair applies the existing rule rather than adding another
cleanup mechanism or changing any preservation assertion.

## S1 priority dequeue and 0.32.0 integration (CD-M16-17/18)

The coordinator dequeued PR #431 under CD-M16-17 to let M15 S1 land first.
That release-preparation PR #440 is now main at
`eb1a0584f035774251a8c296e82f3b9ffd68180b` (0.32.0), the freshly read
AGENTS/CONTRIBUTING and documentation policy pin for this continuation. The
owner's active-supervisor grant remains M16 PROC-27 with CD-M16-1 through 18.
CD-M16-18 gives ready M14 remainder work priority only when ready at the same
time; R1 does not wait for unready work and never jumps the queue. The previous
queue entry and successful full proof are retained as history, not reused as
current admission. Native session history stays append-only at cycle 1 of 3
before this new candidate is prepared. No continue or state recreation is used.
The prior earliest current-candidate PASS is 2026-10-29 15:22:33Z, with source
coverage expiry 2026-10-30 15:22:33Z; integration cannot renew it. If admission
cannot precede that deadline, use prepare --new and fresh full review/proof.

Signed merge 091638f0854b2dd3065efb68513956c5998bd778 has exact parents
18f71994475a30963050944b0ebc6fcbb29603ea and the S1 main pin above. Git
merged it cleanly: S1's package versions, baseline, changelogs, consumed M15
fragments, agent excerpts and release-contract snapshot remain main's exact
inputs; the four M16 exports, pending m16-r1 fragment, caps 2,774/2,718 with
their capReason and contracts browser budget 20 remain present. Runtime and
preservation witnesses are byte-identical to the prior reviewed head. Core
build and platform API regeneration are rerun; the regenerated API and source
map bytes remain unchanged. The ordinary module PR leaves S1's committed
release-contract snapshot intact; the policy checker derives the live binding
and reports its expected staleness until separate release preparation.

The merge tree initially equals Git's mechanical merge result. Current policy
requires a fresh ownership no-impact trailer because #439 changed the routing
file's before-image; this task evidence is a separate DCO commit. Native prepare
must decide actual integration eligibility on the resulting lineage. If it does
not supply candidate.integration, obtain two fresh full reviews, without
copying reports or assuming a mechanical exemption. The unchanged intent and
44-path scope remain the acceptance boundary.

The existing measurePack/checkPackBudget tools inspect the actual merged 0.32.0
platform tarball, including AGENT_CONTEXT.md. Every cap is met:

| Metric | Measured | Cap |
| --- | ---: | ---: |
| Total files | 2,717 | 2,774 |
| Code files | 2,661 | 2,718 |
| Docs files | 6 | 10 |
| Packed bytes | 1,986,329 | 2,029,568 |
| Unpacked bytes | 9,257,135 | 9,447,424 |
| Code gzip bytes | 1,714,330 | 1,743,872 |
| Docs gzip bytes | 56,939 | 73,728 |

Tarball SHA-256:
`564e2e0fb1c4dc7ca0df846f0825697825a1f24689a99ddedf605c98fb6dfa09`.
Local pack/measurement evidence is retained in this task's post-s1-pack scratch
folder. No cap is edited. The task-evidence commit changes no packed input.
Cheap gates: focused ast-grep PASS; lint PASS (zero errors, 33 existing
warnings); platform API check PASS; neutrality PASS (zero increases against
S1 main); redacted Gitleaks PASS (1,115 commits, no leaks); focused two-worker
Vitest PASS, 28 files / 3,062 cases in 14.10 seconds. Policy/excerpt generation
passes structurally and needs only the refreshed ownership trailer supplied by
this evidence commit; the final policy check follows that commit. Actual review
mode/cycle, reports, final proof,
receipt and queue observations stay in ignored evidence after source freeze.

Self-retro: the clean Git merge preserved the release/cap union, while the
changed routing before-image still required a fresh scoped impact answer.
Measure root documentation files as well as code after packaged guidance lands.

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

## Replacement-branch preparation (CD-M16-19 through 21)

The coordinator, acting under the owner's delegate grant, authorized a new
branch without rewriting history, one native continuation, and preparation
only until M14 10A lands. Current policy and integration base:
`c31cc19bfd1a1108bf14535337fbca167a82f835`; applicable instructions are unchanged
from the previously read policy. The reserved enqueue window starts later;
this preparation does not authorize starting its review or verification early.

In this same worktree, branch `claude/oss-m16-r1-market-import-2` starts at
`bed312633fcf2b89475c35202a623b0604cf0127`, whose commit message carries
`Signed-off-by: Bart Roszkowski <dev@openlup.com>`. The original branch and
unsigned integration `03c077cb87f7dc365ff3b30348444edd4fdf88be` remain untouched
and that unsigned commit is absent from the replacement branch's ancestry.
Signed merge `dd9c80805d0ab842826491a1f38c74bd8de9bcec` integrates current main.
The canonical publication-catalogue generator produces the exact union of
6,654 rows, preserving all non-inventory fields. API reports and navigation
were regenerated without additional tracked byte changes. Package behavior,
witnesses, S1 release metadata, caps and the pending fragment remain unchanged.

Replacement draft [#445](https://github.com/openlup/openlup/pull/445) retains
the neutral scope, AI disclosure and authority, and explicitly distinguishes
historical proof from pending current-candidate proof. PR #431 is closed with
the requested pointer; neither its branch nor any history was deleted.

Cheap checks pass: focused structural scan; lint (zero errors, 33 existing
warnings); platform API check; policy (10 obligations, zero unanswered);
neutrality (zero increases against the new fork point); redacted Gitleaks;
and two-worker focused Vitest (27 files, 3,134 cases, including six real-PG
preservation cases). All pack measurements remain within their unchanged caps:

| Metric | Measured | Cap |
| --- | ---: | ---: |
| Total files | 2,717 | 2,774 |
| Code files | 2,661 | 2,718 |
| Docs files | 6 | 10 |
| Packed bytes | 1,986,329 | 2,029,568 |
| Unpacked bytes | 9,257,135 | 9,447,424 |
| Code gzip bytes | 1,714,330 | 1,743,872 |
| Docs gzip bytes | 56,939 | 73,728 |

Tarball SHA-256:
`564e2e0fb1c4dc7ca0df846f0825697825a1f24689a99ddedf605c98fb6dfa09`.
Before the initial replacement push, all 14 outgoing commits were individually
confirmed to carry Bart's sign-off. The DCO command requires full commit
digests, so resolving literal HEAD gives its passing 14/14 result. Both the
requested trailer log and the resolved-digest DCO gate are required again
before every later push, including this preparation-record commit.

The exact CD-M16-20 continuation ran once in the existing native session:
allowedCycles increased from 3 to 6; cycle remains 3; history grew from 13 to
14 events. Prior candidates, reports, findings and expiry were retained.
There is no new prepare, reviewer, official verification, readiness, receipt or
enqueue in this preparation. Resume only after the explicit 10A-merged signal
and within the reserved CD-M16-21 window.

Self-retro: a conflicted merge needs an explicit `git commit -s` when completed;
the initiating merge's option alone did not protect the earlier commit.
Unsigned integration plus no-rewrite authority led to this replacement branch,
not a bypass. Moving main during long proof led to the reserved enqueue window,
not another uncontrolled verification loop.
