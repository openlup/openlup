-- pgTAP: hosted pre-alias canary for the delivery-alignment rail.
--
-- WHY THIS FILE EXISTS, SEPARATELY FROM subscription_delivery_alignment_test.sql
--
-- The full file proves the two-session admission/delivery race, and it does that
-- honestly: it opens a second session back into the same database with a `dblink_connect`
-- carrying the local test stack's own superuser credential. The file is therefore
-- runnable only where that stack runs. Pointed at a hosted database the second session is
-- refused on authentication before any assertion executes - which is exactly how it
-- blocked every staging deploy.
--
-- The race is a property of the SQL functions, not of the environment, and the local
-- lane proves it on every CI run. What a pre-alias gate needs to prove is narrower and
-- genuinely environment-bound: that the migrations which just landed produced the rail
-- the application code expects, and that its control surface answers. That is what this
-- file asserts, with no second session and no credential of any kind.
--
-- Everything here is transactional and rolled back, including the extension create, so
-- no environment keeps state or an extension that no migration declares.

BEGIN;
-- The local runner supplies this; a hosted database does not have it, and `plan()`
-- cannot resolve without it. Rolled back with the rest of this transaction.
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(18);

-- 1. The rail's own objects exist after the migration that just applied.
SELECT has_table('public', 'subscription_delivery_alignment_control',
  'alignment control table exists');
SELECT has_table('public', 'subscription_delivery_alignment_cases',
  'alignment cases table exists');

SELECT has_function('public', 'subscription_delivery_alignment_get_mode',
  'get_mode exists');
SELECT has_function('public', 'subscription_delivery_alignment_set_mode',
  'set_mode exists');
SELECT has_function('public', 'subscription_delivery_alignment_admit_renewal',
  'admit_renewal exists');
SELECT has_function('public', 'subscription_delivery_alignment_on_delivery',
  'on_delivery exists');
SELECT has_function('public', 'subscription_delivery_alignment_guard_cycle_insert',
  'guard_cycle_insert exists');
SELECT has_function('public', 'subscription_delivery_alignment_open_exception_case',
  'open_exception_case exists');
SELECT has_function('public', 'subscription_delivery_alignment_record_allowed_receipt',
  'record_allowed_receipt exists');
SELECT has_function('public', 'subscription_delivery_alignment_resolve_case',
  'resolve_case exists');
SELECT has_function('public', 'subscription_delivery_alignment_confirm_replacement',
  'confirm_replacement exists - the operator exit for a substitute shipment');
SELECT has_function('public', 'subscription_delivery_alignment_upsert_case',
  'upsert_case exists');

-- 2. The control row is a real singleton, not an empty or duplicated table. A missing
--    row would make get_mode return NULL and every caller read an absent mode as "off"
--    without saying so.
SELECT is(
  (SELECT count(*)::int FROM public.subscription_delivery_alignment_control),
  1,
  'exactly one alignment control row');

-- 3. The deployed mode is inside the declared vocabulary.
SELECT ok(
  public.subscription_delivery_alignment_get_mode()
    IN ('off', 'shadow', 'protect', 'auto_align'),
  'deployed mode is within the pinned vocabulary');

-- 4. The control surface answers: every declared mode round-trips through set/get.
--    This is the property the compensating rollback depends on - if set_mode('off')
--    could not be read back, the deploy would have no kill switch.
SELECT is(
  (SELECT public.subscription_delivery_alignment_get_mode()
     FROM (SELECT public.subscription_delivery_alignment_set_mode('shadow')) AS _s),
  'shadow',
  'set_mode shadow round-trips');
SELECT is(
  (SELECT public.subscription_delivery_alignment_get_mode()
     FROM (SELECT public.subscription_delivery_alignment_set_mode('auto_align')) AS _s),
  'auto_align',
  'set_mode auto_align round-trips');
SELECT is(
  (SELECT public.subscription_delivery_alignment_get_mode()
     FROM (SELECT public.subscription_delivery_alignment_set_mode('off')) AS _s),
  'off',
  'set_mode off round-trips - the rollback path has a reachable kill switch');

-- 5. The vocabulary is enforced, not merely documented, so a typo cannot silently
--    un-gate the rail.
SELECT throws_ok(
  $$SELECT public.subscription_delivery_alignment_set_mode('not_a_mode')$$,
  NULL,
  'set_mode refuses a mode outside the vocabulary');

SELECT * FROM finish();

-- Machine-checkable verdict as the LAST statement, deliberately.
--
-- The hosted query path returns only the final statement's rows, so the TAP stream -
-- including the `1..N` plan line that `plan()` emits first - is not visible to the
-- caller. A gate that greps the stream can therefore never see it. `num_failed()`
-- carries the verdict and `_get('curr_test')` carries how many assertions actually ran,
-- so a file that dies halfway cannot report success by simply having failed nothing.
SELECT
  num_failed()::int AS failed_assertions,
  _get('curr_test')::int AS ran_assertions;

ROLLBACK;
