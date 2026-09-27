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

| Named test | Remaining reason |
| --- | --- |
| `scripts/catalog-document-revision-foundation-real-db-proof.test.ts` | Promised public replay runner is absent; loader failure does not prove infrastructure refusal. |
| `scripts/customer-diagnostic-history-schema.test.ts` | Current bodies are tested; historical parity, bounded installation, mixed-history and browser-revocation declarations remain missing. |
| `scripts/local-env-status.test.ts` | Shipped credential-suppressing status-summary executable is absent. |
| `scripts/oss-split-rehearsal-sql-edge.test.ts` | Checked-in historical scheduler producers are absent; parser fixtures do not prove shipped routing. |
| `scripts/platform-accounting-document-lifecycle-parity.test.ts` | Referenced coverage matrix for deferred decisions is absent. |
| `api/bff/[...path].test.ts` | Public profile omits the two order-review routes; pre-auth refusal ordering is unproved. |
| `api/_cron/outboxHandlerGroupReadiness.test.ts` | Published Compose lacks the promised direct-fulfillment composition root. |
| `api/_cron/stagingBridgeInvokerRouteContract.test.ts` | Shipped SQL scheduler invoker producers are absent. |
| `api/cron/cronGateFlagAuthority.test.ts` | Dedicated subscription-renewal cron entrypoint and its flag contract are absent. |
| `src/lib/adminUsersRlsRecursion.test.ts` | Historical helper, ordered backfill and direct-DML ACL declarations are absent; current body/policy witnesses pass. |
| `src/lib/commerceFulfillmentIntegrationBoundary.test.ts` | Rollback-only fulfillment replay/consume-once probe is absent. |
| `src/lib/commerceOmsBoundary.test.ts` | Missing probes/docs and differing current address-lock declarations need equivalent evidence or a contract decision. |
| `src/lib/commerceV2MigrationsGuard.test.ts` | Historical commerce-v2 migration family is absent; an empty guard scan must fail. |
| `src/lib/communicationProviderSyncBoundary.test.ts` | Disabled-by-default provider synchronization control seed is absent. |
| `src/lib/domainSchemaMigration.test.ts` | Required historical additive/domain migration source is absent. |
| `src/lib/ecommerceOrderDraftDbRehearsalCandidate.test.ts` | Current outbox policy declaration differs; historical rehearsal probe and apply report are absent. |
| `src/lib/inventoryHiddenBoundary.test.ts` | Oversell/public-RPC-refusal rehearsal probe is absent. |
| `src/lib/omnipackEvidenceBoundary.test.ts` | Explicit ACL declarations differ; provider seed, rollback-only evidence probe and documentation are absent. |
| `src/lib/omnipackFulfillmentBoundary.test.ts` | Required provider integration configuration documentation is absent. |
| `src/lib/subscriptionOfferPolicyPersistenceBoundary.test.ts` | Legacy-row freeze/backfill transition proof is absent. |
| `src/lib/subscriptionOwnEngineMigration.test.ts` | Zero-row/destructive provider-ownership transition proof is absent. |
| `src/lib/subscriptionOwnEngineRpcBoundary.test.ts` | Explicit browser revocation declaration and replay/atomic-refusal probe are absent. |
| `src/lib/subscriptionPaymentResultBoundary.test.ts` | Historical browser ACL declaration and fail-fast nonmutation probe are absent. |
| `src/lib/subscriptionSelfServiceGuardrails.test.ts` | Shipping-action smoke/docs proof chain is absent; current delegation chain is tested. |
| `tests/postgres/adminMembershipAuthority.test.ts` | Missing historical forwards prevent ordered-backfill/cleanup/ACL transition proof. |
| `tests/postgres/feedbackMediaAuthority.test.ts` | Missing historical forward and append contract prevent predecessor/overload/atomic rollback proof. |
| `scripts/reference-adapters/reference-journey-readbacks.test.ts` | Public ordered-readback transport is absent; handler unit tests are not equivalent. |
| `src/domains/communications/dbEmailTemplateSeedContent.test.ts` | Canonical delivery/in-transit template seeds are absent. |
| `tests/preview/checkout/helpers/starterOfferCoverage.test.ts` | The three checkout specs required to carry starter-offer evidence markers are absent. |

The npm cache and own-process identity environment failures were resolved by a worktree-local cache and permitted own-process readback. No application grant or test exit changed.

The root rerun after integrating PR #52 passed 11,262 assertions and failed the same 58 assertions across 29 files, with 8 existing conditional pending assertions. The committed-inventory refusal suite then passed 42 assertions, including duplicate versions, missing/modified/untracked files, symlinks and mode changes. These bounded checks do not waive full verification.

The subsequent absorption restoration is an additional unresolved bare-install assertion; the preceding 28-file pgTAP measurement predates it. `src/lib/addressCanonBoundary.test.ts` additionally retains the absent historical PNA disabled-seed/licensing-note expectation with raw failure semantics. Its schema-vocabulary checks do not prove licensed-source activation safety; this file is an additional named root blocker beyond the preceding 29-file measurement. No licensed data or synthetic migration history is supplied.

## Routing

Select the managed installation authority before adding effective access proofs or changing reference setup. Prepare narrow email-read, trigram, audit and catalogue contracts separately. Existing-history uncertainty refuses automatic upgrade. Broad grants, copied historical files, test exclusions and silent release-admission changes are outside this plan.

See the [approved implementation plan](public-ci-completeness.md) and [managed installation contract](managed-installation-proof-contract.md).
