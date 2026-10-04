-- pgTAP: the operator contact correction, and the linked-account fence it removes.
--
-- The delta this suite proves is a *removal*: the e-mail correction used to refuse
-- every subject with an `auth_user_id`, which is every customer who checked out.
-- So the load-bearing assertion here is an admission, not a refusal - and because
-- an admission is the easy thing to make pass by accident, every refusal arm the
-- correction still owes is pinned alongside it: a stale expectation, a
-- `lower(email)` collision, a deactivated operator, and a phone that is not E.164.
--
-- Refusals are pinned as *returned and audited*, not raised. The receipt and audit
-- inserts sit at the end of both routines, so a raise past them would leave a
-- refused command with no record at all - which is the failure mode that made the
-- earlier alignment bug invisible.

BEGIN;
SELECT plan(26);

-- One active operator and one deactivated, so every gate assertion has its pair.
INSERT INTO public.platform_communication_operators (principal_id, active)
VALUES
  ('06a00000-0000-4000-8000-000000000001', true),
  ('06a00000-0000-4000-8000-000000000002', false);

INSERT INTO auth.users (id)
VALUES ('06000000-0000-4000-8000-000000000001');

-- Linked. Under the old fence this subject could never be corrected; it is the
-- whole point of the wave that it can be now.
INSERT INTO public.clients (id, email, phone, auth_user_id)
VALUES (
  '06100000-0000-4000-8000-000000000001',
  'contact-correction-linked@example.invalid',
  '+48500100200',
  '06000000-0000-4000-8000-000000000001'
);

-- Unlinked, to prove the pre-existing path did not regress.
INSERT INTO public.clients (id, email, phone, auth_user_id)
VALUES (
  '06100000-0000-4000-8000-000000000002',
  'contact-correction-unlinked@example.invalid',
  NULL,
  NULL
);

-- Holds an address, so a correction onto it must collide by name.
INSERT INTO public.clients (id, email, auth_user_id)
VALUES (
  '06100000-0000-4000-8000-000000000003',
  'contact-correction-taken@example.invalid',
  NULL
);

-- ---------------------------------------------------------------------------
-- The removed fence: a linked subject is corrected, and the response says so.
-- ---------------------------------------------------------------------------

SELECT is(
  public.customer_support_correct_subject_email_v1(
    '06a00000-0000-4000-8000-000000000001',
    '06100000-0000-4000-8000-000000000001',
    'contact-correction-linked@example.invalid',
    'contact-correction-moved@example.invalid',
    'contact-correction-email-linked-1',
    now()
  )->>'outcome',
  'applied',
  'a linked subject is corrected instead of refused as subject_account_linked'
);

SELECT is(
  (SELECT email FROM public.clients WHERE id = '06100000-0000-4000-8000-000000000001'),
  'contact-correction-moved@example.invalid',
  'the corrected address is stored lowercased and trimmed'
);

SELECT is(
  (SELECT response->>'authUserLinked'
     FROM public.customer_support_subscription_commands
    WHERE idempotency_key = 'contact-correction-email-linked-1'),
  'true',
  'authUserLinked reports the observed linkage rather than the old literal false'
);

SELECT is(
  (SELECT outcome || '|' || COALESCE(value_before, '-') || '|' || COALESCE(value_after, '-')
     FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'contact-correction-email-linked-1'),
  'applied|contact-correction-linked@example.invalid|contact-correction-moved@example.invalid',
  'the audit row carries both the address before and the address after'
);

SELECT is(
  (SELECT operator_id::text
     FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'contact-correction-email-linked-1'),
  '06a00000-0000-4000-8000-000000000001',
  'the audit row names the operator who acted'
);

-- Replay of the settled key returns `replayed`, not a second mutation.
SELECT is(
  public.customer_support_correct_subject_email_v1(
    '06a00000-0000-4000-8000-000000000001',
    '06100000-0000-4000-8000-000000000001',
    'contact-correction-linked@example.invalid',
    'contact-correction-moved@example.invalid',
    'contact-correction-email-linked-1',
    now()
  )->>'outcome',
  'replayed',
  'the settled idempotency key replays rather than correcting twice'
);

SELECT is(
  (SELECT count(*)::int FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'contact-correction-email-linked-1'),
  1,
  'the replay writes no second audit row'
);

-- ---------------------------------------------------------------------------
-- Refusal arms the correction still owes.
-- ---------------------------------------------------------------------------

SELECT is(
  public.customer_support_correct_subject_email_v1(
    '06a00000-0000-4000-8000-000000000001',
    '06100000-0000-4000-8000-000000000002',
    'contact-correction-unlinked@example.invalid',
    'contact-correction-taken@example.invalid',
    'contact-correction-email-collision-1',
    now()
  )->>'refusalCode',
  'email_already_in_use',
  'a lower(email) collision is refused by name, not raised as 23505'
);

SELECT is(
  (SELECT outcome FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'contact-correction-email-collision-1'),
  'conflict',
  'the collision refusal is audited rather than lost'
);

SELECT is(
  (SELECT email FROM public.clients WHERE id = '06100000-0000-4000-8000-000000000002'),
  'contact-correction-unlinked@example.invalid',
  'the refused subject keeps its address'
);

SELECT is(
  public.customer_support_correct_subject_email_v1(
    '06a00000-0000-4000-8000-000000000001',
    '06100000-0000-4000-8000-000000000002',
    'not-the-current-address@example.invalid',
    'contact-correction-fresh@example.invalid',
    'contact-correction-email-stale-1',
    now()
  )->>'refusalCode',
  'email_expectation_conflict',
  'a stale expectation is refused so a blind replay cannot overwrite a newer value'
);

SELECT throws_ok(
  $$SELECT public.customer_support_correct_subject_email_v1(
      '06a00000-0000-4000-8000-000000000002',
      '06100000-0000-4000-8000-000000000002',
      'contact-correction-unlinked@example.invalid',
      'contact-correction-nope@example.invalid',
      'contact-correction-email-deactivated-1',
      now())$$,
  '42501',
  NULL,
  'a deactivated operator is refused before any customer state is read'
);

-- ---------------------------------------------------------------------------
-- The phone correction: the number the fulfillment dispatch actually reads.
-- ---------------------------------------------------------------------------

SELECT has_function(
  'public', 'customer_support_correct_subject_phone_v1',
  ARRAY['uuid', 'uuid', 'text', 'text', 'text', 'timestamptz'],
  'the phone correction exists with the operator id first, as every operator routine does'
);

SELECT is(
  public.customer_support_correct_subject_phone_v1(
    '06a00000-0000-4000-8000-000000000001',
    '06100000-0000-4000-8000-000000000001',
    '+48500100200',
    '+48507231665',
    'contact-correction-phone-1',
    now()
  )->>'outcome',
  'applied',
  'the phone is corrected for a linked subject'
);

SELECT is(
  (SELECT phone FROM public.clients WHERE id = '06100000-0000-4000-8000-000000000001'),
  '+48507231665',
  'the corrected number is stored as given, in E.164'
);

SELECT is(
  (SELECT command_kind FROM public.customer_support_subscription_commands
    WHERE idempotency_key = 'contact-correction-phone-1'),
  'phone_correction',
  'the widened command_kind admits the phone correction on the receipt ledger'
);

SELECT is(
  (SELECT command_kind || '|' || COALESCE(value_before, '-') || '|' || COALESCE(value_after, '-')
     FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'contact-correction-phone-1'),
  'phone_correction|+48500100200|+48507231665',
  'the audit row carries the number before and after under the widened kind'
);

SELECT is(
  public.customer_support_correct_subject_phone_v1(
    '06a00000-0000-4000-8000-000000000001',
    '06100000-0000-4000-8000-000000000001',
    '+48507231665',
    '+48507231665',
    'contact-correction-phone-noop-1',
    now()
  )->>'outcome',
  'noop',
  'correcting a number to the value it already holds is a noop, not a write'
);

SELECT throws_ok(
  $$SELECT public.customer_support_correct_subject_phone_v1(
      '06a00000-0000-4000-8000-000000000001',
      '06100000-0000-4000-8000-000000000001',
      '+48507231665',
      '507231665',
      'contact-correction-phone-bare-1',
      now())$$,
  '22023',
  NULL,
  'a bare national number is refused: E.164 is the shape the dispatch payload carries'
);

SELECT throws_ok(
  $$SELECT public.customer_support_correct_subject_phone_v1(
      '06a00000-0000-4000-8000-000000000001',
      '06100000-0000-4000-8000-000000000001',
      '+48507231665',
      '+48 507 231 665',
      'contact-correction-phone-spaced-1',
      now())$$,
  '22023',
  NULL,
  'a spaced number is refused rather than silently stored unnormalized'
);

SELECT is(
  public.customer_support_correct_subject_phone_v1(
    '06a00000-0000-4000-8000-000000000001',
    '06100000-0000-4000-8000-000000000001',
    '+48000000000',
    '+48511222333',
    'contact-correction-phone-stale-1',
    now()
  )->>'refusalCode',
  'phone_expectation_conflict',
  'a stale phone expectation is refused for the same reason the e-mail one is'
);

SELECT is(
  (SELECT phone FROM public.clients WHERE id = '06100000-0000-4000-8000-000000000001'),
  '+48507231665',
  'the refused phone correction leaves the stored number untouched'
);

SELECT throws_ok(
  $$SELECT public.customer_support_correct_subject_phone_v1(
      '06a00000-0000-4000-8000-000000000002',
      '06100000-0000-4000-8000-000000000001',
      '+48507231665',
      '+48511222333',
      'contact-correction-phone-deactivated-1',
      now())$$,
  '42501',
  NULL,
  'the phone correction asks the same operator gate as every other operator routine'
);

SELECT is(
  public.customer_support_correct_subject_phone_v1(
    '06a00000-0000-4000-8000-000000000001',
    '06100000-0000-4000-8000-000000000002',
    NULL,
    '+48512000111',
    'contact-correction-phone-null-1',
    now()
  )->>'outcome',
  'applied',
  'a subject with no number yet is corrected from a NULL expectation'
);

-- ---------------------------------------------------------------------------
-- Neither routine needs privilege escalation; that is the wave's cost assumption.
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT prosecdef FROM pg_catalog.pg_proc
    WHERE oid = 'public.customer_support_correct_subject_phone_v1(uuid,uuid,text,text,text,timestamptz)'::regprocedure),
  false,
  'the phone correction runs with invoker rights: service_role already holds what it writes'
);

SELECT is(
  (SELECT prosecdef FROM pg_catalog.pg_proc
    WHERE oid = 'public.customer_support_correct_subject_email_v1(uuid,uuid,text,text,text,timestamptz)'::regprocedure),
  false,
  'the e-mail correction dropped SECURITY DEFINER with the fence that needed it'
);

SELECT * FROM finish();
ROLLBACK;
