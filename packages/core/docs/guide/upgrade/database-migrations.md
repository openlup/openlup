# Upgrade the database

Apply your selected packages' database changes without altering installed
history or application data. Check compatibility before applying a forward.

## Follow the additive forward path

Append forwards in catalogue order. Preserve the baseline and every applied
unit without splitting, renaming, reordering or editing them. Never relabel
old SQL as new. Fresh installs apply the baseline first. Matching installs
apply only pending forwards. The runner offers no down migrations.

The catalogue pins each file's canonical path and SHA-256. Before applying
SQL, the runner rejects missing or unlisted files, duplicate identities,
changed bytes and any history that differs from the selected prefix by path,
digest or position. Repair with a compatible forward that preserves the prefix.

Release admission allows bounded object creation, table additions and literal,
idempotent seeds. It rejects destructive operations, renames, schema moves,
ownership transfers, writes to the application-owned `app` schema, procedural
or dynamic SQL and unsupported expressions. Verify application compatibility
and installed history separately. Other changes need their own compatibility
path.

For an application-owned chain, compare its schema and applied identities with
the selected catalogue and prepare compatible forwards. Use the package baseline
for new installs. The runner refuses mismatched ledgers.

## Select the complete catalogue

Use `createPlatformPostgresMigrationRunner` from `@openlup/platform/migrations`.
The complete catalogue and SQL resolve within the installed package without a
source checkout. Install the optional `pg` peer. Without it, `legacy` reports
`OPENLUP_E_PEER_MISSING` and qualified installs report the module-loading error.

Supply an explicit `installation` selection: `legacy`, `qualified-v2` or
`qualified-admin`, with the selected profile's role bindings. Omitting it
refuses with `platform migration installation is required`. Keep the
generation that owns your installed history; selecting another generation
does not convert it. Provision the matching host roles and use a direct
PostgreSQL connection that retains one session for the migration operation.
Both qualified selections accept `roleMode: "installer-managed"` or
`"operator-provisioned"`, with `migrationLogin`, `bootstrapLogin` and
`runtimeLogin`. The restricted `qualified-admin` selection also requires
`restoreLogin` and, in operator-provisioned mode, a distinct `operatorLogin`.
The privileged `qualified-v2` selection permits an optional restore login.
Provision the migration, bootstrap, runtime and any required restore or operator
logins before invoking the runner. The [connection role guidance](../how-to/operate/connect-postgresql.md#assign-connections-by-work)
describes the prerequisites.

For a `qualified-v2` plan containing the catalogue publication forward,
installer-managed mode creates `openlup_catalog_publication` automatically.
In operator-provisioned mode, create that login before applying the forward.
Use `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
with no memberships or owned objects. The forward assigns its catalogue grants
and policies. Supply a private credential to the catalogue host connection
when enabling it. The demonstration installer manages the credential with
`./lifecycle up`. If the runner reports `catalog_publication_login_missing`,
restore the restricted login and its reviewed grants from the installation
before starting the host.

The factory also accepts a `poolFactory`, a custom `catalog` reader, its `root`
and a `catalogProjectionPayload` callback. These are trusted host inputs. A
custom pool factory owns startup options and pool lifetime; a custom catalogue
does not bypass manifest or history checks. Use the lower-level
`createPostgresMigrationRunner` when supplying the complete source/options API.
Imports perform no installation; call the returned methods explicitly.

Before a fresh `legacy` installation, `inspectLegacyPostgresInstallRoles` from
`@openlup/platform/lifecycle` reads the legacy bootstrap's role prerequisites
through a query handle you supply and reports blockers such as
`legacy_bootstrap_requires_superuser`. Even `rolePrerequisitesMet: true` does not establish
install readiness, runtime grants, pooling or host support; the helper only
reads, creates no role or schema and runs no installer.

Module descriptors list subsets of the SQL. Install the full selected
catalogue with its dependencies and preserve its prefix.

`JOB_RUN_LEDGER_MIGRATIONS` lists the base ledger and claim/finish replacements.
Use those assets in your complete chain or use the catalogue that defines them.
Applying both attempts to recreate functions and fails. Importing
`@openlup/platform/job-ledger` applies no SQL.

## Reconcile stale native renewals

If this renewal forward is pending on your installation, start this checklist before applying it. It applies to installations upgrading from Platform 1.0.0 through 1.4.x. Keep verified payment and fulfillment evidence intake available throughout.

1. **Pause and drain renewal snapshot building (including builds that graduate a subscription's terms), renewal claim creation, renewal and retry dispatch, and template-edit acceptance before applying the forward.** Stop new builds and claims from mounted and custom callers, including direct callers. Wait until in-flight build and claim-creating transactions have committed or rolled back. An RPC returning inside an open transaction does not complete the drain. Stop acceptance on every template-edit route and drain its open transactions. Keep builds, claims and edit acceptance paused through forward commit. Stop new sends at the shared provider execution boundary and drain all in-flight sends there, including callers already past local preparation. Keep verified payment and fulfillment intake available throughout. Defer independent lifecycle changes that affect schedules or eligibility, including manual and timed resume and reactivation, for the affected population through cutover. Drain any in-flight reactivation before the forward. Run the forward separately from owner maintenance or restore that can change the captured rows or their schema. Authorized reconciliation and verified evidence remain available.
2. Apply the bundled PostgreSQL forward and confirm it in the ledger. Before the first cut or repair, pause and drain independent table rewrites, truncation and relevant DDL on the relations the checks use, and replacement creation and other independent shipment-lineage changes for the affected population. Keep these fences through resume. Continue accepting verified evidence for existing shipments.
3. In `auto_align`, verify each live arrival route using its actual writer, row visibility, enabled trigger and `READ COMMITTED` write transaction. Exercise an eligible late arrival on the same installation profile. Include direct, inherited, owner and owner-executed command routes. Bring a qualified route up before switching traffic away from an unqualified one. Drain transactions admitted through the old authority or transaction context. An unresolved route blocks resume.
4. Run both read-only checks on one authorized primary connection with complete visibility. Use the shared ownership predicate in both statements. Record the cut, operation IDs and affected subscription IDs in the restricted upgrade record. Evidence committed before the first read is visible. Later ordinary commits appear on a rerun. Errors, incomplete visibility or a broken fence invalidate the run.
5. Re-read live state. Use subscription and inventory owners for unprepared work and stock waits. Use verified readback, webhook replay, settlement or authorized closure for payment work. Preserve frozen money and artifact identity. Use the payment recovery owner for retries and incomplete handoffs. Resolve any occupying work before the installation-owner schedule repair. Reopening or completing a handoff can leave a row chargeable.
6. Keep effective roles, grants, memberships, ownership, trigger configuration, transaction context, route bindings and alignment mode stable from qualification through resume. If a fence changes, restore it, requalify where applicable and take a new cut. **Immediately before resuming dispatch**, confirm zero alignment rows and no billing row with a reason other than `provider_state_open_after_cancellation`. Resume through the ordinary scheduler.

A verified webhook committed before the first read is visible in the report.
A later commit leaves the earlier state visible. The forward records historical
billing claims with a stale accepted version or no usable template version
(`unknown_provenance`).
Claims that were current at the forward and new claims use the price frozen at
claim. Later accepted edits apply to later cycles.

With the forward installed, the node-postgres renewal rail refuses a first claim with `subscription_renewal_snapshot_stale`
when the snapshot carries version evidence that proves it stale. Bare legacy
claims without build-version evidence are admitted as before. Custom legacy
callers get the same protection by locking the subscription row before
building the snapshot and holding that lock through the claim in the same
transaction. Re-read and rebuild the snapshot on the stale refusal.

### Shared renewal ownership predicate

Copy this SQL fragment verbatim into both marked positions in the read-only
checks. It excludes native v3 work using the operation, schedule, and delivery
lineage bound by each statement.

```sql
NOT EXISTS (
  SELECT 1
  FROM ownership_subjects subject
  WHERE subject.contract_version = 'platform.subscription.renewal.v3'
     OR EXISTS (
       SELECT 1
       FROM public.subscription_cycle_occurrences x
       WHERE x.subscription_id = subject.subscription_id
         AND x.client_id = subject.client_id
         AND x.rail = 'v3'
         AND (
           (subject.check_current AND x.is_current)
           OR EXISTS (
             SELECT 1 FROM public.subscription_cycle_generations g
             WHERE g.operation_id = subject.operation_id AND g.cycle_key = x.cycle_key
           )
           OR EXISTS (
             SELECT 1 FROM public.subscription_cycle_delivery_assignments a
             WHERE a.obligation_ref = subject.order_id
               AND x.cycle_key IN (a.assigned_cycle_key, a.marker_cycle_key)
           )
           OR EXISTS (
             SELECT 1 FROM public.subscription_cycle_preparations p
             WHERE p.cycle_id = subject.cycle_id AND p.order_id = subject.order_id
               AND p.cycle_key = x.cycle_key
           )
         )
     )
)
```

### Run the read-only checks

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;

SELECT pg_current_snapshot()::text AS cut_snapshot,
       statement_timestamp() AS cut_statement_started_at;

WITH roots AS MATERIALIZED (
  SELECT o.*, s.status AS subscription_status, s.next_cycle_at,
         cohort.unknown_provenance
  FROM public.subscription_renewal_upgrade_cohort cohort
  JOIN public.subscription_renewal_operations o ON o.id = cohort.renewal_operation_id
  JOIN public.subscriptions s ON s.id = o.subscription_id
  CROSS JOIN LATERAL (
  WITH ownership_subjects(subscription_id, client_id, contract_version, operation_id, cycle_id, order_id, check_current) AS (
    SELECT s.id, s.client_id, o.cycle_snapshot->>'contractVersion',
           o.id, booked_order.subscription_cycle_id, booked_order.id, false
    FROM (VALUES (o.id)) operation(id)
    LEFT JOIN public.subscription_cycles booked_cycle ON booked_cycle.renewal_operation_id = operation.id
    LEFT JOIN public.commerce_settlement_intents linked_intent ON linked_intent.renewal_operation_id = operation.id
    LEFT JOIN public.subscription_retry_obligations linked_retry ON linked_retry.renewal_operation_id = operation.id
    LEFT JOIN public.commerce_orders booked_order ON booked_order.renewal_operation_id = operation.id
      OR booked_order.subscription_cycle_id = booked_cycle.id
      OR booked_order.id IN (linked_intent.order_id, linked_retry.order_id)
  )
  SELECT
/* Paste the shared renewal ownership predicate here. */
) ownership(is_legacy)
  WHERE ownership.is_legacy
), financial AS (
  SELECT o.id, o.state, o.attempt_prepared_at, o.external_attempt_acknowledged_at,
         o.cycle_snapshot->>'settlementChannelKey' AS channel, i.channel_key AS intent_channel,
         r.id AS retry_id, r.state AS retry_state, r.retry_attempt, r.attempt_sequence,
         r.next_retry_at, r.renewal_quarantined_until, prep.id AS prepare_receipt_id,
         failure.id AS failure_receipt_id, d.id AS case_id, d.status AS case_status,
         d.retry_attempt AS case_rung,
         c.id AS cycle_id, c.status AS cycle_state, ord.id AS order_id, ord.status AS order_state,
         i.id AS intent_id, i.status AS intent_state, ps.status AS provider_state,
         pa.id AS provider_attempt_id, pa.status AS provider_attempt_state,
         COALESCE(pa.provider_attempt_id, pa.provider_session_id) IS NOT NULL AS provider_has_remote_reference,
         open_attempts.unresolved_provider_attempts,
         sim.id AS simulator_attempt_id, sim.state AS simulator_attempt_state,
         COALESCE(exact_provider.id, exact_sim.id) AS retry_attempt_id,
         COALESCE(exact_provider.status, exact_sim.state) AS retry_attempt_state,
         COALESCE(exact_provider.provider_attempt_id, exact_provider.provider_session_id) IS NOT NULL AS retry_has_remote_reference,
         (ord.id IS NULL OR ord.status = 'pending_payment') AS payable,
         (i.id IS NULL OR i.status IN ('created', 'failed')) AS unsettled,
         (ps.status NOT IN ('succeeded','cancelled','refunded','partially_refunded','disputed')) AS provider_open,
         CASE
           WHEN failure.id IS NULL AND (o.attempt_prepared_at IS NULL OR i.status IS DISTINCT FROM 'failed') THEN NULL
           WHEN d.id IS NULL THEN 'case_missing'
           WHEN d.retry_attempt < COALESCE(r.retry_attempt, 1) THEN 'case_behind'
           WHEN d.retry_attempt = r.retry_attempt AND failure.input ? 'paymentAttemptId'
             AND (failure.input->>'paymentAttemptId') IS DISTINCT FROM attribution.failed_payment_attempt_id::text
             THEN 'case_attribution_conflict'
           WHEN r.id IS NOT NULL AND r.case_id IS DISTINCT FROM d.id THEN 'case_binding_conflict'
           ELSE 'recorded'
         END AS failure_handoff
  FROM roots o
  LEFT JOIN public.subscription_retry_obligations r ON r.renewal_operation_id = o.id
  LEFT JOIN public.subscription_cycles owned_cycle ON owned_cycle.renewal_operation_id = o.id
  LEFT JOIN public.commerce_settlement_intents direct_intent ON direct_intent.renewal_operation_id = o.id
  LEFT JOIN public.commerce_orders ord ON ord.renewal_operation_id = o.id
    OR ord.subscription_cycle_id = owned_cycle.id OR ord.id IN (direct_intent.order_id, r.order_id)
  LEFT JOIN public.subscription_cycles c ON c.id = COALESCE(ord.subscription_cycle_id, owned_cycle.id, r.cycle_id)
  LEFT JOIN public.commerce_settlement_intents i ON i.order_id = ord.id
  LEFT JOIN public.payment_provider_states ps ON ps.id = i.id
  LEFT JOIN public.payment_provider_attempts pa ON pa.id = ps.active_attempt_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'status', a.status,
      'has_remote_reference', COALESCE(a.provider_attempt_id, a.provider_session_id) IS NOT NULL)
      ORDER BY a.id) AS unresolved_provider_attempts
    FROM public.payment_provider_attempts a
    WHERE a.settlement_intent_id = i.id AND a.status IN ('created','sent_to_provider','requires_action','processing')
  ) open_attempts ON true
  LEFT JOIN public.payment_simulator_attempts sim ON sim.settlement_intent_id = i.id AND sim.is_active
  LEFT JOIN public.subscription_retry_receipts prep ON prep.obligation_id = r.id
    AND prep.kind = 'prepare' AND prep.attempt_sequence = r.attempt_sequence AND r.state = 'prepared'
  LEFT JOIN public.subscription_retry_receipts failure ON failure.obligation_id = r.id
    AND failure.kind = 'failure' AND failure.attempt_sequence = r.retry_attempt - 1
  LEFT JOIN public.subscription_dunning_cases d ON d.cycle_id = c.id
  LEFT JOIN public.payment_dunning_case_attribution attribution ON attribution.case_id = d.id
  LEFT JOIN public.payment_provider_attempts exact_provider ON exact_provider.settlement_intent_id = i.id
    AND i.id = r.settlement_intent_id AND prep.input->>'paymentIntentId' = i.id::text
    AND exact_provider.idempotency_key = prep.input->>'idempotencyKey'
    AND exact_provider.request_payload->>'providerIdempotencyKey' = prep.input->>'providerIdempotencyKey'
    AND exact_provider.request_payload->>'providerRequestFingerprint' = prep.input->>'providerRequestFingerprint'
  LEFT JOIN public.payment_simulator_attempts exact_sim ON exact_sim.settlement_intent_id = i.id
    AND i.id = r.settlement_intent_id AND prep.input->>'paymentIntentId' = i.id::text
    AND exact_sim.request_key = prep.input->>'idempotencyKey'
    AND exact_sim.request_fingerprint = prep.input->>'providerRequestFingerprint'
), stock AS (
  SELECT o.id, w.id AS stock_wait_id, w.state AS stock_wait_state,
         a.id AS reservation_id, a.status AS reservation_state,
         (o.state = 'reserved' AND a.status = 'held'
           AND a.operation_fingerprint = o.operation_fingerprint) AS held_reservation,
         (o.state = 'refused' AND o.terminal_reason IN ('inventory_unavailable','reservation_expired')
           AND (w.id IS NULL OR (w.state IN ('waiting','stock_secured') AND w.identity_key = o.identity_key
             AND w.fingerprint = o.operation_fingerprint AND w.cycle_snapshot = o.cycle_snapshot))
           AND (a.id IS NULL OR (a.operation_fingerprint = o.operation_fingerprint AND a.source_key = o.cycle_snapshot->>'stockSourceKey'
             AND (a.status IN ('expired','released') OR (a.status = 'held' AND w.state = 'stock_secured'))))
           AND o.external_attempt_acknowledged_at IS NULL
           AND ((o.subscription_status = 'active' AND public.subscription_stock_wait_frozen(o.subscription_id, o.scheduled_at) IS NOT NULL)
             OR (o.subscription_status = 'paused' AND w.state IN ('waiting','stock_secured') AND w.scheduled_at = o.next_cycle_at
               AND o.attempt_prepared_at IS NULL AND o.external_attempt_acknowledged_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM financial f WHERE f.id = o.id
                 AND COALESCE(f.cycle_id, f.order_id, f.intent_id) IS NOT NULL)))
           AND NOT EXISTS (SELECT 1 FROM public.subscription_renewal_outcomes e
             WHERE e.renewal_operation_id = o.id AND (e.outcome <> 'refused'
               OR e.reason IS NULL OR e.reason NOT IN ('inventory_unavailable','reservation_expired')
               OR e.external_ref IS NOT NULL OR e.operation_fingerprint <> o.operation_fingerprint
               OR e.event_key NOT IN (o.identity_key||':inventory', o.identity_key||':reservation-expired')))) AS recoverable_wait
  FROM roots o
  LEFT JOIN public.subscription_stock_wait_cases w ON w.renewal_operation_id = o.id
  LEFT JOIN public.fulfillment_inventory_reservations a ON a.renewal_operation_id = o.id
), routes AS (
  SELECT o.id, reason
  FROM roots o JOIN stock s USING (id)
  CROSS JOIN LATERAL (VALUES
    ('first_charge', o.state = 'claimed' OR s.held_reservation),
    ('stock_wait', s.recoverable_wait OR (s.held_reservation AND s.stock_wait_state = 'stock_secured'))
  ) AS route(reason, chargeable)
  WHERE chargeable
  UNION ALL
  SELECT f.id, reason FROM financial f
  CROSS JOIN LATERAL (VALUES
    ('prepared_first_charge', f.state = 'attempt_prepared' AND f.unsettled AND f.payable),
    ('unpaid_intent', f.intent_id IS NOT NULL AND f.unsettled AND f.payable),
    ('provider_attempt', f.unresolved_provider_attempts IS NOT NULL OR (f.provider_open AND f.unsettled AND f.payable)),
    ('record_attempt', f.provider_open AND f.intent_state <> 'cancelled'),
    ('provider_state_open_after_cancellation', f.intent_state = 'cancelled' AND f.provider_open),
    ('sandbox_attempt', f.intent_channel = 'sandbox' AND f.payable
      AND f.intent_state <> 'settled'),
    ('sandbox_ack', f.channel = 'sandbox' AND f.state = 'attempt_prepared'
      AND (f.external_attempt_acknowledged_at IS NULL OR f.unsettled)),
    ('retry', f.retry_state IN ('waiting','prepared') AND f.cycle_state = 'payment_pending' AND f.unsettled),
    ('failure_handoff', f.failure_handoff <> 'recorded' AND f.cycle_state = 'payment_pending'
      AND f.unsettled AND f.payable)
  ) AS route(reason, chargeable)
  WHERE chargeable
), listed AS (
  SELECT id, array_agg(DISTINCT reason ORDER BY reason) AS reasons FROM routes GROUP BY id
)
SELECT o.id AS operation_id, o.subscription_id, o.scheduled_at, o.state AS operation_state,
       o.subscription_status, o.next_cycle_at, o.terminal_reason,
       o.cycle_snapshot->'totalAmountMinor' AS frozen_amount_minor, o.cycle_snapshot->>'currency' AS currency,
       CASE WHEN o.unknown_provenance AND l.reasons <> ARRAY['provider_state_open_after_cancellation']
         THEN l.reasons || ARRAY['unknown_provenance'] ELSE l.reasons END AS reasons,
       s.stock_wait_id,
       CASE WHEN s.recoverable_wait AND s.stock_wait_id IS NULL THEN 'uncaptured' ELSE s.stock_wait_state END AS stock_wait_state,
       s.reservation_id, s.reservation_state,
       (SELECT jsonb_agg(to_jsonb(f) - ARRAY['id','state','channel','intent_channel','payable','unsettled','provider_open',
           'attempt_prepared_at','external_attempt_acknowledged_at'] ORDER BY f.order_id)
        FROM financial f WHERE f.id = o.id AND COALESCE(f.cycle_id, f.order_id, f.intent_id) IS NOT NULL) AS payment_artifacts
FROM roots o JOIN listed l USING (id) JOIN stock s USING (id)
ORDER BY o.id;

-- Late arrivals whose persisted renewal schedule still needs alignment.
SELECT s.id AS subscription_id, c.id AS predecessor_cycle_id, c.order_id AS predecessor_order_id,
       leaf.shipment_id, s.next_cycle_at AS observed_due_at, leaf.latest_delivery_at, s.cadence_days,
       o.id AS occupying_operation_id, o.state AS occupying_operation_state,
       conflict.successor_cycle_id, 'late_arrival_alignment_pending' AS reason
FROM public.subscriptions s
JOIN public.subscription_renewal_terms t ON t.subscription_id = s.id AND t.delivery_admission = 'allowed'
JOIN public.subscription_delivery_alignment_cycles c ON c.subscription_id = s.id
  AND c.status = 'paid' AND c.cycle_number IS NOT NULL
LEFT JOIN public.subscription_renewal_operations predecessor ON predecessor.id = c.renewal_operation_id
LEFT JOIN public.subscription_renewal_operations o ON o.subscription_id = s.id AND o.scheduled_at = s.next_cycle_at
CROSS JOIN LATERAL (
  WITH ownership_subjects(subscription_id, client_id, contract_version, operation_id, cycle_id, order_id, check_current) AS (
    SELECT s.id, s.client_id, predecessor.cycle_snapshot->>'contractVersion',
           predecessor.id, c.id, c.order_id, true
    UNION ALL
    SELECT s.id, s.client_id, o.cycle_snapshot->>'contractVersion',
           o.id, booked_order.subscription_cycle_id, booked_order.id, false
    FROM (VALUES (o.id)) operation(id)
    LEFT JOIN public.subscription_cycles booked_cycle ON booked_cycle.renewal_operation_id = operation.id
    LEFT JOIN public.commerce_settlement_intents linked_intent ON linked_intent.renewal_operation_id = operation.id
    LEFT JOIN public.subscription_retry_obligations linked_retry ON linked_retry.renewal_operation_id = operation.id
    LEFT JOIN public.commerce_orders booked_order ON booked_order.renewal_operation_id = operation.id
      OR booked_order.subscription_cycle_id = booked_cycle.id
      OR booked_order.id IN (linked_intent.order_id, linked_retry.order_id)
  )
  SELECT
/* Paste the shared renewal ownership predicate here. */
) ownership(is_legacy)
CROSS JOIN LATERAL (
  SELECT (array_agg(p.id ORDER BY p.delivered_at DESC, p.id))[1] AS shipment_id,
         max(p.delivered_at) AS latest_delivery_at
  FROM public.fulfillment_shipments p
  WHERE p.order_id = c.order_id AND NOT EXISTS (
    SELECT 1 FROM public.fulfillment_shipments successor WHERE successor.replaces_shipment_id = p.id)
  HAVING count(*) = count(p.delivered_at) AND max(p.delivered_at) > s.next_cycle_at
) leaf
CROSS JOIN LATERAL (
  SELECT (array_agg(x.id ORDER BY x.id) FILTER (WHERE x.renewal_operation_id = o.id
           AND x.scheduled_at = o.scheduled_at AND x.cycle_number > c.cycle_number
           AND x.status <> 'paid'))[1] AS successor_cycle_id,
         count(*) FILTER (WHERE (x.renewal_operation_id = o.id AND x.scheduled_at = o.scheduled_at
           AND x.cycle_number > c.cycle_number AND x.status <> 'paid') IS NOT TRUE) AS blockers
  FROM public.subscription_delivery_alignment_cycles x
  WHERE x.subscription_id = s.id AND (
    x.cycle_number > c.cycle_number OR (x.cycle_number IS NULL AND x.id <> c.id)
    OR (x.status = 'paid' AND x.cycle_number = c.cycle_number AND x.order_id IS DISTINCT FROM c.order_id))
) conflict
WHERE (SELECT mode FROM public.subscription_delivery_alignment_control WHERE singleton) = 'auto_align'
  AND s.status = 'active' AND s.next_cycle_at IS NOT NULL AND conflict.blockers = 0
  AND ownership.is_legacy
  AND NOT EXISTS (SELECT 1 FROM public.subscription_dunning_cases d
    WHERE d.subscription_id = s.id AND d.status IN ('open', 'expired'))
  AND NOT EXISTS (SELECT 1 FROM public.subscription_delivery_alignment_cases a
    WHERE (a.predecessor_order_id = c.order_id AND a.state <> 'shadow')
       OR (a.subscription_id = s.id AND a.state IN ('protected', 'manual_review')
           AND (a.predecessor_cycle_number IS NULL OR a.predecessor_cycle_number >= c.cycle_number)))
ORDER BY s.id;

COMMIT;
```

Retry attempt identifiers refer to the current prepare receipt. A remote-reference
flag records presence. Use the payment owner's readback or closure procedure to
resolve the attempt.

### Repair a pending delivery alignment

1. **Resolve occupants first.** Route a `claimed` or `reserved` operation without preparation through the subscription or inventory owner. Release or refuse it using the exact stored claim and valid token. If needed, use ordinary exact takeover solely for release authority after forward commit, with dispatch paused. Close recoverable stock waits and held reservations. Preserve the operation row, due instant, wire, fingerprint and history. The old `refused` row keeps occupying that instant and remains visible while the schedule gap persists.
2. **Use the payment owner for prepared or uncertain work.** Resolve the original attempt with verified truth or authorized closure, preserving identity and amount. A successor cycle, live financial work, open or recoverable stock, or uncertain disposition blocks the schedule write. If the artifact remains, use the lifecycle owner for safe disposition. Keep affected dispatch paused until it is resolved. Any authorized suspension or closure must remove the subscription from the resumed population, and reactivation requires owner verification of the appropriate due date.
3. **Revalidate under the subscription lock.** The installation owner begins `READ COMMITTED`, locks the subscription `FOR UPDATE`, then reruns the exact alignment statement, with the shared ownership predicate, for that subscription in the next statement. A v3 exclusion yields zero schedule or case writes, including when an earlier report identified the gap. Verify changed candidates afresh. Write only with no occupant or with a durably `refused` occupant, no prepared or acknowledged attempt, no open or recoverable stock and no linked cycle, order, intent or retry. Keep the lineage fence from revalidation through commit. Use the verified arrival route’s time zone and the incumbent calendar-day arithmetic. If eligibility or time-zone provenance is ambiguous, keep affected dispatch paused for owner review.
4. **Apply the clamp and case settlement together.** Use `subscription_delivery_alignment_upsert_case` with `auto_align`, `overdue_renewal`, the correlated predecessor and locked observed due. Prefer the selected leaf’s shadow case. For a replacement with no direct case, use the first order shadow by `created_at, id`, with its shipment ID if present and the selected leaf otherwise. Record the selected case’s verified timestamp with `LEAST(COALESCE(delivered_at, verified_at), verified_at)`. Set `next_cycle_at = GREATEST(next_cycle_at, latest_unsuperseded_delivery + make_interval(days => cadence_days))`, update its timestamp and settle the promoted and shadow cases as aligned with the returned due. Commit together. A rerun finds no gap and writes nothing. Preserve shipment facts, arrival receipts and the payment graph. Ordinary arrival replay leaves the timestamp intact, case resolution releases without shifting, and replacement confirmation computes from its own time.

Use the installation owner. Substitute the verified arrival writer's time zone and
the reported subscription ID below. Paste the full statement that returns
`late_arrival_alignment_pending`, including the shared ownership predicate, in place of the SQL comment, without its final
semicolon. Use a fresh transaction for each subscription.

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL TIME ZONE '<arrival time zone>';

DO $repair$
DECLARE
  target_subscription constant uuid := '<subscription ID>';
  gap record;
  case_shipment uuid;
  repaired_due timestamptz;
BEGIN
  PERFORM id FROM public.subscriptions WHERE id = target_subscription FOR UPDATE;
  FOR gap IN
    SELECT pending.* FROM (
      /* Paste the expanded alignment statement here. */
    ) pending
    LEFT JOIN public.subscription_renewal_operations o ON o.id = pending.occupying_operation_id
    WHERE pending.subscription_id = target_subscription
      AND pending.successor_cycle_id IS NULL
      AND (o.id IS NULL OR (
        o.state = 'refused' AND o.attempt_prepared_at IS NULL AND o.external_attempt_acknowledged_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.fulfillment_inventory_reservations a
          WHERE a.renewal_operation_id = o.id AND a.status = 'held')
        AND NOT EXISTS (SELECT 1 FROM public.subscription_stock_wait_cases w
          WHERE w.renewal_operation_id = o.id AND w.state IN ('waiting', 'stock_secured'))
        AND public.subscription_stock_wait_frozen(o.subscription_id, o.scheduled_at) IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.subscription_cycles c WHERE c.renewal_operation_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM public.commerce_orders ord WHERE ord.renewal_operation_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM public.commerce_settlement_intents i WHERE i.renewal_operation_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM public.subscription_retry_obligations r WHERE r.renewal_operation_id = o.id)
      ))
  LOOP
    SELECT a.shipment_id INTO case_shipment
    FROM public.subscription_delivery_alignment_cases a
    JOIN public.fulfillment_shipments leaf ON leaf.id = gap.shipment_id
    WHERE a.predecessor_order_id = gap.predecessor_order_id AND a.state = 'shadow'
      AND (a.shipment_id = leaf.id OR leaf.replaces_shipment_id IS NOT NULL)
    ORDER BY (a.shipment_id IS NOT DISTINCT FROM leaf.id) DESC, a.created_at, a.id
    LIMIT 1;
    case_shipment := COALESCE(case_shipment, gap.shipment_id);
    PERFORM public.subscription_delivery_alignment_upsert_case(
      case_shipment, gap.predecessor_order_id, gap.subscription_id, gap.predecessor_cycle_id,
      (SELECT cycle_number FROM public.subscription_delivery_alignment_cycles
       WHERE id = gap.predecessor_cycle_id AND order_id = gap.predecessor_order_id),
      'auto_align', 'overdue_renewal', gap.observed_due_at);
    UPDATE public.subscription_delivery_alignment_cases
    SET delivered_at = LEAST(COALESCE(delivered_at, gap.latest_delivery_at), gap.latest_delivery_at),
        updated_at = now()
    WHERE shipment_id = case_shipment;
    UPDATE public.subscriptions
    SET next_cycle_at = GREATEST(next_cycle_at, gap.latest_delivery_at + make_interval(days => gap.cadence_days)),
        updated_at = now()
    WHERE id = gap.subscription_id
    RETURNING next_cycle_at INTO repaired_due;
    UPDATE public.subscription_delivery_alignment_cases
    SET state = 'aligned', aligned_next_cycle_at = repaired_due, aligned_at = now(), updated_at = now()
    WHERE predecessor_order_id = gap.predecessor_order_id AND state IN ('protected', 'shadow');
  END LOOP;
END;
$repair$;

COMMIT;
```

### Known issues and limitations

**Late arrivals and writer changes.** With automatic alignment enabled, an under-granted writer can record an arrival while leaving the old due time. Repairing grants leaves previously recorded dates as they were. Use the alignment check and qualify affected routes before changing them, including after dispatch resumes. The checks describe their database snapshot. If a late arrival commits after the final check for an already-claimed renewal that has no alignment case or only shadow cases, takeover can still use the old due date.

**Earlier schedule changes.** A prior pause, resume, or reschedule can change the due date used by the alignment check. If the due date changed after a late arrival, have the subscription owner review the original schedule and verified arrival before returning that subscription to billing.

**Cancelled renewals with open provider state.** Lifecycle cancellation can leave provider state open after closing the settlement intent. Automatic provider preparation refuses the cancelled intent. Do not call `recordAttempt` for these rows. Retain the operation ID for payment-owner follow-up. A row with only `provider_state_open_after_cancellation` allows dispatch to resume.

## Prepare the optional checkout owner

Ordinary upgrades on the four qualified profiles require no new login.
Connected-store restore keeps the target's verified grants and ledger.
Legacy has no checkout opt-in. A regular legacy upgrade uses a cluster
without the checkout login. If the login exists for another database,
the grant unit records a no-op, but legacy inventory can refuse the extra
cluster role. Use a qualified installation or a separate cluster.

| Qualified profile | Who provisions the login outside migration | Who preserves TEMP and applies the grant |
| --- | --- | --- |
| Bootstrap migrator | The bootstrap host | The bootstrap database and definition owner |
| Separate migrator | The bootstrap host | The separate database and definition owner |
| Restricted installer-managed | The bootstrap host | The restricted database and definition owner |
| Restricted operator-provisioned | The designated role operator under bootstrap control | The restricted database and definition owner |

For qualified-v2 operator-provisioned installations, the designated host
role operator provisions the login under bootstrap control. On PostgreSQL
16, ask the membership grantor to remove the creator edge. Have the
database owner preserve TEMP for the installation roles that use it
before revoking TEMP from PUBLIC. Coordinate role changes across all
affected databases.

Once an installed catalogue includes the approved grant unit and the
selected database has recorded it, run this operation with the same
installation binding and direct definition-owner connection as the
migration runner:

```ts
import {
  applyPlatformCheckoutOwnerGrant,
  type QualifiedAdminPostgresInstallation,
  type QualifiedPostgresInstallation,
} from "@openlup/platform/migrations";

export function prepareCheckoutOwner(
  connectionString: string,
  installation: QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation,
) {
  return applyPlatformCheckoutOwnerGrant({ connectionString }, installation);
}
```

The operation serializes with migration and restore on the selected database.
Keep host role, role-default, local DDL and ACL administration excluded until it
returns. Repeating it returns the same `{ state: "granted" }` and preserves the
ledger. Verify that result on the selected database before binding any
checkout credential to a supported host. For `checkout_owner_login_unready`,
ask the installation owner to prepare and verify the dedicated checkout
login. For `checkout_owner_acl_mismatch`, ask the installation owner to
verify the approved checkout access for this database. If connected-store
restore refuses target access, ask the installation owner to verify the
target installation.

## Inspect and apply

1. Call `status()` to inspect the applied and pending canonical paths. It
   validates the catalogue, ledger and selected session requirements.
2. Call `apply({ dryRun: true })` to list pending paths without applying SQL.
   Its returned `applied` array means proposed work in this mode.
3. Call `apply()` to execute the pending suffix in catalogue order. Each unit
   and its ledger insert commit in one transaction. A failed unit rolls back;
   earlier committed units remain recorded. Repeat with the same valid
   catalogue to resume from that prefix.
4. Confirm completion with `status()`. A completed chain has no pending paths;
   another `apply()` performs no migration SQL and rechecks the live inventory.

The `public.platform_schema_migrations` ledger records each canonical path,
SHA-256 digest, position and execution timestamp. The runner checks its table
shape before reading rows, then requires those rows to match the exact manifest
prefix. Do not repair a refusal by editing the ledger or the packaged SQL.

Refusals include these error messages:

| Message | Meaning |
| --- | --- |
| `platform migration catalog rejected:` | The catalogue or manifest failed validation; details follow the prefix. |
| `platform migration ledger relation is not safe to read` | The ledger's owner or database-object shape failed admission. |
| `platform migration ledger contains an extra row` | Installed history extends beyond the selected catalogue. |
| `platform migration ledger is not the exact manifest prefix at position` | A path, digest or position differs; the position follows the message. |
| `platform migration inventory rejected:` | The live object inventory differs from the manifest's pinned inventory; details follow the prefix. |

The live inventory is checked after apply, and on status or dry-run when the
whole selected chain is already installed. A pending dry-run does not certify
the final inventory. Inventory rejection can occur after migrations have
committed; it does not roll back the whole upgrade.

### Session and ledger admission

A trusted migration source may supply `assertSession` to observe host facts
once under the advisory lock, after exact ledger-prefix admission and before
status, dry-run or pending SQL. This callback neither provisions nor qualifies
a hosted installation.

Every source uses catalog-bound locks and admits only the canonical baseline
ledger catalog shape before reading its exact prefix. The fingerprint stays
exact except for numeric `pg_attver` column version markers in a nonempty,
one-dimensional array starting at index 1; every other attribute option refuses.
A pending unit locks an installed ledger before its first catalog read in that
transaction and preserves the connection's isolation setting.

## Find the current function definition

Open the installed package's `sql/manifest.json` for the runner's generation.
Follow its baseline and ordered forwards, stopping at the applied prefix from
`status()` for a database with pending forwards. Resolve definitions from that
history before relying on module lists or filenames.

Find anchored `CREATE FUNCTION` or `CREATE OR REPLACE FUNCTION` declarations.
Read the full signature and body, then follow replacements and
`DROP FUNCTION` for the same signature in order. Resolve each overload
separately against the installed version. Treat calls, grants and release notes
as references.

For native `subscription_auto_resume_due(integer,timestamptz)`, the forward
`20261114110000_payment_method_refs.sql` replaces earlier auto-resume definitions.
Its assignment takes the later of the stored next cycle plus the actual pause
duration and execution time. It never brings the next cycle earlier. Follow
[timed pauses](../concepts/subscriptions.md#timed-pauses)
for eligibility and effects; a textual search for a clamp is not an invariant
proof.

## Check application compatibility

A compatible change lets the application continue reading and writing its
existing data contracts. Adding nullable storage or accepting additional status
values can preserve old rows, but the application still needs to understand any
new values or events it will consume. Install required schema additions before
deploying code that depends on them, and update producers and dispatchers
together before enabling newly introduced event flows.

Within 1.x, schema changes are additive: expand and backfill while preserving
contracts used by running and rollback applications. Contraction, including
removing or renaming an old shape, requires a major release. An incompatible
change must establish its expand, compatible deployment, backfill and contract
sequence before use. Catalogue acceptance proves identities and
the selected object inventory, not old/new application compatibility, data
backfill completion or a safe rollback. Reverting application files does not
undo committed SQL or durable effects.

Verify the selected chain and application combination, including replay and refusal
behavior. [Application file upgrades](./application-files.md) are a separate
operation and execute no database work.

For the native starter, apply `20261124200000_checkout_attempt_ledger` before
updating application files or starting the updated host. Older hosts can run
against the additive schema. The updated host begins counting in PostgreSQL
without importing old in-process counts.

| Startup diagnostic | Action |
| --- | --- |
| `starter_checkout_attempt_ledger_missing` | Apply the checkout attempt database forward and restart the starter. |
| `starter_checkout_attempt_ledger_execute_required` | Restore the checkout attempt routine's EXECUTE grant for the runtime role and restart the starter. |
| `starter_checkout_attempt_ledger_check_failed` | Check database connectivity and runtime credentials, then restart the starter. |

The post-publication released-pair qualification
uses both exact installed applications retained by the adjacent-set starter
proof. Their shipped runners use the starter bootstrap's `qualified-v2`,
installer-managed profile on PostgreSQL 16, with distinct install, runtime and
restore roles. They install the predecessor's packaged catalogue and apply the
target's packaged forwards. It kills a forward inside
its transaction, asserts `OPENLUP_E_SCHEMA_BEHIND/version_mismatch` using the
installed readiness evaluator with a supplied target catalogue-tail requirement,
then resumes and checks no-op replay. Target, predecessor and target code run
reads, fresh writes and replay against the unchanged upgraded schema. Named
`subscription_monotonic_clamp` assertions check late-arrival extension, no
earlier cycle and no stacked delivery or cycle across forward, code rollback
and replay. See the retained receipt for the actual pair and execution result;
an identical-catalogue pair records the interruption as
`not-applicable: no forward migrations in this pair` and still runs all
cross-version rollback and subscription checks.

The existing 0.23-prefix invoicing backfill proof remains **historical** and
separate. Contraction and adjacent-pair backfill remain **PARTIAL** until a real
retirement ships, because the 0.41→0.42 pair has no object needed only by the
older application. This proof adds no destructive migration, down-migration or
new admission grammar. Code rollback is proved only for the qualified adjacent
pair, selected PostgreSQL profile and retained reads, fresh writes, replay and
subscription assertions on the unchanged upgraded schema. It does not undo SQL
or durable effects, prove adjacent-pair backfill or contraction, or establish a
general rollback guarantee.

### Handle refusals from native destination SQL

Before applying the destination refusal forward, update callers of
`commerce_snapshot_destination_v2` and `commerce_read_destination_v2`.
The routines return expected refusals as a JSON result with
`outcome: "refused"`. Check that discriminator before reading success fields.
Use `code` and `field` to handle the case, and `fix` and `recheck` to guide
the next action. When your application owns a snapshot transaction, roll it
back before returning the refusal to the caller.

Handle `{ "evidenceDisposition": "erased" }` separately on an authorized
snapshot replay. Direct receipt routines still raise their existing SQL errors.
Unexpected database failures still raise an error.
