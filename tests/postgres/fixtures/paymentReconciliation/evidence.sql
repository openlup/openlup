BEGIN;
SELECT no_plan();
CREATE TEMP TABLE refund_stock(name text,id uuid);
WITH held AS (INSERT INTO public.fulfillment_inventory_reservations(purchase_order_id,operation_fingerprint,source_key,status,created_at,expires_at)
 SELECT (f->>'order')::uuid,repeat('a',64),'fixture','held','2026-11-13T12:00:00Z','2032-01-01T12:00:00Z' FROM proof_fixture WHERE name='capture' RETURNING id)
 INSERT INTO refund_stock SELECT 'held',id FROM held;
WITH consumed AS (INSERT INTO public.fulfillment_inventory_reservations(purchase_order_id,operation_fingerprint,source_key,status,created_at,expires_at)
 SELECT (f->>'order')::uuid,repeat('b',64),'fixture','consumed','2026-11-13T12:00:00Z','2032-01-01T12:00:00Z' FROM proof_fixture WHERE name='capture' RETURNING id)
 INSERT INTO refund_stock SELECT 'consumed',id FROM consumed;
WITH unrelated AS (INSERT INTO public.fulfillment_inventory_reservations(purchase_order_id,operation_fingerprint,source_key,status,created_at,expires_at)
 SELECT (f->>'order')::uuid,repeat('c',64),'fixture','held','2026-11-13T12:00:00Z','2032-01-01T12:00:00Z' FROM proof_fixture WHERE name='delta' RETURNING id)
 INSERT INTO refund_stock SELECT 'unrelated',id FROM unrelated;
SELECT is(public.payment_refund_readback((f->>'intent')::uuid),NULL::jsonb,'a capture alone is not refunded money') FROM proof_fixture WHERE name='capture';
SELECT is(public.commerce_order_provider_refund_evidence((f->>'order')::uuid),NULL::jsonb,'financial notice path has zero evidence before a proven refund') FROM proof_fixture WHERE name='capture';
SELECT is(pg_temp.refund_observe(f,'partial',3000)#>>'{paymentResult,status}','partially_refunded','a cumulative partial observation remains partial') FROM proof_fixture WHERE name='capture';
SELECT is(public.payment_refund_readback((f->>'intent')::uuid)->>'refundCents','3000','partial readback uses accepted same-currency evidence') FROM proof_fixture WHERE name='capture';
SELECT is(public.commerce_order_provider_refund_evidence((f->>'order')::uuid),NULL::jsonb,'partial cumulative evidence does not emit a full-refund notice') FROM proof_fixture WHERE name='capture';
SELECT is((SELECT status FROM public.fulfillment_inventory_reservations WHERE id=(SELECT id FROM refund_stock WHERE name='held')),'held','partial refund leaves held stock untouched');
SELECT is(pg_temp.refund_observe(f,'full',12999)#>>'{paymentResult,status}','refunded','a larger cumulative observation reaches the original payment amount') FROM proof_fixture WHERE name='capture';
SELECT is((SELECT status FROM public.fulfillment_inventory_reservations WHERE id=(SELECT id FROM refund_stock WHERE name='held')),'released','full one-time refund releases the order hold');
SELECT is((SELECT terminal_reason FROM public.fulfillment_inventory_reservations WHERE id=(SELECT id FROM refund_stock WHERE name='held')),'one_time_order_refunded','release retains the full-refund reason');
SELECT is((SELECT status FROM public.fulfillment_inventory_reservations WHERE id=(SELECT id FROM refund_stock WHERE name='consumed')),'consumed','full refund preserves consumed stock');
SELECT is((SELECT status FROM public.fulfillment_inventory_reservations WHERE id=(SELECT id FROM refund_stock WHERE name='unrelated')),'held','full refund preserves unrelated stock');
WITH held AS (INSERT INTO public.fulfillment_inventory_reservations(purchase_order_id,operation_fingerprint,source_key,status,created_at,expires_at)
 SELECT (f->>'order')::uuid,repeat('d',64),'fixture','held','2026-11-13T12:00:00Z','2032-01-01T12:00:00Z' FROM proof_fixture WHERE name='capture' RETURNING id)
 INSERT INTO refund_stock SELECT 'repair',id FROM held;
SELECT pg_temp.provider_apply('eventless-repair',(f->>'intent')::uuid,NULL,'refunded','2026-11-13T12:00:00Z',NULL) FROM proof_fixture WHERE name='capture';
SELECT is((SELECT status FROM public.fulfillment_inventory_reservations WHERE id=(SELECT id FROM refund_stock WHERE name='repair')),'released','eventless full-refund repair retains scoped stock release');
SELECT is(pg_temp.refund_observe(f,'older',3000)#>>'{paymentResult,kind}','ignored_stripe_refund_snapshot','an older cumulative snapshot is ignored') FROM proof_fixture WHERE name='capture';
SELECT is(pg_temp.refund_observe(f,'equal',12999)#>>'{paymentResult,kind}','ignored_stripe_refund_snapshot','an equal cumulative snapshot is ignored') FROM proof_fixture WHERE name='capture';
SELECT is(public.payment_refund_readback((f->>'intent')::uuid)->>'refundCents','12999','cumulative snapshots use their maximum rather than their sum') FROM proof_fixture WHERE name='capture';
SELECT is((SELECT amount_minor FROM public.commerce_settlement_intents WHERE id=(f->>'intent')::uuid),12999::bigint,'refunds preserve the original payment amount') FROM proof_fixture WHERE name='capture';
SELECT is((SELECT count(*)::integer FROM public.outbox_events WHERE aggregate_id=(f->>'order')::uuid AND event_type='commerce.order.refund_processed'),1,'full refund emits one financial notice') FROM proof_fixture WHERE name='capture';
SELECT is((SELECT payload->>'refundCents' FROM public.outbox_events WHERE aggregate_id=(f->>'order')::uuid AND event_type='commerce.order.refund_processed'),'12999','financial notice carries proven money') FROM proof_fixture WHERE name='capture';
SELECT is((SELECT count(*)::integer FROM public.outbox_events WHERE aggregate_id=(f->>'order')::uuid AND event_type='commerce.order.refunded'),1,'status projection keeps its separate identity') FROM proof_fixture WHERE name='capture';
SELECT ok((SELECT payload->>'refundCents' IS NULL FROM public.outbox_events WHERE aggregate_id=(f->>'order')::uuid AND event_type='commerce.order.refunded'),'status carrier makes no financial amount claim') FROM proof_fixture WHERE name='capture';
SELECT throws_ok(format('SELECT pg_temp.refund_observe(%L::jsonb,%L,12999,%L,true)',f,'thin','XXX'),'22023','payment_control_result_refund_snapshot_unproven','thin refund payloads do not infer money from the order') FROM proof_fixture WHERE name='capture';
SELECT throws_ok(format('SELECT pg_temp.refund_observe(%L::jsonb,%L,12999,%L)',f,'wrong-currency','XTS'),'22023','payment_control_result_currency_mismatch','different-currency evidence refuses') FROM proof_fixture WHERE name='capture';
SELECT is(pg_temp.refund_observe(f,'delta-one',3000)#>>'{paymentResult,status}','partially_refunded','individual observations retain their delta meaning') FROM proof_fixture WHERE name='delta';
SELECT pg_temp.refund_observe(f,'delta-two',12999) FROM proof_fixture WHERE name='delta';
SELECT is(public.payment_refund_readback((f->>'intent')::uuid)->>'refundCents','15999','individual-event amounts retain addition') FROM proof_fixture WHERE name='delta';
SELECT pg_temp.refund_observe(f,'renewal-refund',12999) FROM proof_fixture WHERE name='renewal';
SELECT is((SELECT status FROM public.subscriptions WHERE id=(f->>'subscription')::uuid),'active','a renewal refund keeps the subscription active') FROM proof_fixture WHERE name='renewal';
SELECT is((SELECT status FROM public.subscription_cycles WHERE id=(f->>'cycle')::uuid),'paid','refunds preserve paid cycle history') FROM proof_fixture WHERE name='renewal';
SELECT is((SELECT count(*)::integer FROM public.subscription_pause_windows WHERE subscription_id=(f->>'subscription')::uuid),0,'refunds never schedule a pause') FROM proof_fixture WHERE name='renewal';

UPDATE public.payment_provider_attempts SET created_at='2026-11-13T10:00:00Z',updated_at='2026-11-13T10:00:00Z'
 WHERE id IN (SELECT (f->>'attempt')::uuid FROM proof_fixture WHERE name IN ('prepared','interactive'));
UPDATE public.payment_provider_states SET created_at='2026-11-13T10:00:00Z',updated_at='2026-11-13T10:00:00Z'
 WHERE id IN (SELECT (f->>'intent')::uuid FROM proof_fixture WHERE name IN ('prepared','interactive'));
CREATE TEMP TABLE claimed AS SELECT * FROM public.commerce_payment_reconciliation_claim_prepared_attempts('2026-11-13T12:00:00Z',900,50,'prepared-claim');
SELECT is((SELECT count(*)::integer FROM claimed),2,'prepared watchdog claims both supported recorded contexts');
SELECT is((SELECT count(*)::integer FROM public.commerce_payment_reconciliation_claim_prepared_attempts('2026-11-13T12:00:00Z',900,50,'prepared-claim')),0,'a claim key never claims the same prepared attempt twice');
SELECT is((SELECT status FROM public.payment_provider_attempts WHERE id=(f->>'attempt')::uuid),'created','watchdog claims have no financial or dispatch effect') FROM proof_fixture WHERE name='prepared';
SELECT throws_ok(format('SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(%L,%L,%L,%L,%L,%L,%L,%L::jsonb)',
 'absence-no-proof',f->>'attempt',f->>'intent',f->>'cycle','operator.fixture','2026-11-13T12:00:00Z','2026-11-13T12:10:00Z','{}'),
 '22023','prepared_attempt_absence_reopen_requires_provider_absence_proof','elapsed time without provider proof never reopens') FROM proof_fixture WHERE name='prepared';
SELECT lives_ok(format('SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(%L,%L,%L,%L,%L,%L,%L,%L::jsonb)',
 'absence-proven',f->>'attempt',f->>'intent',f->>'cycle','operator.fixture','2026-11-13T12:00:00Z','2026-11-13T12:10:00Z','{"providerAbsenceConfirmed":true}'),
 'exact absence reopens only the recorded attempt') FROM proof_fixture WHERE name='prepared';
SELECT is((SELECT provider_attempt_sequence FROM public.payment_provider_states WHERE id=(f->>'intent')::uuid),1,'absence advances the provider sequence once') FROM proof_fixture WHERE name='prepared';
SELECT is(public.commerce_payment_control_reopen_prepared_attempt_after_absence('absence-proven',(f->>'attempt')::uuid,(f->>'intent')::uuid,(f->>'cycle')::uuid,
 'operator.fixture','2026-11-13T12:00:00Z','2026-11-13T12:10:00Z','{"providerAbsenceConfirmed":true}')#>>'{preparedAttemptReopen,replayed}','true','absence replay retains the canonical response') FROM proof_fixture WHERE name='prepared';
SELECT is((SELECT provider_attempt_sequence FROM public.payment_provider_states WHERE id=(f->>'intent')::uuid),1,'absence replay does not mint another sequence') FROM proof_fixture WHERE name='prepared';
SELECT is((SELECT status FROM public.subscription_cycles WHERE id=(f->>'cycle')::uuid),'payment_pending','absence preserves native cycle semantics') FROM proof_fixture WHERE name='prepared';
SELECT is((SELECT count(*)::integer FROM public.subscription_retry_receipts WHERE input->>'paymentAttemptId'=f->>'attempt'),0,'absence does not consume a failure rung or preparation receipt') FROM proof_fixture WHERE name='prepared';
SELECT is(public.payment_prepared_absence_reopen_due((f->>'intent')::uuid,'2026-11-13T12:00:00Z'),NULL::jsonb,'due-reopen readback respects the recorded schedule') FROM proof_fixture WHERE name='prepared';
SELECT is(public.payment_prepared_absence_reopen_due((f->>'intent')::uuid,'2026-11-13T12:10:00Z','consume-once')->>'provider_attempt_sequence','1','due receipt supplies the exact new sequence') FROM proof_fixture WHERE name='prepared';
SELECT is(public.payment_prepared_absence_reopen_due((f->>'intent')::uuid,'2026-11-13T12:10:00Z','another-consumer'),NULL::jsonb,'another consumer cannot reuse a consumed receipt') FROM proof_fixture WHERE name='prepared';
SELECT is(public.payment_prepared_absence_reopen_due((f->>'intent')::uuid,'2026-11-13T12:10:00Z','consume-once')->>'consumed_key','consume-once','the same consumer replays its durable consumption') FROM proof_fixture WHERE name='prepared';
INSERT INTO proof_fixture VALUES('other-interactive',pg_temp.reconciliation_fixture('stripe',false,false));
SELECT throws_ok(format('SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(%L,%L,%L,%L,NULL,NULL,%L,%L,%L,%L,%L,%L,%L::jsonb)',
 'interactive-other-provider',f->>'attempt',f->>'intent',f->>'order','manual_provider_absence','provider_absence_confirmed','operator_reconciliation','operator_verified_absence','operator.fixture','2026-11-13T12:00:00Z','{"providerAbsenceConfirmed":true,"watchdogEvidence":true,"evidenceCode":"operator_verified_absence"}'),
 '22023','interactive_prepared_attempt_reopen_provider_not_supported','interactive reopening retains its provider restriction') FROM proof_fixture WHERE name='other-interactive';
SELECT is((SELECT count(*)::integer FROM public.payment_provider_reconciliation_runs WHERE payment_attempt_id=(f->>'attempt')::uuid AND provider_status='prepared_attempt_provider_absent'),1,'absence correction is recorded once') FROM proof_fixture WHERE name='prepared';
SELECT ok(NOT has_function_privilege('authenticated','public.payment_refund_readback(uuid)','EXECUTE'),'browser roles cannot read financial evidence');
SELECT ok(NOT has_table_privilege('authenticated','public.payment_refund_evidence','INSERT'),'browser roles cannot manufacture accepted refund evidence');
SELECT * FROM finish();
ROLLBACK;
