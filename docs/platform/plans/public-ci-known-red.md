# Remaining public CI obligations

Status: diagnostic record, not a test waiver. All listed tests still run and retain raw failing exits.

Decision owner: OpenLup maintainer. Repair owner: CI completeness contributors. These roles identify routing; this record does not claim that the maintainer accepted a failure budget.

## Managed pgTAP snapshot

Measured against candidate `5f4094b73486371c872ededfb545b54cad6a5353` and public main `03dbbedc953b96607f1ef1fc3342847cf49aa16e`: 206 files executed, 23 red files. The later fixture/neutrality integration did not change managed SQL or the pgTAP runner. A final serial rerun remains required.

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

## Root test dispositions

Current structural mapping uses shipped definitions for current-shape obligations and preserves separate failures for missing historical transitions. Named failures remain in their original test files; no skipped replacement or fresh-install claim discharges an upgrade guarantee.

| Family | Remaining obligation |
| --- | --- |
| Diagnostic history; subscription own-engine and offer-policy migrations | Missing ordered backfill, destructive-transition, timeout and mixed-history evidence; current dump declarations alone cannot prove transitions. |
| Admin membership; feedback-media authority | Historical predecessor-positive controls, ordered backfill and atomic upgrade/refusal proofs are absent. Current ACL text is not effective role-taking access. |
| Commerce, OMS, inventory and provider boundary probes | Missing rollback-only probes, public seed/docs contracts, or differing permission/address-lock declarations. |
| Local environment status; catalogue real-DB runner; reference journey readbacks | Promised public executables/transports are absent. A loader error does not prove the executable’s intended refusal. |
| Renewal cron; order-review BFF routing; direct fulfillment Compose; starter checkout specs | Promised composition roots/specs are absent from the published profile. Other shipped callers have different enablement and cannot substitute for them. |
| Scheduler SQL characterization; staging bridge invokers | Historical source producers are absent; synthetic parser tests cannot prove shipped routing. |
| Accounting lifecycle coverage matrix; communications template seeds | Referenced public evidence/data contract is absent; catalogue or policy text is not an equivalent witness. |

Two environment-only failures were independently diagnosed: sandbox access to the user npm cache and to the start time of the runner’s own process. Focused reruns use a worktree-local cache and permitted own-process readback; they do not alter application permissions or test exits.

## Routing

Select the managed installation authority before adding effective access proofs or changing reference setup. Prepare narrow email-read, trigram, audit and catalogue contracts separately. Existing-history uncertainty refuses automatic upgrade. Broad grants, copied historical files, test exclusions and silent release-admission changes are outside this plan.

See the [approved implementation plan](public-ci-completeness.md) and [managed installation contract](managed-installation-proof-contract.md).
