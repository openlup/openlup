# Public CI diagnostic obligations

Status: the managed runtime repair closes the twelve SQL obligations recorded below. Historical measurements are archived; both unrestricted diagnostics must remain visible and new failures require triage.
Audience: contributors repairing published tests and runtime contracts.

Accountable triage owner for **every row**: **OpenLup maintainer**. Each follow-up family identifies repair scope, not an assigned person's commitment. These records introduce no skip, exception, assertion budget or waiver. Failed behavior and ACL checks are unresolved defects or contract mismatches; calling a test fixture incomplete does not prove the runtime safe.

Retired test rows below link to their archived source at the repair base. These dated results remain historical evidence; current test scope follows [contribution checks](../../../CONTRIBUTING.md#development-preview-checks).

## Current checkpoint

The managed forward `20261004123000_runtime_capability_rls_closure.sql` closes the twelve
failing or aborted SQL files from the earlier checkpoint. It repairs the
installed trigram operator schema, narrows unnecessary client/payment-method
projections and admits only the existing callers' required columns and helpers.
The separately approved control must precede this forward's comparison base
and introduction parent. The immutable baseline remains unchanged.

The complete SQL suite retains all 205 existing files and adds two capability
and renewal-lock regressions: 207 files and 4,626 assertions. The repaired support/operator
invoker paths execute as `service_role`; authenticated profile proofs retain
RLS isolation. No existing SQL assertion was removed or skipped. Those runtime
witnesses use the owner only for fixtures and state observation. Supplementary
owner-only characterization is not proof of service execution, and test-only
application grants do not supply missing runtime permissions. Replaying the committed baseline and ordered forwards into a fresh owned database preserves this result.

Unrestricted npm verification must pass without new skips. The one skipped
file and two skipped cases described in the archived checkpoint are unchanged.
Local committed-chain verification and hosted source/group/main checks are
separate evidence; the delivery PR records the exact commit and CI runs. A
proposed SQL overlay alone does not prove the committed chain or hosted CI.

Direct service-role UPDATE admission is real table-column permission, usable
outside operator RPC gates. In particular `subscriptions.updated_at` can be
written directly; it is the single-column capability required to preserve both
existing `FOR UPDATE OF s SKIP LOCKED` clauses. Eight legacy id-only browser policies are retired before membership reads can
activate cross-customer access. Customer-own policies and own membership reads
remain; actual distributor, administrator, machine, revoked and customer roles
prove the boundary. Browser writes, anonymous permissions and operator RPC
execution do not expand. Existing RLS, human
fences, idempotency, refusals and row/advisory locks remain required.

A green diagnostic checkpoint does not establish production safety, stable
framework readiness or historical migration compatibility. A future red
`test-full` or `pgtap` result is a new failure to classify, not debt waived by the
archived inventory below.

## Archived merged checkpoint: twelve SQL obligations

Measurement date: 2026-10-04. [PR #130](https://github.com/openlup/openlup/pull/130) was squash-merged as
`e7f352bd788c6f2557316c3abde5e000772d583d`. Its comparison base was
`c3a6c96c0ce6291a4554d51f9162dc261deed743`; exact-base
[main run 37194320482, attempt 1](https://github.com/openlup/openlup/actions/runs/37194320482)
reported 245 failed Vitest cases in 115 files and 55 failing or aborted SQL files.

Current hosted evidence: [source run 37195393571, attempt 1](https://github.com/openlup/openlup/actions/runs/37195393571),
[merge-group run 37195802928, attempt 1](https://github.com/openlup/openlup/actions/runs/37195802928)
and [merged-main run 37196000352, attempt 1](https://github.com/openlup/openlup/actions/runs/37196000352).
Source and group passed all six mechanical checks and native admission. The main
push passed six mechanical checks; native admission is intentionally skipped on
that event. Local verification of source
`4eaee6cbb158201334714498bdabd8c720e5e1f1` separately passed the required checks
and ran both diagnostics. Local success and hosted success are separate evidence.

Both local and hosted unrestricted `npm test` exit 0: 1,618 passed files,
11,788 passed cases, one skipped file and two skipped cases. The skips are the
existing `catalog policy overlap concurrency` prerequisite case, requiring
`CATALOG_POLICY_CONCURRENCY_DATABASE_URL` and
`CATALOG_POLICY_CONCURRENCY_BUNDLE=managed` or `portable`, and the payment-event
case `proves durable duplicate, ordering, late-success, and cleanup behavior`,
requiring `CP1P_LOCAL_DATABASE=1`.
They remain incomplete evidence outside those profiles; this checkpoint adds no
skip or diagnostic selector exclusion.

Both local and hosted `node scripts/public-ci-pgtap.mjs` exit 1: 205 files,
4,367 emitted assertions, 12 failing or aborted files, 13 failed emitted
assertions and seven incomplete plans leaving 122 planned assertions unexecuted.
All twelve failure identities exist on the comparison base. Red SQL results
remain visible; zero failed Vitest files and a reduction from 55 to 12 SQL files
do not establish complete SQL success. Repairs include current fixture/runtime
composition and idempotent required policy data; retired tests had ended
historical/tooling or unavailable unmounted-view obligations. Existing money,
replay, authorization and concurrency contracts remain in scope.

### Remaining current SQL obligations

The triage owner for every row is OpenLup maintainer. Counts distinguish emitted
assertion failures from missing execution; these are observations at the measured
source, not permitted budgets. No new runtime grants ship in this checkpoint.

| Test file | Emitted/planned; failed | Remaining runtime obligation |
| --- | --- | --- |
| [absorb_lead_test.sql](../../../supabase/tests/absorb_lead_test.sql) | 3/41; 0 | Active-operator lookup denied on `admin_users`; 38 assertions unexecuted. |
| [admin_audit_record_fn_test.sql](../../../supabase/tests/admin_audit_record_fn_test.sql) | 15/22; 7 | Runtime audit RPC execution denied; actor/refusal and durable-write evidence incomplete, seven assertions unexecuted. |
| [admin_client_search_v3_test.sql](../../../supabase/tests/admin_client_search_v3_test.sql) | 0/31; 0 | Runtime search references an unavailable `extensions.%` operator; 31 assertions unexecuted. |
| [admin_membership_authority_test.sql](../../../supabase/tests/admin_membership_authority_test.sql) | 44/49; 0 | Late operator/membership path denied on `admin_users`; five assertions unexecuted. |
| [browser_role_execute_revocation_test.sql](../../../supabase/tests/browser_role_execute_revocation_test.sql) | 6/6; 1 | Missing server capability for `subscription_current_template_snapshot(uuid)`; browser denials remain required. |
| [catalog_authz_closure_test.sql](../../../supabase/tests/catalog_authz_closure_test.sql) | 25/25; 1 | Expected server-only product/SKU projection capability is absent; browser closure remains required. |
| [communication_admin_email_sends_stats_test.sql](../../../supabase/tests/communication_admin_email_sends_stats_test.sql) | 10/10; 1 | Invoker-rights statistics reader denied on `email_sends`. |
| [communication_admin_email_template_slugs_test.sql](../../../supabase/tests/communication_admin_email_template_slugs_test.sql) | 12/12; 1 | Invoker-rights template-slug reader denied on `email_sends`. |
| [inherited_table_privilege_class_test.sql](../../../supabase/tests/inherited_table_privilege_class_test.sql) | 27/27; 2 | Expected event projection and actual service-role time-filter read lack capability. |
| [marketing_lead_email_namespace_test.sql](../../../supabase/tests/marketing_lead_email_namespace_test.sql) | 9/32; 0 | Runtime operation denied on `clients`; 23 assertions unexecuted. |
| [operator_subscription_actions_test.sql](../../../supabase/tests/operator_subscription_actions_test.sql) | 69/71; 0 | Remaining operator path denied on `admin_users`; two assertions unexecuted. |
| [subscription_renewal_due_as_of_test.sql](../../../supabase/tests/subscription_renewal_due_as_of_test.sql) | 13/29; 0 | Due-renewal runtime reader denied on `subscriptions`; 16 assertions unexecuted. |

These are current positive runtime/ACL contracts. Do not replace them with owner
execution, test-only runtime grants, skips or relaxed assertions. The complete
diagnostic goal remains zero failed root and managed SQL assertions; this
checkpoint leaves the named SQL work unresolved. A fresh red run needs exact-base
comparison and explanation of changed failure identities or missing execution.
Naming debt does not excuse an unexplained new failure, broken installation,
database start/replay/cleanup, zero discovery or truncated evidence. Required
checks retain their existing admission role, and diagnostic exits stay raw.

## Archived September measurements

Everything below describes the dated sources named in those measurements, not
the current checkpoint. Preserve their counts and provenance when consulting
history; the current obligations and results are recorded above.

### Archived measurement and provenance

Root measurement completed 2026-09-27 from integrated source commit `59b62deb26d43df1a77a5dbdff256951c588f622`, against trusted main `d0b7e4d9a7ef1653bd0ecaa30d621b6fa72957e7`, with Node 24.20.0 and npm 11.19.0. Unrestricted `npm test` completed on the host with `CI=true` and `TZ=UTC`, exiting 1. The SQL result remains the earlier `node scripts/public-ci-pgtap.mjs` measurement (exit 1, Supabase CLI 2.98.2), from source `0d6cb97265c803c910024e891afe9b3bee4a972e` against base `c705c215955286a97606db7610446b69f5306e74`; it was not rerun for this integrated-source snapshot. The identical-input proof below preserves that result. No diagnostic failure prevents separate required core checks or the independent database job from being selected.

SHA-256 identities of the complete local reports, retained for exact-candidate review:

| Report | SHA-256 |
| --- | --- |
| Host root JSON | `a9b88b3dc09a9043bd86f77ed3f8b7f12b87b32b3df4b65c721e1af9df76fc37` |
| Host root raw log | `55e17766db8206574debfbfb4983df1bcba7544b93082e399083872c4cbe5f4e` |
| Database raw log | `ba01f1b3d09e2a6c57bedcccc644bb693b6522b8f520e901f6ca7a43570440fc` |
| Initial sandbox root JSON | `35566c8be89a3b327b9a7ca846ab517dd79dd071db013e29e4377c094a3e8bfb` |
| Initial sandbox root raw log | `ea5f0cc9fff8af68898182baed15b77c0f0e16c0a717ea20e590fe5c80e4427a` |

The committed mode/blob/path inventory and current working bytes are identical between the earlier SQL source and the integrated source for the 211 executed SQL inputs:

| SQL input identity group | Files | SHA-256 of identical committed inventories |
| --- | --- | --- |
| Executed runner, prerequisite SQL, public CLI config, two managed migrations and all 206 SQL tests | 211 | `e99b47be717c4cab2e905a686b6d2308cd347abddb9bf00682b380edfbe14083` |

The inventory hashes cover exact Git records, including each path, mode and blob identity. The runner imports only Node builtins; its pinned CLI, defaults, replay, assertion grants, formatter workaround and cleanup instructions are unchanged. This proves source-input identity, not a fresh SQL execution on the integrated commit. The separate 78-file ancillary group is not identical: package.json changed to register the native queue selector and revise the required-test command inventory. Its other 77 files, the lockfile, SQL baseline, test SQL, runner and pinned CLI remain unchanged; no complete ancillary-identity claim carries forward.

This document records measured sources, not its own later commit identity. After this evidence-only edit, unchanged execution inputs and final review must bind the final committed candidate. A change to an execution input invalidates its affected measurement. Final prescribed verification reruns both raw diagnostics and inspects their fresh logs before publication. These are local diagnostics, not hosted CI, release, installer or deployment certification.

## Root Vitest

The JSON reports **1,642 file results**, including **118 failed or aborted files** and **35 failed files with no assertion results**. Of **11,390 reported tests**, **11,131 passed**, **251 failed** and **8 were skipped**. Vitest's 3,736 total suites includes nested describe blocks and is not a file count. The host run adds 55 passing tests relative to the preceding main integration; failed-file identities and every row's P/F/S counts are unchanged.

The publication command-contract falsifiers passed **130 tests** and the real-CLI neutrality falsifiers passed **22 tests** in this full run. These results do not convert the unrelated failures below to success.

The initial sandbox run also exited 1: 1,642 files, 120 failed or aborted files, 11,390 tests, 11,128 passing assertions, 254 failures and 8 skips. It added a 10,000 ms large-fixture timeout in scripts/agent-review-queue.test.ts and two null process-identity assertions in the readiness run-cache test. The same unrestricted command on the host passed all 24 queue and 11 cache assertions, without source, timeout or selector changes. The initial result remains separate evidence of that execution limitation; its three failed assertions are not counted as executed successes in that run.

Two measured test files were deleted after this measurement, with the retired consume and split tooling: the readiness run-cache test named above and the split-rehearsal SQL edge test in the table below. Their counts stay in the totals and the table as measured; the row's filename cell names the deleted file by description.

Two more measured files were repaired later. The accounting document lifecycle parity test lost its two cases that read withheld capability metadata and now passes 12 of 12 assertions. The provider endpoint boundary test lost its five exceptions for withheld files and now passes 2 of 2. Their rows are marked (repaired) and keep their counts as measured; the totals stay as measured. No other row changes.

Filename cells display exact shipped file identities; CommonMark character entities keep these data references from manufacturing neutrality findings. Each row gives reported passed/failed/skipped assertions (P/F/S). `0/0/0` means collection aborted before any assertion result. A hook-aborted row with only skips is also incomplete. Failed assertions establish no passing guarantee; historical forward-source reads cannot be replaced with a claim that inspecting the final baseline proves unavailable predecessor transitions.

| Failed or aborted file | P/F/S | Observed reason and incomplete obligation | Follow-up family |
| --- | --- | --- | --- |
| [catalog-document-revision-foundation-real-db-proof.test.ts](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/scripts/catalog-document-revision-foundation-real-db-proof.test.ts) | 0/2/0 | The source-only real-database proof runner fails module resolution before its expected missing-infrastructure refusal. Neither bundle refusal is proved. | Proof transport |
| scripts/checkout-recovery-lifecycle-schema.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; reminder authorization, terminal-row compaction and preserved replay fences remain unproved. | Historical source |
| scripts/customer-diagnostic-history-schema.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; managed/direct grant-only parity, bounded overview/index and lifecycle rates remain unproved. | Historical source |
| scripts/customer-recovery-console-managed-schema.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; authorization before customer reads and immutable replay fingerprints remain unproved. | Historical source |
| [docker-rm-volume-flag.test.ts](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/scripts/docker-rm-volume-flag.test.ts) | 2/1/0 | The tracked shell inventory finds zero invocations against a floor greater than 20. Its repository cleanup coverage remains unproved. | Published inventory |
| [local-env-status.test.ts](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/scripts/local-env-status.test.ts) | 0/3/0 | The withheld status command exits 127 in all three stand-ins instead of zero; its output-redaction and status guarantees are unproved. | Proof transport |
| scripts/oss-reference-prerender.test.ts | 1/1/0 | The negative fixture contains the already-projected route manifest, so execution reaches a missing SSR entry instead of the expected manifest refusal. | Reference composition |
| split-rehearsal SQL edge test (deleted) | 36/3/0 | The test reads unavailable historical forward source rather than the managed baseline; application-cron versus historical guarded scheduler target characterization remain unproved. | Historical source |
| scripts/platform-accounting-document-lifecycle-parity.test.ts (repaired) | 12/2/0 | Two accounting evidence assertions read withheld capability metadata; those documentary parity obligations remain unresolved. | Proof transport |
| scripts/strip-types-entrypoint-specifiers.test.ts | 2/2/0 | Seven published entrypoints miss the source inventory floor greater than 100; a withheld worker-health entrypoint cannot load. | Published inventory |
| scripts/vercel-function-tsconfig-contract.test.ts | 0/1/0 | The reduced rehearsal roots produce five legacy-library diagnostics where the source-tree negative control expects eight. The fixed diagnostic inventory is unresolved. | Published inventory |
| scripts/vite-manual-chunks-guard.test.ts | 1/1/0 | Published Vite dependency entries are undefined rather than the expected single HTML entry. The local BFF discovery assertion fails. | Reference composition |
| api/_cron/outboxHandlerGroupReadiness.test.ts | 9/1/0 | Projected Compose omits the asserted direct-fulfillment activation key; the deployment activation-set obligation remains unresolved. | Runtime composition |
| api/_cron/stagingBridgeInvokerRouteContract.test.ts | 0/0/0 | Collection cannot find the historical scheduler definition. No scheduler-routing assertion executes. | Historical source |
| api/bff/[...path].test.ts | 1/1/0 | The generated public route table has no two asserted direct-only order-review entries. Their pre-auth availability mapping is unproved. | Runtime composition |
| api/c/[slug].test.ts | 3/1/0 | The neutral asset map provides no deployment icon override; the assertion looks for an undefined icon URL. | Reference presentation |
| api/cron/cronGateFlagAuthority.test.ts | 3/1/0 | The renewal cron entrypoint is withheld; its dedicated flag-to-job mapping cannot be read. | Published inventory |
| tests/golden-master/ambientSettlementProfileNode.test.ts | 9/1/0 | The withheld worker directory prevents completion of the reaching-entrypoint initialization inventory. | Published inventory |
| tests/postgres/adminMembershipAuthority.test.ts | 0/0/3 | The test reads unavailable historical forward source rather than the managed baseline; managed backfill, fixture cleanup and full-manifest forward compatibility remain unproved. | Historical source |
| tests/postgres/feedbackMediaAuthority.test.ts | 0/0/3 | The test reads unavailable historical forward source rather than the managed baseline; six predecessor browser controls, production-shaped repair and transactional refusal remain unproved. | Historical source |
| tests/postgres/platformBffMovedRoutes.test.ts | 0/5/0 | All five default route calls return 503 availability refusals instead of the asserted 500 configuration errors. Their managed-runtime error mapping is unresolved. | Runtime composition |
| src/lib/addressCanonBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; provider-neutral address dictionaries, provenance, RLS and read-only grants remain unproved. | Historical source |
| src/lib/adminMagicLinkRateLimitBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; service-only authentication limiter ledger and RPC remain unproved. | Historical source |
| src/lib/adminUsersRlsRecursion.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; active membership, nonrecursive RLS, revoke backfill and direct-DML ACL authority remain unproved. | Historical source |
| src/lib/checkoutResumeBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; hashed draft tokens, sanitized state, hidden grants and expiry/read indexes remain unproved. | Historical source |
| src/lib/commerceFulfillmentIntegrationBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; durable service-only fulfillment, idempotence and handoff consumption once remain unproved. | Historical source |
| src/lib/commerceOmsBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; hidden holds, service-only operations and no payment-result mutation remain unproved. | Historical source |
| src/lib/commerceRuntimeBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; additive pet-aware finalize and disabled/hidden runtime mutations remain unproved. | Historical source |
| [commerceV2MigrationsGuard.test.ts](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/lib/commerceV2MigrationsGuard.test.ts) | 5/1/0 | No historical commerce migration matches the source selector. Five later checks see an empty inventory and do not prove their original RLS/FK/forbidden-column obligations. | Historical source |
| src/lib/communicationProviderSyncBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; provider-delivery persistence, dormant workers and marketing-purpose scope remain unproved. | Historical source |
| src/lib/customerAddressProfilesBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; structured owner-scoped addresses/orderers and anonymous privilege closure remain unproved. | Historical source |
| src/lib/customerAuthRateLimitBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; advisory-locked checkout attempt cleanup and service-only authentication ledger remain unproved. | Historical source |
| src/lib/customerPaymentPreferencesBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; sanitized owner-scoped payment families and anonymous privilege closure remain unproved. | Historical source |
| src/lib/domainSchemaMigration.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; additive domain tables, provider independence, RLS and anonymous grant closure remain unproved. | Historical source |
| src/lib/ecommerceHiddenUiGuardrails.test.ts | 2/1/0 | The legacy application entrypoint is withheld; the customer-visible hidden-surface assertion cannot inspect it. | Published inventory |
| src/lib/ecommerceOrderDraftDbRehearsalCandidate.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; atomic/idempotent draft/outbox writes and rollback-only rehearsal remain unproved. | Historical source |
| [enRouteAliases.test.ts](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/lib/enRouteAliases.test.ts) | 1/2/0 | The neutral route manifest returns null for deployment-specific aliases and redirects. | Reference presentation |
| src/lib/fulfillmentCancelReleaseBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; pre-handoff cancellation releases and after-handoff refusal remain unproved. | Historical source |
| src/lib/fulfillmentNoSplitBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; order-level split refusal before create/label/handoff remain unproved. | Historical source |
| src/lib/fulfillmentProviderGuardBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; provider capability/status/region refusal boundaries remain unproved. | Historical source |
| src/lib/inventoryHiddenBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; service-only control plane, oversell refusal and hidden runtime exposure remain unproved. | Historical source |
| src/lib/inventoryLotInvalidationBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; recalled/expired reservation release and stale-consumption refusal remain unproved. | Historical source |
| src/lib/inventoryPaidReservationHoldBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; durable paid-order stock reservation pinning remain unproved. | Historical source |
| src/lib/o&#109;nipackEvidenceBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; provider evidence persistence without traffic activation or local stock mutation remain unproved. | Historical source |
| src/lib/o&#109;nipackFulfillmentBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; provider attempts and tracking through explicit handoff/consumption boundaries remain unproved. | Historical source |
| src/lib/paymentMethodRefBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; reusable-method authority, active/expiry refusals and idempotent provider references remain unproved. | Historical source |
| src/lib/paymentRecoverySha256Boundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; both single-hash lookup replacements, retained write/idempotency and service-only grants remain unproved. | Historical source |
| src/lib/providerEndpointBoundary.test.ts (repaired) | 1/1/0 | Five retained provider-endpoint exceptions name withheld files; the assertion stops before completing runtime endpoint classification. | Published inventory |
| src/lib/publicRoutes.test.ts | 2/3/0 | The neutral manifest lacks the asserted deployment aliases and permanent redirects. | Reference presentation |
| src/lib/subscriptionDunningBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; durable recovery ledgers, service-only authority and activation/method refusals remain unproved. | Historical source |
| src/lib/subscriptionOfferPolicyPersistenceBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; legacy policy freeze, acquisition sync and immutable cycle policy identity remain unproved. | Historical source |
| src/lib/subscriptionOwnEngineMigration.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; zero-row destructive-transition guard, engine snapshots/retries and audit idempotency remain unproved. | Historical source |
| src/lib/subscriptionOwnEngineRpcBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; atomic cycle/order/payment/outbox/audit creation and duplicate refusal remain unproved. | Historical source |
| src/lib/subscriptionPaymentResultBoundary.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; historical result compatibility, guarded supersession and canonical payment-writer boundary remain unproved. | Historical source |
| src/lib/subscriptionSelfServiceGuardrails.test.ts | 0/2/0 | The test reads unavailable historical forward source rather than the managed baseline; durable address-action wiring and absent unsupported gift action remain unproved. | Historical source |
| [reference-journey-readbacks.test.ts](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/scripts/reference-adapters/reference-journey-readbacks.test.ts) | 0/0/0 | Collection reads a withheld journey-proof source; none of its readback assertions execute. | Proof transport |
| server/bff/communications/preferences.test.ts | 0/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/addresses.test.ts | 0/2/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/billing-profiles.test.ts | 2/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/communication-preferences.test.ts | 1/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/magic-link.test.ts | 3/18/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/me.node-postgres.test.ts | 0/2/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/me.test.ts | 0/6/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/pets.test.ts | 1/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/preferences.test.ts | 0/2/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/profile.test.ts | 1/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/verify-otp.test.ts | 0/2/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/shipping/pickup-point-validation.test.ts | 0/2/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/domains/customers/customerOrderHistorySchemaContract.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; additive persisted shipment-tracking projection remain unproved. | Historical source |
| server/infra/r&#101;send/transactionalEmailRenderers.test.ts | 7/5/0 | Rendered draft/recovery and paid/failed/shipping messages omit asserted pet-name or deployment copy. Presentation compatibility remains unresolved. | Reference presentation |
| server/infra/r&#101;send/transactionalFulfillmentEmailRenderers.test.ts | 2/2/0 | Neutral shipment messages differ from the asserted localized shipment heading and guide content. | Reference presentation |
| server/adapters/r&#101;send/accountingInvoiceDeliveryPort.test.ts | 8/1/0 | The neutral invoice email has no asserted deployment chrome image. Its presentation expectation fails. | Reference presentation |
| server/adapters/scheduler/jobRegistry.test.ts | 4/1/0 | The dormant public job inventory is empty where the test requires at least one job. | Runtime composition |
| server/adapters/vercel/scheduler.test.ts | 8/1/0 | The dormant public job inventory is empty where the scheduler test requires at least one job. | Runtime composition |
| server/adapters/supabase/catalogSkuEnvelope.test.ts | 34/1/0 | The test reads unavailable historical forward source rather than the managed baseline; document-revision archive protection of the SKU envelope remain unproved. | Historical source |
| src/domains/accounting/invoiceContracts.test.ts | 11/1/0 | Neutral seller defaults differ from the asserted deployment seller configuration. | Reference presentation |
| [dbEmailTemplateSeedContent.test.ts](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/domains/communications/dbEmailTemplateSeedContent.test.ts) | 0/1/0 | No retained historical forward contains the asserted delivered/in-transit seed. Seed provenance and content are unproved. | Historical source |
| src/domains/commerce/omsOperationalLadder.test.ts | 0/0/0 | The test reads unavailable historical forward source rather than the managed baseline; queue attention/next-action/rank parity and complete reason ordering remain unproved. | Historical source |
| src/pages/admin/emailTemplateCanonView.test.ts | 2/1/0 | Three template rows survive where canonical filtering expects two. Suppression of the asserted retired row is unresolved. | Runtime behavior |
| src/lib/analytics/routePolicy.test.ts | 15/6/0 | Six deployment-specific routes are absent from the neutral public analytics route policy. | Reference presentation |
| src/lib/brand/appShellAssets.test.ts | 4/1/0 | The neutral shell has zero override entries where the deployment test requires at least one. | Reference presentation |
| src/lib/brand/readBrandConfig.test.ts | 6/3/0 | Neutral seller defaults and sender identity differ from the expected deployment values. | Reference presentation |
| server/bff/admin/communications/packaging-digest-test.test.ts | 8/6/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/admin/communications/send-email.test.ts | 2/3/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/admin/fulfillment/d&#104;l-book-courier.test.ts | 3/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/admin/fulfillment/d&#104;l-cleanup.test.ts | 2/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/admin/fulfillment/d&#104;l-create-shipment.test.ts | 1/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/admin/fulfillment/shipments-overview.test.ts | 0/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/channels/webhooks/simulator.test.ts | 0/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/communications/integrations/events.test.ts | 0/2/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/admin/platform/magic-link.test.ts | 2/23/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/communications/webhooks/noop-newsletter.test.ts | 0/2/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/payment-recovery/setup-method.test.ts | 2/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/customers/payment-recovery/start.test.ts | 0/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/marketing/research/newsletter-consent.test.ts | 0/2/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/marketing/research/survey-responses.test.ts | 0/1/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| server/bff/payment/webhooks/t&#112;aySimulatorIdempotency.test.ts | 1/3/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| [starterOfferCoverage.test.ts](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/tests/preview/checkout/helpers/starterOfferCoverage.test.ts) | 9/3/0 | Three assertions read withheld browser specifications; their original browser coverage mapping remains unproved. | Proof transport |
| src/domains/commerce/emails/returnEmails.test.ts | 2/2/0 | Neutral order-reference prefixes and message copy differ from the asserted presentation. Failed return/shipment output obligations remain unproved. | Reference presentation |
| src/domains/commerce/emails/shipmentDelivered.test.ts | 0/4/0 | Neutral order-reference prefixes and message copy differ from the asserted presentation. Failed return/shipment output obligations remain unproved. | Reference presentation |
| src/domains/commerce/emails/shipmentDispatched.test.ts | 2/4/0 | Neutral order-reference prefixes and message copy differ from the asserted presentation. Failed return/shipment output obligations remain unproved. | Reference presentation |
| src/domains/commerce/emails/shipmentException.test.ts | 1/2/0 | Neutral order-reference prefixes and message copy differ from the asserted presentation. Failed return/shipment output obligations remain unproved. | Reference presentation |
| server/bff/fulfillment/webhooks/o&#109;nipack/_handler.test.ts | 9/7/0 | The default runtime composition does not reach the status, validation, mocked provider or durable-write behavior asserted by these cases. Availability/error mapping versus fixture composition needs repair; failed obligations remain unproved. | Runtime composition |
| [PackageCardHeader.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/checkout/composer/PackageCardHeader.test.tsx) | 1/6/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| [bundleSummaryParts.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/checkout/composer/bundleSummaryParts.test.tsx) | 2/3/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| [ProductDetailsTabs.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/components/product/ProductDetailsTabs.test.tsx) | 0/2/0 | Both cases lack the required storefront SSG detail fixture. Static visible panels and keyboard hydration do not complete. | Reference composition |
| [CheckoutRecoveryMethodPicker.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/pages/account/CheckoutRecoveryMethodPicker.test.tsx) | 13/2/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| src/components/ui/form.test.tsx | 1/1/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| [AuthCallbackPage.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/pages/admin/AuthCallbackPage.test.tsx) | 7/1/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| [BundlesPage.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/pages/admin/BundlesPage.test.tsx) | 0/7/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| [DashboardPage.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/pages/admin/DashboardPage.test.tsx) | 0/7/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| src/components/forms/fields/fields.test.tsx | 0/2/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| src/pages/account/v2/DeliveryHolidayNote.test.tsx | 2/6/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| [AccountOrderStatusTerminal.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/pages/account/v2/order/AccountOrderStatusTerminal.test.tsx) | 4/13/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| [PaymentsSection.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/pages/account/v2/sections/PaymentsSection.test.tsx) | 0/1/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| [ActionRequiredBanner.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/pages/account/v2/start/ActionRequiredBanner.test.tsx) | 3/10/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| [DeliveryTimeline.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/pages/account/v2/subscriptions/DeliveryTimeline.test.tsx) | 1/4/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |
| [SubscriptionScreen.test.tsx](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/src/pages/account/v2/subscriptions/SubscriptionScreen.test.tsx) | 1/16/0 | Expected localized labels, amounts, dates or controls are absent from the rendered test composition, often replaced by translation keys. The affected interaction/state assertions remain unproved. | Reference UI |

### Existing skips

These eight existing skipped assertions remain incomplete evidence; no new skip was added.

| File | Skipped assertions | Unexecuted obligation |
| --- | --- | --- |
| scripts/catalog-policy-overlap-concurrency.test.ts | 1 | Opt-in real-database policy-overlap concurrency proof was not configured. |
| scripts/reference-adapters/paymentEventPortConformance.test.ts | 1 | Opt-in local-database durable duplicate/order/late-success/cleanup proof was not configured. |
| tests/postgres/adminMembershipAuthority.test.ts | 3 | Setup first aborts on missing historical forward source; managed-row backfill, exact fixture cleanup and full-manifest compatibility remain unexecuted. |
| tests/postgres/feedbackMediaAuthority.test.ts | 3 | Setup first aborts on missing historical forward source; six predecessor browser controls, production-shaped repair and transactional refusal remain unexecuted. |

## Managed SQL diagnostics

The runner reports transactional baseline/ordered-forward replay before invoking every shipped SQL file. TAP reports **206 files**, **3,593 emitted assertions**, **55 failed or aborted files** and **110 failed emitted assertions**. **34 files have incomplete plans**. A missing TAP assertion is not counted as an executed failure or passing proof. The final CLI container exit message follows the completed `Result: FAIL` summary and represents the raw test failure; it is not itself evidence of a start or replay failure. Owned cleanup completed without a reported error; readback confirmed the owned disposable container was absent.

The next table distinguishes emitted/planned assertions and emitted failures. A numeric plan was read from TAP; for the two files that abort before announcing a plan, the intended plan is read from the unchanged SQL source and marked `source`. All later assertions after an abort remain unexecuted, including the guarantees named in the obligation column.

| Failed or aborted SQL file | Emitted / planned; failed | Observed reason | Incomplete or failed obligation | Follow-up family |
| --- | --- | --- | --- | --- |
| supabase/tests/absorb_lead_test.sql | 41 / 41; 21 failed | Unclassified client-reference tables refuse absorption, so transfer, consent collision, archival and idempotent receipt assertions fail. | Lead absorption policy completeness. | Runtime/policy |
| supabase/tests/admin_audit_record_fn_test.sql | 15 / 22; 7 failed | Runtime execution of the audit primitive is denied; subsequent actor/write assertions fail and replay aborts. | 7 planned assertions unexecuted; Actor-derived audit, idempotent replay and direct-write refusal. | ACL/runtime |
| supabase/tests/admin_client_search_v3_test.sql | 0 / 31; 0 failed | The runtime search function invokes a trigram operator missing from its declared schema. | 31 planned assertions unexecuted; Search normalization, ranking and bounded paging. | Database runtime |
| supabase/tests/admin_membership_authority_test.sql | 12 / 47; 1 failed | Runtime fixture creation is denied, followed by an audit-actor FK abort; membership authority obligations do not complete. | 35 planned assertions unexecuted; Membership backfill, service fixture authority and revoke compatibility. | ACL/runtime |
| supabase/tests/anon_write_privilege_revoke_test.sql | 25 / 25; 5 failed | Retained runtime/signed-in DML grants and policy assertions differ; runtime tester INSERT is denied. | Positive compatibility grants and actual role-taking DML. | ACL compatibility |
| supabase/tests/browser_role_execute_revocation_test.sql | 6 / 6; 1 failed | The runtime role lacks asserted execution on the pinned routine set. | Retained runtime execution while browser execution is closed. | ACL compatibility |
| supabase/tests/canonical_order_money_test.sql | 35 / 79; 0 failed | Fixture reaches a currency/region resolver without declaring its required settlement settings. | 44 planned assertions unexecuted; Canonical allocation, persistence and writer invariants. | Fixture/profile |
| supabase/tests/catalog_authz_closure_test.sql | 25 / 25; 3 failed | Observed catalog grantees, runtime privilege width and fenced RPC execution differ from retained compatibility assertions. | Exact grant set and usable server reads/writes. | ACL compatibility |
| [catalog_document_seam_grants_test.sql](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/supabase/tests/catalog_document_seam_grants_test.sql) | 3 / 5; 3 failed | Required proposal/publication objects are absent; seam resolution/read assertions fail or setup aborts. | 2 planned assertions unexecuted; Document seam reads, proposal execution and closed publication ledgers. | Catalog compatibility |
| supabase/tests/catalog_draft_foundation_test.sql | 0 / 35; 0 failed | Required proposal/publication objects are absent; seam resolution/read assertions fail or setup aborts. | 35 planned assertions unexecuted; Isolated draft persistence and lifecycle. | Catalog compatibility |
| supabase/tests/catalog_legacy_mutation_fence_test.sql | 17 / 17; 2 failed | Fenced signatures/ACLs and retained proposal/publication writer assertions differ. | Legacy mutation fence and unfenced supported writers. | Catalog compatibility |
| supabase/tests/channel_order_reaches_the_dispatch_gate_test.sql | 2 / 12; 0 failed | Fixture uses provider identity or stock rows absent from the empty baseline; lookup/FK refusal aborts the file. | 10 planned assertions unexecuted; Marketplace dispatch and provider stock gate. | Fixture/inventory |
| supabase/tests/checkout_order_currency_invariant_test.sql | 0 / 22; 0 failed | Fixture reaches a currency/region resolver without declaring its required settlement settings. | 22 planned assertions unexecuted; Both canonical currency writer invariants. | Fixture/profile |
| supabase/tests/commerce_returns_outbox_test.sql | 6 / 6; 1 failed | The asserted dormant return producer is not registered. | Dormant producer registration. | Control inventory |
| supabase/tests/commerce_settings_offer_layout_test.sql | 10 / 10; 4 failed | Expected offer-layout seed/default and closed-vocabulary/text-lane checks fail. | Offer configuration defaults and invalid-setting refusal. | Settings/profile |
| supabase/tests/commerce_settings_settlement_profile_test.sql | 4 / 17; 4 failed | Fixture reaches a currency/region resolver without declaring its required settlement settings. | 13 planned assertions unexecuted; Well-formed explicit settlement and missing/invalid-setting refusals. | Fixture/profile |
| supabase/tests/communication_admin_email_sends_stats_test.sql | 10 / 10; 1 failed | Invoker-rights read fails under the runtime role. | Usable runtime email statistics read. | ACL/runtime |
| supabase/tests/communication_admin_email_template_slugs_test.sql | 12 / 12; 1 failed | Invoker-rights read fails under the runtime role. | Usable runtime template-slug read. | ACL/runtime |
| supabase/tests/customer_diagnostic_history_test.sql | 115 / 115; 1 failed | The overview query does not use its asserted index when sequential scanning is disabled. | Diagnostic overview query-plan boundary. | Database performance |
| supabase/tests/delivery_contact_inference_parity_test.sql | 0 / 17; 0 failed | Fixture supplies no required inventory location; a NOT NULL refusal aborts setup. | 17 planned assertions unexecuted; Consistent paid-parcel delivery-contact inference. | Fixture/inventory |
| supabase/tests/external_cron_guard_stable_identity_test.sql | 18 / 18; 7 failed | Configured deployment/runtime readback and producer-control seed assertions differ; the versioned call is refused by the clone guard. | Deployment fingerprint, dormant control and transaction-local identity. | Deployment profile/control |
| supabase/tests/feedback_media_confirm_upload_test.sql | 15 / 20; 0 failed | A real runtime table operation is denied by effective ACLs; this is an authority/runtime compatibility failure, not a missing pgTAP grant. | 5 planned assertions unexecuted; Undelivered media refusal, no-write readback and supported removal. | ACL/runtime |
| supabase/tests/fulfillment_cancel_provider_dispatch_guard_test.sql | 0 / 25; 0 failed | Fixture uses provider identity or stock rows absent from the empty baseline; lookup/FK refusal aborts the file. | 25 planned assertions unexecuted; Provider-held cancellation refusal and reservation release. | Fixture/inventory |
| supabase/tests/fulfillment_provider_delivery_chronology_test.sql | 22 / 29; 0 failed | Fixture uses provider identity or stock rows absent from the empty baseline; lookup/FK refusal aborts the file. | 7 planned assertions unexecuted; Provider occurrence chronology and delivered-at readback. | Fixture/inventory |
| supabase/tests/fulfillment_replacement_sequence_test.sql | 15 / 27; 0 failed | Fixture uses provider identity or stock rows absent from the empty baseline; lookup/FK refusal aborts the file. | 12 planned assertions unexecuted; Consistent replacement selection across reads. | Fixture/inventory |
| supabase/tests/inherited_table_privilege_class_test.sql | 23 / 23; 2 failed | Retained event-ledger runtime append/read and the asserted residual wide default differ from effective ACLs. | Positive compatibility grants and measured residual-default boundary. | ACL compatibility |
| supabase/tests/inventory_recount_reserved_balances_test.sql | 25 / 25; 1 failed | The asserted production-shaped fingerprint does not refuse the dry run. | Production refusal must be re-proved with an explicit valid profile. | Deployment refusal |
| supabase/tests/inventory_reservation_replay_characterization_test.sql | 0 / 10; 0 failed | Fixture reaches a currency/region resolver without declaring its required settlement settings. | 10 planned assertions unexecuted; As-written historical multi-lot replay characterization. | Fixture/profile |
| supabase/tests/marketing_lead_email_namespace_test.sql | 32 / 32; 11 failed | Rehoming is refused, so contact/source-link/idempotence and released-email assertions fail. | Namespace classification and preserved customer/marketing identity. | Runtime/policy |
| supabase/tests/no_cron_inventory_reservation_leases_test.sql | 0 / 6; 0 failed | Fixture supplies no required inventory location; a NOT NULL refusal aborts setup. | 6 planned assertions unexecuted; Reservation lease behavior without a sweep cron. | Fixture/inventory |
| supabase/tests/offer_gate_admin_repricing_profile_test.sql | 0 / 19; 0 failed | Fixture reaches a currency/region resolver without declaring its required settlement settings. | 19 planned assertions unexecuted; Legacy repricer fence and explicit settlement/readiness proof. | Fixture/profile |
| supabase/tests/offer_policy_v2_readiness_test.sql | 0 / 54 (source; no TAP plan); 0 failed | Fixture references an undeclared format registry identity; the catalog FK refuses before completion. | 54 planned assertions unexecuted; Assignment readiness and legacy-money refusal boundaries. | Fixture/catalog |
| supabase/tests/o&#109;nipack_dispatch_convergence_test.sql | 0 / 132; 0 failed | Fixture uses provider identity or stock rows absent from the empty baseline; lookup/FK refusal aborts the file. | 132 planned assertions unexecuted; Dispatch submission fence and atomic acknowledgement. | Fixture/inventory |
| supabase/tests/o&#109;nipack_stock_authority_test.sql | 0 / 17; 0 failed | Fixture supplies no required inventory location; a NOT NULL refusal aborts setup. | 17 planned assertions unexecuted; External stock-master reservation lifecycle. | Fixture/inventory |
| supabase/tests/oms_legacy_delivery_contact_correction_test.sql | 0 / 43; 0 failed | Fixture uses provider identity or stock rows absent from the empty baseline; lookup/FK refusal aborts the file. | 43 planned assertions unexecuted; Historical delivery-contact correction and pre-dispatch preparation. | Fixture/inventory |
| supabase/tests/operator_subscription_actions_test.sql | 69 / 71; 0 failed | A real runtime table operation is denied by effective ACLs; this is an authority/runtime compatibility failure, not a missing pgTAP grant. | 2 planned assertions unexecuted; Operator command parity and emergency email correction. | ACL/runtime |
| supabase/tests/order_draft_client_id_test.sql | 0 / 10; 0 failed | Fixture reaches a currency/region resolver without declaring its required settlement settings. | 10 planned assertions unexecuted; Draft producer customer identity and recipient resolution. | Fixture/profile |
| supabase/tests/order_draft_supersede_pre_payment_test.sql | 0 / 28; 0 failed | Fixture reaches a currency/region resolver without declaring its required settlement settings. | 28 planned assertions unexecuted; Stable-journey supersede and settled-order refusal. | Fixture/profile |
| supabase/tests/outbox_dispatch_rpcs_test.sql | 131 / 131; 7 failed | Dormant/activated control rows and drivers are absent or differ, so disabled, enabled and wrong-driver claims fail. | Closed defaults, activation and driver claim/refusal. | Control inventory |
| supabase/tests/payment_recovery_sha256_test.sql | 21 / 39; 0 failed | Fixture uses provider identity or stock rows absent from the empty baseline; lookup/FK refusal aborts the file. | 18 planned assertions unexecuted; Recovery token hashing, consumption and replay. | Fixture/inventory |
| supabase/tests/platform_job_control_v3_test.sql | 5 / 25; 5 failed | Required accounting trigger-control rows are absent; initial control assertions fail before command cases. | 20 planned assertions unexecuted; Accounting worker/scheduler trigger controls and refusal. | Control inventory |
| [production_marketing_lead_writer_fence_test.sql](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/supabase/tests/production_marketing_lead_writer_fence_test.sql) | 0 / 18 (source; no TAP plan); 0 failed | The historical proof assumes a deployment migration-history relation unavailable in the baseline replay profile. | 18 planned assertions unexecuted; Historical writer-fence concurrent race and rollback. | Historical proof transport |
| supabase/tests/promotion_checkout_canonical_money_test.sql | 4 / 54; 0 failed | Fixture reaches a currency/region resolver without declaring its required settlement settings. | 50 planned assertions unexecuted; Promotion claims within canonical money transaction. | Fixture/profile |
| supabase/tests/promotion_checkout_claim_concurrency_test.sql | 5 / 5; 5 failed | Both concurrent canonical writes encounter an unconfigured settlement currency before the expected capacity result. | Capacity lock, single winner and loser graph rollback. | Fixture/profile |
| supabase/tests/promotion_code_claim_events_test.sql | 74 / 74; 3 failed | Production-shaped refusal assertions fail; runtime order INSERT cannot maintain the promotion health index. | Production refusal and actual role-taking order/index write. | ACL/profile |
| supabase/tests/promotion_codes_control_plane_test.sql | 5 / 102; 5 failed | Fixture reaches a currency/region resolver without declaring its required settlement settings. | 97 planned assertions unexecuted; Admin idempotence, claims and bridge/backfill compatibility. | Fixture/profile |
| supabase/tests/replacement_shipment_command_test.sql | 0 / 54; 0 failed | The reservation fixture has insufficient available stock; setup aborts before the command assertions. | 54 planned assertions unexecuted; Replacement command hold/refusal and atomic lineage. | Fixture/inventory |
| [seed_commerce_v2_idempotence_test.sql](https://github.com/openlup/openlup/blob/5a851a6db5483fe1c754445ab837429f108dfd75/supabase/tests/seed_commerce_v2_idempotence_test.sql) | 4 / 4; 2 failed | Expected custom prices read NULL: source seed-include markers are not expanded by this baseline runner. | Seed replay must preserve direct/fallback custom prices. | Seed proof transport |
| supabase/tests/subscription_cycle_fulfillment_inputs_test.sql | 0 / 5; 0 failed | Fixture uses provider identity or stock rows absent from the empty baseline; lookup/FK refusal aborts the file. | 5 planned assertions unexecuted; Renewal fulfillment inputs and prepayment reservation. | Fixture/inventory |
| supabase/tests/subscription_cycle_reservation_preflight_test.sql | 0 / 10; 0 failed | Fixture uses provider identity or stock rows absent from the empty baseline; lookup/FK refusal aborts the file. | 10 planned assertions unexecuted; Fail-closed reservation before provider charge. | Fixture/inventory |
| supabase/tests/subscription_dunning_dispatch_test.sql | 40 / 40; 4 failed | Expected individually controllable recovered/at-risk notification rows are not seeded as asserted. | Customer-message control registration/default activation. | Control inventory |
| supabase/tests/subscription_payment_method_lifecycle_due_visibility_test.sql | 34 / 34; 1 failed | Effective execution differs from the retained service-role-only replacement assertion. | Runtime method-lifecycle execution compatibility. | ACL compatibility |
| supabase/tests/subscription_quote_drift_observation_time_test.sql | 20 / 20; 2 failed | Effective browser/runtime execution differs for the quote and line helper identities. | Observed execution compatibility without silent ACL drift. | ACL compatibility |
| supabase/tests/subscription_renewal_due_as_of_test.sql | 13 / 29; 0 failed | A real runtime table operation is denied by effective ACLs; this is an authority/runtime compatibility failure, not a missing pgTAP grant. | 16 planned assertions unexecuted; Deterministic/default-now due-renewal selection under runtime role. | ACL/runtime |
| supabase/tests/subscription_starter_cycle_order_discount_test.sql | 0 / 9; 0 failed | Fixture references an undeclared format registry identity; the catalog FK refuses before completion. | 9 planned assertions unexecuted; Discounted cycle-order canonical money and byte-identical replay. | Fixture/catalog |

## Admission and follow-up

These archived failures were raw red in their dated `test-full` and `pgtap` measurements; they are not the current failure inventory. See the current checkpoint above. Required-main coverage, lint and neutrality stay blocking; this record does not modify rulesets or the release workflows' six-context selection. Observation does not establish stable framework readiness, production safety, historical migration compatibility or successful installation.

A failed dependency install, unavailable new command, zero diagnostic discovery, migration inventory refusal, database start/replay/owned-cleanup error, truncated report or unexplained new failure blocks delivery until diagnosed. The reports above reach their test summaries and name assertion/setup debt; they do not authorize expanding this CI change into platform repairs. Fresh verification compares exact-source results with the current checkpoint and the exact change base; the archived inventory is historical context.

See the [bounded implementation plan](public-ci-completeness.md) and [contribution checks](../../../CONTRIBUTING.md#development-preview-checks).
