BEGIN;
SELECT plan(19);

SELECT is((SELECT count(*) FROM public.tax_coverage_read_v1('store-a','account-a')), 0::bigint, 'starts with no revision');
CREATE TEMP TABLE appended AS
SELECT * FROM public.tax_coverage_append_v1('{
  "installationRef":"store-a","accountRef":"account-a","expectedRevision":null,"actorRef":"operator-a",
  "coverage":{"schemaVersion":1,"accountRef":"account-a","revision":"one","declarations":[]}
}');
SELECT is((SELECT sequence_no FROM appended), 1, 'first sequence is one');
SELECT is((SELECT to_jsonb(a) FROM appended a),
  (SELECT to_jsonb(a) FROM public.tax_coverage_append_v1('{
    "installationRef":"store-a","accountRef":"account-a","expectedRevision":null,"actorRef":"operator-b",
    "coverage":{"schemaVersion":1,"accountRef":"account-a","revision":"one","declarations":[]}
  }') a), 'replay preserves the original recorded actor and time');
SELECT throws_ok(
  $$SELECT public.tax_coverage_append_v1('{
    "installationRef":"store-a","accountRef":"account-a","expectedRevision":null,"actorRef":"operator-a",
    "coverage":{"schemaVersion":1,"accountRef":"account-a","revision":"two","declarations":[]}
  }')$$, '22023', 'tax_coverage_revision_conflict', 'changed successor conflicts');
SELECT throws_ok(
  $$SELECT public.tax_coverage_append_v1('{
    "installationRef":"store-a","accountRef":"account-a","expectedRevision":"one","actorRef":"operator-a",
    "coverage":{"schemaVersion":1,"accountRef":"foreign","revision":"two","declarations":[]}
  }')$$, '22023', 'tax_invalid_input', 'mismatched account refuses');
SELECT is((SELECT count(*) FROM public.tax_coverage_revisions), 1::bigint, 'refusals leave the ledger untouched');
SELECT throws_ok('UPDATE public.tax_coverage_revisions SET actor_ref=''operator-b''', '55000',
  'tax_coverage_revision_immutable', 'normal owner updates refuse');
SELECT throws_ok('DELETE FROM public.tax_coverage_revisions', '55000',
  'tax_coverage_revision_immutable', 'normal owner deletes refuse');
SELECT is((SELECT count(*) FROM pg_constraint WHERE conrelid='public.tax_coverage_revisions'::regclass
  AND contype='f'), 0::bigint, 'installation history has no customer or other parent');
SELECT is((SELECT count(*) FROM public.client_absorption_policy WHERE table_name='tax_coverage_revisions'),
  0::bigint, 'no client absorption entry');

SET LOCAL ROLE service_role;
SELECT is((SELECT revision FROM public.tax_coverage_read_v1('store-a','account-a')), 'one', 'runtime reads through the definer');
SELECT throws_ok($$SELECT public.tax_coverage_append_v1('{}')$$, '42501',
  'permission denied for function tax_coverage_append_v1', 'runtime cannot append');
SELECT throws_ok($$SELECT public.tax_coverage_validate('{}')$$, '42501',
  'permission denied for function tax_coverage_validate', 'runtime cannot call the validator');
SELECT throws_ok('SELECT * FROM public.tax_coverage_revisions', '42501',
  'permission denied for table tax_coverage_revisions', 'runtime has no table access');
SELECT throws_ok('DELETE FROM public.tax_coverage_revisions', '42501',
  'permission denied for table tax_coverage_revisions', 'runtime has no table write access');


SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.tax_coverage_read_v1('store-a','account-a')$$, '42501',
  'permission denied for function tax_coverage_read_v1', 'anonymous reads refuse');
SELECT throws_ok('SELECT * FROM public.tax_coverage_revisions', '42501',
  'permission denied for table tax_coverage_revisions', 'anonymous table access refuses');

SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.tax_coverage_read_v1('store-a','account-a')$$, '42501',
  'permission denied for function tax_coverage_read_v1', 'browser reads refuse');
SELECT throws_ok('SELECT * FROM public.tax_coverage_revisions', '42501',
  'permission denied for table tax_coverage_revisions', 'browser table access refuses');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
