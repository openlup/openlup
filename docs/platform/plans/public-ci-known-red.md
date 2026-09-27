# Remaining public CI obligations

Status: diagnostic record, not a test waiver. All listed tests still run and retain raw failing exits.

Decision owner: OpenLup maintainer. Repair owner: CI completeness contributors. These roles identify routing; this record does not claim that the maintainer accepted a failure budget.

## Managed pgTAP snapshot

Measured against candidate `5f4094b73486371c872ededfb545b54cad6a5353` and public main `03dbbedc953b96607f1ef1fc3342847cf49aa16e`: 206 files executed, 23 red files. This is a historical diagnostic snapshot. Subsequent repairs bind the runner to committed migration bytes and restore pre-fixture installation assertions. The subsequent local run against public main `deb03a7f109775eeced947482bf584d0868e63d7` executed the same 206 files and 4,325 assertions, exiting 1 with 28 red files. The five additional files are the restored pre-fixture obligations listed below; their configured behaviour checks completed. This remains diagnostic execution, not final mandatory acceptance.

| Named test | Observed failure / unresolved obligation |
| --- | --- |
| `supabase/tests/admin_audit_record_fn_test.sql` | permission denied for function record_admin_audit_event |
| `supabase/tests/admin_client_search_v3_test.sql` | operator does not exist: text extensions.% text |
| `supabase/tests/admin_membership_authority_test.sql` | insert or update on table "admin_audit_events" violates foreign key constraint "admin_audit_events_actor_admin_id_fkey" |
| `supabase/tests/anon_write_privilege_revoke_test.sql` | Assertion 8: "the service role retains INSERT, UPDATE, and DELETE on all three retired intake records" |
| `supabase/tests/browser_role_execute_revocation_test.sql` | Assertion 4: "service_role retains execute on every pinned function" |
| `supabase/tests/catalog_authz_closure_test.sql` | Assertion 8: "exactly the four expected roles hold anything on the closed tables and exactly three on the inert ones, so no unenumerated grantee appeared" |
| `supabase/tests/catalog_document_seam_grants_test.sql` | function "public.catalog_submit_change_proposal(text,text)" does not exist |
| `supabase/tests/catalog_draft_foundation_test.sql` | relation "public.catalog_publication_events" does not exist |
| `supabase/tests/catalog_legacy_mutation_fence_test.sql` | Assertion 15: "all eight fenced functions retain exact signatures/defaults, definer/search-path and service-role-only execute ACLs" |
| `supabase/tests/commerce_returns_outbox_test.sql` | Assertion 6: "commerce.return. producer is registered dormant" |
| `supabase/tests/communication_admin_email_sends_stats_test.sql` | Assertion 5: "service_role can execute the invoker-rights read against the native schema" |
| `supabase/tests/communication_admin_email_template_slugs_test.sql` | Assertion 5: "service_role can execute the invoker-rights read against the native schema" |
| `supabase/tests/customer_diagnostic_history_test.sql` | Assertion 95: "the overview window read plans through its own index when a sequential scan is disabled" |
| `supabase/tests/feedback_media_confirm_upload_test.sql` | permission denied for table feedback |
| `supabase/tests/inherited_table_privilege_class_test.sql` | Assertion 9: "the runtime role still reads and appends to the subscription event ledger, which this wave leaves alone" |
| `supabase/tests/offer_gate_admin_repricing_profile_test.sql` | Assertion 1: "service_role may execute the two fenced identities and the two live profile readers" |
| `supabase/tests/operator_subscription_actions_test.sql` | permission denied for table admin_users |
| `supabase/tests/production_marketing_lead_writer_fence_test.sql` | relation "supabase_migrations.schema_migrations" does not exist |
| `supabase/tests/promotion_code_claim_events_test.sql` | Assertion 46: "service-role order insert can maintain the promotion v2 health index" |
| `supabase/tests/seed_commerce_v2_idempotence_test.sql` | Assertion 1: "direct current selection preserves the custom price" |
| `supabase/tests/subscription_payment_method_lifecycle_due_visibility_test.sql` | Assertion 28: "W3.5: replacing the function in place kept its service-role-only execution" |
| `supabase/tests/subscription_quote_drift_observation_time_test.sql` | Assertion 19: "effective ACLs retain the inherited browser and service-role execution without migration ACL churn" |
| `supabase/tests/subscription_renewal_due_as_of_test.sql` | permission denied for table subscriptions |

## Restored pre-fixture installation obligations

These assertions now run before synthetic configuration is inserted, including absorption classification coverage. They retain the original installation expectations as unresolved obligations; their fixed values do not silently become universal adopter defaults. Decision owner and repair owner are the roles stated above. No schema or permissions are changed by this restoration.

| Named test | Obligation retained before fixtures |
| --- | --- |
| `supabase/tests/absorb_lead_test.sql` | Every public clients foreign key is classified by the shipped installation before synthetic classification; missing policy seed is an unresolved operational prerequisite. |
| `supabase/tests/commerce_settings_offer_layout_test.sql` | Historical `starter_first` seed and its value lane; merchandising selection requires an explicit disposition. |
| `supabase/tests/commerce_settings_settlement_profile_test.sql` | Required configured settlement rows and shapes; bare schema and selected reference readiness remain distinct. |
| `supabase/tests/outbox_dispatch_rpcs_test.sql` | Dormant producer registry and disabled prune control; enabled dispatch/driver expectation is separate deployment activation. |
| `supabase/tests/platform_job_control_v3_test.sql` | Accounting trigger allowlists and disabled KSeF control before behaviour setup; no implicit lane activation. |
| `supabase/tests/subscription_dunning_dispatch_test.sql` | Actual operator kill-switch rows and historical enabled expectations; missing rows must not be masked by fixture insertion. |

## Root test dispositions

Earlier local root execution after rebase onto `e2190c851c309ba0a08d9e44bd7b1824a36b9c03` ran 11,213 passing assertions, 58 failing assertions and 8 existing conditional pending assertions, with 29 failing files. The exit was 1. The controller tests merged in PR #50 are included by unrestricted discovery. This is pre-publication evidence; final mandatory verification remains required.

Current structural mapping preserves separate missing-history failures. These named files remain executed, with the owner routing above:

| Named test | Failed obligation summaries / collection failure | Contract disposition |
| --- | --- | --- |
| `api/_cron/outboxHandlerGroupReadiness.test.ts` | outbox handler group readiness > forwards the complete direct fulfillment activation set in stock Compose | Published Compose lacks the promised direct-fulfillment composition root. |
| `api/_cron/stagingBridgeInvokerRouteContract.test.ts` | Suite collection failed; preserve all unexecuted obligations | Shipped SQL scheduler invoker producers are absent. |
| `api/bff/[...path].test.ts` | api/bff/[...path] — routing aggregator > marks both direct-only order-review admin routes for pre-auth availability refusal | Public profile omits the two order-review routes; pre-auth refusal ordering is unproved. |
| `api/cron/cronGateFlagAuthority.test.ts` | cron gate flag matches its jobCatalog requiresFlag (anti-drift) > the subscription renewal cron is gated by the dedicated renewal-runtime flag | Dedicated subscription-renewal cron entrypoint and its flag contract are absent. |
| `scripts/catalog-document-revision-foundation-real-db-proof.test.ts` | catalog document revision real-DB proof runner > fails closed for missing managed replay infrastructure; catalog document revision real-DB proof runner > fails closed for missing portable replay infrastructure | Promised public replay runner is absent; loader failure does not prove infrastructure refusal. |
| `scripts/customer-diagnostic-history-schema.test.ts` | customer diagnostic history database contract > keeps SQL behavior identical with only the runtime-specific service-role grants differing; customer diagnostic history database contract > keeps overview behavior identical with only the managed execution grant differing; customer diagnostic history database contract > installs the bounded overview access and index without validating historical rows; customer diagnostic history database contract > states this migration's own delta without claiming a covering index; customer diagnostic history database contract > retains the historical overview browser-revocation declaration; customer diagnostic history database contract > backfills and defaults retained v1 coverage before accepting v2 rows; customer diagnostic history database contract > retains the historical v2 browser-revocation declarations; customer diagnostic history database contract > replaces the reported-reference CHECK without validating retained history; customer diagnostic history database contract > ships the ingress identity pair with parity, bounded timeouts and a catalogued digest; customer diagnostic history database contract > seeds the retention control row disabled on both chains and diverges only where the schemas do; customer diagnostic history database contract > states the retention control delta in a header written for each chain; customer diagnostic history database contract > states the ingress identity delta in a header written for this replay | Current bodies are tested; historical parity, bounded installation, mixed-history and browser-revocation declarations remain missing. |
| `scripts/local-env-status.test.ts` | local environment status credential boundary > discards CLI stdout and stderr with exit 0; local environment status credential boundary > discards CLI stdout and stderr with exit 1; local environment status credential boundary > discards CLI stdout and stderr with exit null | Shipped credential-suppressing status-summary executable is absent. |
| `scripts/oss-split-rehearsal-sql-edge.test.ts` | checked-in scheduler routing characterization > recognizes the #3303 application-cron guard shape and adds no Edge pairs; checked-in scheduler routing characterization > still records the legacy guarded /functions/v1 scheduler as an Edge pair; checked-in scheduler routing characterization > proves the checked-column helper path to the existing send-email Edge call | Checked-in historical scheduler producers are absent; parser fixtures do not prove shipped routing. |
| `scripts/platform-accounting-document-lifecycle-parity.test.ts` | the deferred counter move > leaves no capability cell citing this harness; the deferred counter move > leaves the four decision numbers this wave recorded unconsumed | Referenced coverage matrix for deferred decisions is absent. |
| `scripts/reference-adapters/reference-journey-readbacks.test.ts` | reference journey readback transport > calls the neutral reference-journey routes for all four authenticated list/detail readbacks; reference journey readback transport > keeps every negative control on the same neutral routes; reference journey readback transport > does not reach for the product routes the seam moved off | Public ordered-readback transport is absent; handler unit tests are not equivalent. |
| `src/domains/communications/dbEmailTemplateSeedContent.test.ts` | tester template seed content > the canonical delivered/in-transit seed uses the 7-10 day food-transition window | Canonical delivery/in-transit template seeds are absent. |
| `src/lib/addressCanonBoundary.test.ts` | published address canon boundary > retains the unresolved historical PNA licensing prerequisite | Absent historical disabled PNA seed/licensing note; vocabulary alone does not prove activation safety. |
| `src/lib/adminUsersRlsRecursion.test.ts` | admin_users RLS recursion fix > retains the historical helper-definition and execution-grant witness; admin_users RLS recursion fix > backfills before active-only authorization and exposes one authenticated revoke command; admin_users RLS recursion fix > retains the historical direct-membership DML ACL and non-authority-setting declarations | Historical helper, ordered backfill and direct-DML ACL declarations are absent; current body/policy witnesses pass. |
| `src/lib/commerceFulfillmentIntegrationBoundary.test.ts` | commerce fulfillment integration boundary > rehearses create, idempotency, label-without-consume, and handoff consume-once | Rollback-only fulfillment replay/consume-once probe is absent. |
| `src/lib/commerceOmsBoundary.test.ts` | published commerce OMS structural boundary > declares hold RPC service-role access and rehearses payment-control non-mutation; published commerce OMS structural boundary > hardens admin OMS preview address correction behind a service-role RPC; published commerce OMS structural boundary > documents a rollback-only probe for Admin OMS queue pagination beyond 500 | Missing probes/docs and differing current address-lock declarations need equivalent evidence or a contract decision. |
| `src/lib/commerceV2MigrationsGuard.test.ts` | commerce-v2 migration guardrails > locates at least one commerce-v2 migration | Historical commerce-v2 migration family is absent; an empty guard scan must fail. |
| `src/lib/communicationProviderSyncBoundary.test.ts` | communication provider sync boundary > keeps sync workers disabled by default through platform job controls | Disabled-by-default provider synchronization control seed is absent. |
| `src/lib/domainSchemaMigration.test.ts` | Suite collection failed; preserve all unexecuted obligations | Required historical additive/domain migration source is absent. |
| `src/lib/ecommerceOrderDraftDbRehearsalCandidate.test.ts` | ecommerce order draft DB rehearsal candidate > declares the outbox table and current RPC without public grants; ecommerce order draft DB rehearsal candidate > ships a rollback-only probe for rehearsal target verification; ecommerce order draft DB rehearsal candidate > records the local rehearsal result and later production apply boundary | Current outbox policy declaration differs; historical rehearsal probe and apply report are absent. |
| `src/lib/inventoryHiddenBoundary.test.ts` | inventory hidden boundary > guards against oversell and public RPC exposure in the SQL probe | Oversell/public-RPC-refusal rehearsal probe is absent. |
| `src/lib/omnipackEvidenceBoundary.test.ts` | provider evidence model boundary > creates durable provider evidence tables and service-role RPCs only; provider evidence model boundary > seeds the adapter as a fulfillment provider and does not activate provider traffic; provider evidence model boundary > has a rollback-only probe covering replay, no tracking fork, and no inventory consumption; provider evidence model boundary > documents the evidence model and lists the rehearsal probe | Explicit ACL declarations differ; provider seed, rollback-only evidence probe and documentation are absent. |
| `src/lib/omnipackFulfillmentBoundary.test.ts` | hidden provider fulfillment boundary > keeps provider credentials on Basic Auth and blocks stage/live without merchant inputs | Required provider integration configuration documentation is absent. |
| `src/lib/subscriptionOfferPolicyPersistenceBoundary.test.ts` | subscription offer-policy persistence boundary > freezes legacy rows and syncs only the post-migration acquisition seam | Legacy-row freeze/backfill transition proof is absent. |
| `src/lib/subscriptionOwnEngineMigration.test.ts` | subscription own-engine migration > has a zero-row guard before dropping provider-owned subscription structures; subscription own-engine migration > removes provider cycle ownership from cycles and commerce orders | Zero-row/destructive provider-ownership transition proof is absent. |
| `src/lib/subscriptionOwnEngineRpcBoundary.test.ts` | subscription own-engine RPC boundary > retains cycle-order service-role-only ACL declarations (text witness only); subscription own-engine RPC boundary > keeps the rehearsal probe focused on replay, conflict, atomic rollback and public-role denial | Explicit browser revocation declaration and replay/atomic-refusal probe are absent. |
| `src/lib/subscriptionPaymentResultBoundary.test.ts` | subscription payment result boundary > keeps historical service-role-only payment result RPC symbols; subscription payment result boundary > proves legacy payment-result RPCs fail fast locally | Historical browser ACL declaration and fail-fast nonmutation probe are absent. |
| `src/lib/subscriptionSelfServiceGuardrails.test.ts` | subscription self-service guardrails > keeps durable shipping-address action wired through contract, SQL, UI, smoke, and docs | Shipping-action smoke/docs proof chain is absent; current delegation chain is tested. |
| `tests/postgres/adminMembershipAuthority.test.ts` | Suite collection failed; preserve all unexecuted obligations | Missing historical forwards prevent ordered-backfill/cleanup/ACL transition proof. |
| `tests/postgres/feedbackMediaAuthority.test.ts` | Suite collection failed; preserve all unexecuted obligations | Missing historical forward and append contract prevent predecessor/overload/atomic rollback proof. |
| `tests/preview/checkout/helpers/starterOfferCoverage.test.ts` | The preview journey and both payment-provider journeys must embed the starter-offer marker in their skip reasons | The three checkout specs required to carry starter-offer evidence markers are absent. |

The npm cache and own-process identity environment failures were resolved by a worktree-local cache and permitted own-process readback. No application grant or test exit changed.

The root rerun after integrating PR #52 passed 11,262 assertions and failed the same 58 assertions across 29 files, with 8 existing conditional pending assertions. The committed-inventory refusal suite then passed 42 assertions, including duplicate versions, missing/modified/untracked files, symlinks and mode changes. These bounded checks do not waive full verification.

The subsequent absorption restoration is an additional unresolved bare-install assertion; the preceding 28-file pgTAP measurement predates it. `src/lib/addressCanonBoundary.test.ts` additionally retains the absent historical PNA disabled-seed/licensing-note expectation with raw failure semantics. Its schema-vocabulary checks do not prove licensed-source activation safety; this file is an additional named root blocker beyond the preceding 29-file measurement. No licensed data or synthetic migration history is supplied.

## Routing

Select the managed installation authority before adding effective access proofs or changing reference setup. Prepare narrow email-read, trigram, audit and catalogue contracts separately. Existing-history uncertainty refuses automatic upgrade. Broad grants, copied historical files, test exclusions and silent release-admission changes are outside this plan.

See the [approved implementation plan](public-ci-completeness.md) and [managed installation contract](managed-installation-proof-contract.md).

## Exact-candidate repair baseline

Candidate `ec27b969dab3cc2301dc2c2a1e09de6a73f5c650`, based on `deb03a7f109775eeced947482bf584d0868e63d7`, failed unrestricted root execution: 11,270 passed, 59 failed assertions, eight existing conditional skips, 30 failing files including four collection failures. Managed pgTAP executed 206 files and 4,325 assertions with 29 red files. These are the baseline for the next repairs, superseding earlier counts for current routing.

The managed classification covers all 29 files: thirteen effective-authority/ACL files; two email reads; one internal audit conflict; one trigram namespace mismatch; five native prerequisite/control seeds; two selected configuration files; two missing catalogue-capability files; one historical writer fence; one seed-idempotence file; and one diagnostic-query proof. Membership, search and catalogue abort before their full TAP plans: executing a file does not establish complete coverage. Acceptance requires every mapped assertion to complete with no early SQL abort or missing/bad plan.

Repair authorization selects repairs before publication, without changing the separate schema, capability, activation or installed-tool holds. Tool status and ordered readback transport are bounded proof repairs. The diagnostic index witness must exercise the shipped query and representative rows with normal planner settings; no schema change is justified by the old tiny-fixture plan failure. All other named obligations retain raw failing exits until equivalent behavior or a separately accepted contract is implemented.

### First bounded repair results

The status tool and ordered neutral transport pass focused executable checks. Their proofs retain missing configuration, reflected credential canaries and same-route anonymous/cross-user refusals; synthetic handler ports do not establish live authorization. Current fulfillment-adapter documentation replaces absent historical indexes, with native defaults still disabled and database replay obligations kept visible. The table above summarizes assertion obligations; raw failure labels remain in execution logs.

The repaired diagnostic SQL test completes all 126 assertions. Its shipped matching query uses a real time-range index under normal planner settings; both lower and upper limits are index conditions. The dedicated overview index's definition remains tested separately. Invalid sequential, unbounded and wrong-relation plans fail the plan predicate. Lower-inclusive/upper-exclusive and expired event/segment exclusion also execute. The full managed rerun executes 206 files and 4,336 assertions with 28 red files; the diagnostic file is no longer red. No schema, application grant or test exit was changed.

The subsequent unrestricted root rerun with a worktree-local npm cache and permitted own-process identity readback passed 11,314 assertions and failed 51 across 27 files, retaining eight existing conditional skips. The restricted sandbox run additionally exposed six environment failures; these were resolved by the permitted execution environment, not source changes. Lint, published typecheck, policy/inventory and the tree neutrality ratchet pass. These local results still do not satisfy the complete verifier or publication prerequisites.

An owned disposable replay also measured effective authority: baseline application objects belong to postgres; service_role has BYPASSRLS but lacks table access to several INVOKER readers, including email_sends/email_events and subscriptions. EXECUTE exists for the email and renewal readers. The audit primitive has no service EXECUTE. The trigram extension is in public while the search function resolves its operator through extensions. These readbacks explain failures; they authorize no grant or existing-instance conversion.

### Restored cleanup-transition hold

`src/lib/paymentRecoverySha256Boundary.test.ts` additionally retains two historical whole-cleanup obligations: only the lookup RPCs change while the SHA-256 writer remains untouched, and the cleanup adds no transaction/schema/provider side effects. Selected current function bodies cannot prove either whole-delta property. The missing historical cleanup source therefore remains a lazy raw failure, independently from the passing current-function checks. Repair owner: CI completeness contributors; transition-contract decision owner: maintainer. The preceding root snapshot predates this restoration. No historical migration is fabricated.

### Executed commerce proof repairs

Four new transactional pgTAP witnesses complete all 160 assertions against the shipped managed chain, with no application grants or schema changes:

| Witness | Assertions | Executed obligation |
| --- | --- | --- |
| `subscription_payment_result_refusal_test.sql` | 27 | Exact legacy success/failure deprecation under service_role, repeated refusal without changes to complete writer state, effective execution rights and actual browser-role denials for all three symbols. |
| `inventory_local_boundary_test.sql` | 35 | Physical local ATP oversell refusal, accepted runtime reservation/consumption, unchanged complete nonempty state on same-input replay and exact browser-role function refusals. Changed-input replay defects remain separately characterized. |
| `commerce_fulfillment_boundary_test.sql` | 50 | Actual fresh create and replay, failed-payment/missing-reservation refusal, label without inventory consumption, first/repeated handoff with exactly one consumption movement, effective ACLs and exact browser function denials. Payment settlement and reservation prerequisites are synthetic fixture facts, not proofs of their own writers or provider activation. |
| `commerce_oms_boundary_test.sql` | 48 | Actual hold create/release replay with complete state comparisons, real 506-order queue pagination and summaries beyond 500, effective ACLs and exact browser function denials. |

Their root boundary tests register the actively collected SQL witnesses rather than absent historical probes. These prove current behavior only. The OMS shipping-address-lock mismatch, historical migration and cleanup-transition holds remain raw failures. No existing-history migration, provider operation, live BFF authorization or production behavior is claimed.

The managed rerun executes 210 files and 4,496 assertions, with the same 28 existing red files and raw exit 1. All four new files complete their TAP plans. The owned local stack is removed after the run. New witnesses do not waive any remaining mandatory check.

The unrestricted root rerun after these proof repairs passed 11,321 assertions and failed 47, with eight existing conditional skips and 25 red files. It includes the restored two-assertion cleanup-transition hold and the remaining OMS address-lock mismatch. This is a pre-rebase measurement; current mandatory verification remains required.

The branch is subsequently rebased onto `c705c215955286a97606db7610446b69f5306e74` (documentation controls from PR #53). All sixteen documentation-impact obligations are answered with meaningful owner updates or precise delta-bound no-impact records; generated navigation is checked. The initial neutrality baseline is recomputed against that actual base, without increasing candidate findings over its counts. The catalogue contains exactly 4,697 tracked paths and the source contract is regenerated from that tree. These deterministic integration values are computed evidence, not owner decisions or waived failures.

The first full verifier after rebase exposed two additional recoverable integration issues: the guard vocabulary test still treated the newly published documentation-maintenance guard as withheld, and a new core README link escaped the extracted package. The vocabulary now retains all ten withheld guards and separately requires the exact published documentation guard, including its public inputs, command, CI entrypoint and falsifier. The README describes the UI counting process without an external local link. The five guard tests and complete core CI pass. The preceding 26-file/48-assertion root failure measurement predates these fixes; fresh final verification remains required. The workflow-mirror drift is unchanged and owner-controlled.

Configured renderer/shipment fixtures do not establish public-default commerce copy parity. Source comments now state that limit rather than referring to an unlocated public-parity suite. This wording repair adds no behavioral assertion or acceptance claim.
