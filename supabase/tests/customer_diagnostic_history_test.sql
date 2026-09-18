-- pgTAP: bounded durable customer diagnostics, identity rotation and audited reads.

BEGIN;
SELECT plan(115);

SELECT has_table('public', 'customer_diagnostic_segments', 'diagnostic segments exist');
SELECT has_table('public', 'customer_diagnostic_events', 'diagnostic events exist');
SELECT has_table('public', 'customer_diagnostic_ingress_attempts', 'admission attempts exist');
SELECT has_table('public', 'customer_diagnostic_access_events', 'retained access audit exists');
SELECT has_function('public', 'customer_diagnostic_ingest_v1',
  ARRAY['text','text','uuid','uuid','uuid','uuid','text','text','text','integer','text','text','text','text','integer'],
  'the atomic ingest signature includes principal and canonical subject separately');
SELECT has_function('public', 'customer_diagnostic_search_v1',
  ARRAY['uuid','timestamp with time zone','timestamp with time zone','uuid','text','text','text','integer','text','integer'],
  'the bounded search exists');
SELECT is(has_table_privilege('anon', 'public.customer_diagnostic_events', 'SELECT'), false,
  'anonymous callers cannot read history tables');
SELECT is(has_function_privilege('authenticated',
  'public.customer_diagnostic_ingest_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,integer,text,text,text,text,integer)', 'EXECUTE'), false,
  'browser identities cannot bypass the server ingest boundary');

INSERT INTO public.platform_communication_operators(principal_id, active) VALUES
  ('10000000-0000-4000-8000-000000000001', true),
  ('10000000-0000-4000-8000-000000000002', false);

CREATE TEMP TABLE diagnostic_results(name text PRIMARY KEY, result jsonb NOT NULL) ON COMMIT DROP;

INSERT INTO diagnostic_results VALUES ('anonymous', public.customer_diagnostic_ingest_v1(
  NULL, repeat('a',64), NULL, NULL,
  '20000000-0000-4000-8000-000000000001', NULL,
  'entry_boot','settled','failed',NULL,NULL,'request:anon',repeat('b',64),repeat('c',64),7));

SELECT is((SELECT result->>'outcome' FROM diagnostic_results WHERE name='anonymous'), 'committed',
  'any valid observation can bootstrap an anonymous segment');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_segments), 1,
  'bootstrap creates one segment');

INSERT INTO diagnostic_results VALUES ('anonymous-replay', public.customer_diagnostic_ingest_v1(
  repeat('a',64), repeat('d',64), NULL, NULL,
  '20000000-0000-4000-8000-000000000001', NULL,
  'entry_boot','settled','failed',NULL,NULL,'request:anon-replay',repeat('b',64),repeat('c',64),7));
SELECT is((SELECT result->>'deduplicated' FROM diagnostic_results WHERE name='anonymous-replay'), 'true',
  'same event and fingerprint replay without a second append');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_events), 1,
  'replay leaves one immutable event');
SELECT throws_ok($$SELECT public.customer_diagnostic_ingest_v1(
  repeat('a',64), repeat('e',64), NULL, NULL,
  '20000000-0000-4000-8000-000000000001'::uuid, NULL,
  'entry_boot','settled','failed',NULL,NULL,'request:conflict',repeat('b',64),repeat('f',64),7)$$,
  '23505', 'customer_diagnostic_event_conflict', 'changed replay conflicts');

INSERT INTO diagnostic_results VALUES ('verified', public.customer_diagnostic_ingest_v1(
  repeat('a',64), repeat('1',64),
  '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002', NULL,
  'auth_bootstrap','settled','timeout',18,NULL,'request:verified',repeat('b',64),repeat('2',64),7));
SELECT is((SELECT principal_id::text || '|' || subject_id::text FROM public.customer_diagnostic_segments
  WHERE credential_hash=repeat('1',64)),
  '30000000-0000-4000-8000-000000000001|40000000-0000-4000-8000-000000000001',
  'verified principal and canonical customer subject remain distinct');
SELECT is((SELECT subject_id::text FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('a',64)),
  NULL, 'login does not rewrite the anonymous predecessor');
SELECT is((SELECT predecessor_relation FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('1',64)),
  'same_tab_pre_auth_context', 'login links pre-auth context without claiming authorship');

INSERT INTO diagnostic_results VALUES ('unresolved-profile', public.customer_diagnostic_ingest_v1(
  repeat('1',64), repeat('3',64),
  '30000000-0000-4000-8000-000000000001', NULL,
  '20000000-0000-4000-8000-000000000003', NULL,
  'auth_bootstrap','settled','profile_unavailable',10,NULL,'request:profile',repeat('b',64),repeat('4',64),7));
SELECT is((SELECT principal_id::text || '|' || COALESCE(subject_id::text,'unresolved')
  FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('3',64)),
  '30000000-0000-4000-8000-000000000001|unresolved',
  'profile failure is retained as verified principal-only in a fresh segment');

INSERT INTO diagnostic_results VALUES ('account-switch', public.customer_diagnostic_ingest_v1(
  repeat('3',64), repeat('5',64),
  '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000006', NULL,
  'auth_bootstrap','settled','session_present',4,NULL,'request:switch',repeat('b',64),repeat('5',64),7));
SELECT is((SELECT principal_id::text || '|' || subject_id::text FROM public.customer_diagnostic_segments
  WHERE credential_hash=repeat('5',64)),
  '30000000-0000-4000-8000-000000000002|40000000-0000-4000-8000-000000000002',
  'a different verified account receives a fresh segment');
SELECT is((SELECT close_reason FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('3',64)),
  'auth_changed', 'account switching closes the prior principal-only segment');

INSERT INTO diagnostic_results VALUES ('logout', public.customer_diagnostic_ingest_v1(
  repeat('5',64), repeat('6',64), NULL,NULL,
  '20000000-0000-4000-8000-000000000007',NULL,
  'auth_bootstrap','settled','session_absent',3,NULL,'request:logout',repeat('b',64),repeat('6',64),7));
SELECT is((SELECT principal_id::text FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('6',64)),
  NULL, 'logout creates a fresh anonymous segment');
SELECT is((SELECT close_reason FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('5',64)),
  'logout', 'logout closes the account segment without relabelling it');

CREATE TEMP TABLE search_result AS SELECT public.customer_diagnostic_search_v1(
  '10000000-0000-4000-8000-000000000001', now()-interval '1 hour', now()+interval '1 hour',
  '40000000-0000-4000-8000-000000000001', NULL,NULL,NULL,25,NULL,7) AS result;
SELECT is((SELECT result #>> '{segments,0,subjectId}' FROM search_result),
  '40000000-0000-4000-8000-000000000001', 'support search uses the canonical customer subject');
SELECT is((SELECT count(*)::integer FROM search_result,
  jsonb_array_elements(result->'segments') segment WHERE segment->>'subjectId' <> '40000000-0000-4000-8000-000000000001'),
  0, 'a canonical subject filter excludes the other verified account');
SELECT is((SELECT result->'sourceHealth' FROM search_result),
  '{"read":"available","delivery":"unknown"}'::jsonb,
  'a successful read reports database availability without claiming browser delivery health');
SELECT is((SELECT result->'loss' FROM search_result),
  '{"status":"unknown","reason":"browser_delivery_not_measurable"}'::jsonb,
  'the query cannot infer missing browser observations from stored rows');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_access_events WHERE operation='search'), 1,
  'successful search is retained in the access audit');
SELECT throws_ok($$SELECT public.customer_diagnostic_search_v1(
  '10000000-0000-4000-8000-000000000002'::uuid, now()-interval '1 hour', now(),
  NULL,NULL,NULL,NULL,25,NULL,7)$$, '42501', 'communications_operator_inactive',
  'inactive operators cannot read diagnostics');

CREATE FUNCTION pg_temp.reject_diagnostic_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'diagnostic_audit_unavailable' USING ERRCODE='55000'; END; $$;
CREATE TRIGGER reject_diagnostic_audit BEFORE INSERT ON public.customer_diagnostic_access_events
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_diagnostic_audit();
SELECT throws_ok($$SELECT public.customer_diagnostic_segment_v1(
  '10000000-0000-4000-8000-000000000001'::uuid,
  (SELECT id FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('1',64)), 100,NULL,7)$$,
  '55000', 'diagnostic_audit_unavailable', 'history is fail-closed when retained audit cannot commit');
DROP TRIGGER reject_diagnostic_audit ON public.customer_diagnostic_access_events;

DELETE FROM public.customer_diagnostic_ingress_attempts;
INSERT INTO public.customer_diagnostic_ingress_attempts(abuse_key_hash)
SELECT repeat('9',64) FROM generate_series(1,120);
INSERT INTO diagnostic_results VALUES ('limited', public.customer_diagnostic_ingest_v1(
  NULL, repeat('e',64), NULL,NULL,
  '20000000-0000-4000-8000-000000000004',NULL,
  'entry_hydration','entered','observed',NULL,NULL,'request:limited',repeat('9',64),repeat('6',64),7));
SELECT is((SELECT result->>'outcome' FROM diagnostic_results WHERE name='limited'), 'rate_limited',
  'bucket admission refuses excess traffic');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_ingress_attempts), 120,
  'rejected traffic cannot grow the durable admission table');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('e',64)), 0,
  'rejected admission cannot issue a segment');

SELECT throws_ok($$SELECT public.customer_diagnostic_ingest_v1(
  NULL, repeat('7',64), NULL, '40000000-0000-4000-8000-000000000001'::uuid,
  '20000000-0000-4000-8000-000000000005'::uuid,NULL,
  'entry_boot','entered','observed',NULL,NULL,'request:badidentity',repeat('8',64),repeat('7',64),7)$$,
  '22023', 'customer_diagnostic_ingest_invalid', 'a canonical subject without verified principal is impossible');
SELECT throws_ok($$SELECT public.customer_diagnostic_ingest_v1(
  NULL, repeat('7',64), NULL,NULL,
  '20000000-0000-4000-8000-000000000005'::uuid,NULL,
  NULL,'entered','observed',NULL,NULL,'request:nullaction',repeat('8',64),repeat('7',64),7)$$,
  '22023', 'customer_diagnostic_ingest_invalid', 'null action cannot bypass SQL validation');

SELECT has_function('public', 'customer_diagnostic_ingest_v2',
  ARRAY['text','text','uuid','uuid','uuid','uuid','text','text','text','integer','text','text','text','text','integer','text'],
  'the additive v2 ingest keeps transport arguments and adds explicit coverage');
SELECT is((SELECT coverage_version FROM public.customer_diagnostic_events WHERE client_event_key='20000000-0000-4000-8000-000000000001'),
  'purchase-auth-account.v1', 'v1 append receives the retained default coverage');
INSERT INTO diagnostic_results VALUES ('v1-hydration-success', public.customer_diagnostic_ingest_v1(
  NULL, repeat('c',64), NULL,NULL, '20000000-0000-4000-8000-000000000008',NULL,
  'entry_hydration','settled','succeeded',NULL,NULL,'request:v1-hydration',repeat('b',64),repeat('8',64),7));
SELECT is((SELECT result->>'outcome' FROM diagnostic_results WHERE name='v1-hydration-success'), 'committed',
  'v1 retains the historical hydration success combination');
SELECT throws_ok($$SELECT public.customer_diagnostic_ingest_v2(
  NULL, repeat('d',64), NULL,NULL, '20000000-0000-4000-8000-000000000009',NULL,
  'entry_hydration','settled','succeeded',NULL,NULL,'request:v2-hydration',repeat('b',64),repeat('9',64),7,'purchase-auth-account.v2')$$,
  '22023', 'customer_diagnostic_ingest_invalid', 'v2 rejects the false hydration success combination');
INSERT INTO diagnostic_results VALUES ('v2', public.customer_diagnostic_ingest_v2(
  NULL, repeat('f',64), NULL,NULL, '20000000-0000-4000-8000-000000000010',NULL,
  'entry_boot','settled','failed',NULL,NULL,'request:v2',repeat('b',64),repeat('0',64),7,'purchase-auth-account.v2'));
SELECT is((SELECT coverage_version FROM public.customer_diagnostic_events WHERE client_event_key='20000000-0000-4000-8000-000000000010'),
  'purchase-auth-account.v2', 'v2 stores coverage on the event itself');
SELECT is(has_function_privilege('anon',
  'public.customer_diagnostic_ingest_v2(text,text,uuid,uuid,uuid,uuid,text,text,text,integer,text,text,text,text,integer,text)', 'EXECUTE'), false,
  'anonymous callers cannot execute v2 ingest');
SELECT is(has_function_privilege('authenticated',
  'public.customer_diagnostic_search_v2(uuid,timestamptz,timestamptz,uuid,text,text,text,integer,text,integer)', 'EXECUTE'), false,
  'authenticated callers cannot execute v2 operator reads');
SELECT throws_ok($$SELECT public.customer_diagnostic_ingest_v1(
  repeat('f',64), repeat('e',64), NULL,NULL, '20000000-0000-4000-8000-000000000010',NULL,
  'entry_boot','settled','failed',NULL,NULL,'request:cross-v2-v1',repeat('b',64),repeat('0',64),7)$$,
  '23505', 'customer_diagnostic_event_conflict', 'v1 conflicts with a v2 replay even when a caller reuses its fingerprint');
INSERT INTO diagnostic_results VALUES ('v1-after-v2', public.customer_diagnostic_ingest_v1(
  repeat('f',64), repeat('e',64), NULL,NULL, '20000000-0000-4000-8000-000000000011',NULL,
  'entry_boot','settled','failed',NULL,NULL,'request:v1-after-v2',repeat('b',64),repeat('1',64),7));
SELECT throws_ok($$SELECT public.customer_diagnostic_ingest_v2(
  repeat('f',64), repeat('2',64), NULL,NULL, '20000000-0000-4000-8000-000000000011',NULL,
  'entry_boot','settled','failed',NULL,NULL,'request:cross-v1-v2',repeat('b',64),repeat('1',64),7,'purchase-auth-account.v2')$$,
  '23505', 'customer_diagnostic_event_conflict', 'v2 conflicts with a v1 replay even when a caller reuses its fingerprint');
CREATE TEMP TABLE search_v1_after_v2_result AS SELECT public.customer_diagnostic_search_v1(
  '10000000-0000-4000-8000-000000000001', now()-interval '1 hour', now()+interval '1 hour',
  NULL,'entry_boot',NULL,NULL,25,NULL,7) AS result;
SELECT is((SELECT result->>'contractVersion' FROM search_v1_after_v2_result),
  'customer-diagnostic-history.v1', 'v1 search retains its v1 response contract');
SELECT is((SELECT result->>'coverageVersion' FROM search_v1_after_v2_result),
  'purchase-auth-account.v1', 'v1 search retains its response-wide v1 coverage');
SELECT is((SELECT COALESCE(sum((group_row->>'eventCount')::integer), 0)::integer
  FROM search_v1_after_v2_result, jsonb_array_elements(result->'groups') group_row), 2,
  'v1 search excludes v2 events after both versions share history');
CREATE TEMP TABLE segment_v1_mixed_result AS SELECT public.customer_diagnostic_segment_v1(
  '10000000-0000-4000-8000-000000000001',
  (SELECT id FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('f',64)), 100,NULL,7) AS result;
SELECT is((SELECT result->>'contractVersion' FROM segment_v1_mixed_result),
  'customer-diagnostic-history.v1', 'v1 segment retains its v1 response contract');
SELECT is((SELECT result->>'coverageVersion' FROM segment_v1_mixed_result),
  'purchase-auth-account.v1', 'v1 segment retains its response-wide v1 coverage');
SELECT is((SELECT jsonb_array_length(result->'events') FROM segment_v1_mixed_result), 1,
  'v1 segment excludes the co-located v2 event while retaining its v1 shape');
CREATE TEMP TABLE search_v2_result AS SELECT public.customer_diagnostic_search_v2(
  '10000000-0000-4000-8000-000000000001', now()-interval '1 hour', now()+interval '1 hour',
  NULL,NULL,NULL,NULL,25,NULL,7) AS result;
SELECT is((SELECT result->>'contractVersion' FROM search_v2_result),
  'customer-diagnostic-history.v2', 'mixed search uses the v2 response contract');
SELECT ok((SELECT NOT (result ? 'coverageVersion') FROM search_v2_result),
  'mixed search has no response-wide coverage label');
SELECT is((SELECT count(DISTINCT group_row->>'coverageVersion')::integer FROM search_v2_result, jsonb_array_elements(result->'groups') group_row
  WHERE group_row->>'coverageVersion' IN ('purchase-auth-account.v1','purchase-auth-account.v2')), 2,
  'v2 search groups retain both stored coverage versions without relabelling');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_access_events WHERE operation='search'), 3,
  'v2 search commits its access audit before returning mixed history');
CREATE TEMP TABLE segment_v2_result AS SELECT public.customer_diagnostic_segment_v2(
  '10000000-0000-4000-8000-000000000001',
  (SELECT id FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('f',64)), 100,NULL,7) AS result;
SELECT is((SELECT result->>'contractVersion' FROM segment_v2_result),
  'customer-diagnostic-history.v2', 'mixed segment uses the v2 response contract');
SELECT ok((SELECT NOT (result ? 'coverageVersion') FROM segment_v2_result),
  'mixed segment has no response-wide coverage label');
SELECT is((SELECT count(*)::integer FROM segment_v2_result, jsonb_array_elements(result->'events') event_row
  WHERE event_row->>'coverageVersion' IN ('purchase-auth-account.v1','purchase-auth-account.v2')), 2,
  'v2 segment exposes mixed stored event coverage without a response-level relabel');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_access_events WHERE operation='history'), 2,
  'v2 segment commits its access audit before returning history');

-- A segment older than the configured retention window, so the lifetime cap is
-- observable: started_at + 7 days lands two days out while now + 7 days does not.
INSERT INTO public.customer_diagnostic_segments(credential_hash, started_at, last_seen_at, expires_at)
VALUES (repeat('7',63)||'b', now()-interval '5 days', now()-interval '5 days', now()+interval '7 days');
INSERT INTO diagnostic_results VALUES ('v2-rotation', public.customer_diagnostic_ingest_v2(
  repeat('7',63)||'b', repeat('8',63)||'b', NULL,NULL, '20000000-0000-4000-8000-000000000012',NULL,
  'entry_boot','settled','failed',NULL,NULL,'request:v2-rotate',repeat('b',64),repeat('2',63)||'b',7,'purchase-auth-account.v2'));
SELECT is((SELECT result->>'credentialDisposition' FROM diagnostic_results WHERE name='v2-rotation'), 'rotated',
  'a committed non-duplicate v2 reuse reports a rotated credential rather than a reused one');
SELECT is((SELECT result->>'deduplicated' FROM diagnostic_results WHERE name='v2-rotation'), 'false',
  'the rotating reuse is a genuine append, not a replay');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('7',63)||'b'), 0,
  'the presented credential no longer resolves to any segment once it has been rotated');
SELECT is((SELECT id::text FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('8',63)||'b'),
  (SELECT result->>'segmentId' FROM diagnostic_results WHERE name='v2-rotation'),
  'the issued credential addresses the same continuing segment');
INSERT INTO diagnostic_results VALUES ('v2-rotation-replay', public.customer_diagnostic_ingest_v2(
  repeat('8',63)||'b', repeat('9',63)||'b', NULL,NULL, '20000000-0000-4000-8000-000000000012',NULL,
  'entry_boot','settled','failed',NULL,NULL,'request:v2-rotate-replay',repeat('b',64),repeat('2',63)||'b',7,'purchase-auth-account.v2'));
SELECT is((SELECT result->>'credentialDisposition' FROM diagnostic_results WHERE name='v2-rotation-replay'), 'reused',
  'a replayed beacon keeps the credential it presented instead of rotating it');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('9',63)||'b'), 0,
  'a replay cannot install the credential it offered');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_events
  WHERE client_event_key='20000000-0000-4000-8000-000000000012'), 1,
  'the replayed beacon appends no second event');
SELECT ok((SELECT expires_at <= started_at + interval '7 days' FROM public.customer_diagnostic_segments
  WHERE credential_hash=repeat('8',63)||'b'),
  'a reused segment cannot be carried past its own start plus configured retention');
SELECT ok((SELECT bool_and(e.expires_at <= s.started_at + interval '7 days')
  FROM public.customer_diagnostic_events e JOIN public.customer_diagnostic_segments s ON s.id = e.segment_id
  WHERE s.credential_hash=repeat('8',63)||'b'),
  'every event appended to a capped segment expires no later than its segment window');

SELECT throws_ok($$INSERT INTO public.customer_diagnostic_events(
  segment_id, client_event_key, payload_fingerprint, coverage_version, action, phase, code,
  reported_request_id, ingest_request_id, expires_at
) VALUES (
  (SELECT id FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('8',63)||'b'),
  '20000000-0000-4000-8000-000000000013'::uuid, repeat('3',63)||'b', 'purchase-auth-account.v2',
  'entry_boot','settled','failed', 'checkout failed for maria at 14:05', 'request:freetext',
  now()+interval '1 day')$$,
  '23514', NULL, 'free text cannot be stored as a browser-reported request reference');
SELECT lives_ok($$INSERT INTO public.customer_diagnostic_events(
  segment_id, client_event_key, payload_fingerprint, coverage_version, action, phase, code,
  reported_request_id, ingest_request_id, expires_at
)
SELECT (SELECT id FROM public.customer_diagnostic_segments WHERE credential_hash=repeat('8',63)||'b'),
  key, repeat('3',63)||'b', 'purchase-auth-account.v2', 'entry_boot','settled','failed',
  reference, 'request:vocabulary', now()+interval '1 day'
  FROM (VALUES
    ('20000000-0000-4000-8000-000000000014'::uuid, 'A1B2C3D4-1111-4111-8111-111111111111'),
    ('20000000-0000-4000-8000-000000000015'::uuid, 'bff-axiom-canary-checkout-shared'),
    ('20000000-0000-4000-8000-000000000016'::uuid, 'iad1::sfo1::edge-request')
  ) AS accepted(key, reference)$$,
  'the closed vocabulary still admits a reporter UUID, the Axiom canary and a hosted request id');
SELECT throws_ok($$SELECT public.customer_diagnostic_ingest_v2(
  NULL, repeat('a',63)||'b', NULL,NULL, '20000000-0000-4000-8000-000000000017'::uuid,NULL,
  'entry_boot','settled','failed',NULL,'checkout failed for maria at 14:05','request:v2-freetext',
  repeat('b',64),repeat('4',63)||'b',7,'purchase-auth-account.v2')$$,
  '22023', 'customer_diagnostic_ingest_invalid',
  'the v2 ingest mirrors the table vocabulary and refuses a free-text reference before it is stored');

SELECT has_function('public', 'customer_diagnostic_overview_v2',
  ARRAY['uuid','timestamp with time zone','timestamp with time zone','integer','text','integer'],
  'the global bounded v2 overview exists');
SELECT ok(
  pg_get_indexdef('public.customer_diagnostic_events_overview_idx'::regclass)
    LIKE '%(received_at, coverage_version, action, phase, action_id, segment_id)%'
  AND pg_get_indexdef('public.customer_diagnostic_events_overview_idx'::regclass)
    LIKE '%INCLUDE (code, expires_at)%',
  'the overview index keys every window column the matching CTE reads and includes code and expiry');
SELECT is(has_function_privilege('anon',
  'public.customer_diagnostic_overview_v2(uuid,timestamptz,timestamptz,integer,text,integer)', 'EXECUTE'), false,
  'anonymous callers cannot execute overview');
SELECT is(has_function_privilege('authenticated',
  'public.customer_diagnostic_overview_v2(uuid,timestamptz,timestamptz,integer,text,integer)', 'EXECUTE'), false,
  'authenticated callers cannot execute overview');

INSERT INTO public.customer_diagnostic_segments(id, credential_hash, started_at, last_seen_at, expires_at) VALUES
  ('90000000-0000-4000-8000-000000000001', repeat('a',63)||'9', now()-interval '4 days', now()-interval '2 days', now()+interval '3 days'),
  ('90000000-0000-4000-8000-000000000002', repeat('b',63)||'9', now()-interval '4 days', now()-interval '2 days', now()+interval '3 days'),
  ('90000000-0000-4000-8000-000000000003', repeat('c',63)||'9', now()-interval '4 days', now()-interval '2 days', now()+interval '3 days'),
  ('90000000-0000-4000-8000-000000000004', repeat('d',63)||'9', now()-interval '4 days', now()-interval '2 days', now()+interval '3 days');

INSERT INTO public.customer_diagnostic_events(
  id, segment_id, action_id, client_event_key, client_action_key, payload_fingerprint,
  coverage_version, action, phase, code, ingest_request_id, received_at, expires_at
) VALUES
  ('e1000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',repeat('1',64),'purchase-auth-account.v2','checkout_submit','attempted','observed','overview:a1:start',now()-interval '3 days 10 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001',repeat('2',64),'purchase-auth-account.v2','checkout_submit','settled','failed','overview:a1:failed',now()-interval '3 days 9 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000001',repeat('3',64),'purchase-auth-account.v2','checkout_submit','settled','failed','overview:a1:duplicate',now()-interval '3 days 8 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000004','90000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000002',repeat('4',64),'purchase-auth-account.v2','checkout_submit','attempted','observed','overview:a2:start',now()-interval '3 days 7 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000005','90000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000003',repeat('5',64),'purchase-auth-account.v2','checkout_submit','attempted','observed','overview:a3:start',now()-interval '3 days 6 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000006','90000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-000000000006','a1000000-0000-4000-8000-000000000003',repeat('6',64),'purchase-auth-account.v2','checkout_submit','settled','failed','overview:a3:failed',now()-interval '3 days 5 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000007','90000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-000000000007','a1000000-0000-4000-8000-000000000003',repeat('7',64),'purchase-auth-account.v2','checkout_submit','settled','timeout','overview:a3:timeout',now()-interval '3 days 4 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000008','90000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000004','e1000000-0000-4000-8000-000000000008','a1000000-0000-4000-8000-000000000004',repeat('8',64),'purchase-auth-account.v2','checkout_submit','settled','rejected','overview:a4:terminal',now()-interval '3 days 3 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000009','90000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000005','e1000000-0000-4000-8000-000000000009','a1000000-0000-4000-8000-000000000005',repeat('9',64),'purchase-auth-account.v2','checkout_submit','attempted','observed','overview:a5:start',now()-interval '3 days 2 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000005','e1000000-0000-4000-8000-000000000010','a1000000-0000-4000-8000-000000000005',repeat('a',64),'purchase-auth-account.v2','checkout_submit','settled','failed','overview:a5:failed',now()-interval '3 days 1 minute',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000011','90000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000006','e1000000-0000-4000-8000-000000000011','a1000000-0000-4000-8000-000000000006',repeat('b',64),'purchase-auth-account.v2','checkout_submit','attempted','observed','overview:a6:start',now()-interval '3 days',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000012','90000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000006','e1000000-0000-4000-8000-000000000012','a1000000-0000-4000-8000-000000000006',repeat('c',64),'purchase-auth-account.v2','checkout_submit','settled','failed','overview:a6:failed',now()-interval '2 days 23 hours 59 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000013','90000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000007','e1000000-0000-4000-8000-000000000013','a1000000-0000-4000-8000-000000000007',repeat('d',64),'purchase-auth-account.v2','checkout_submit','attempted','observed','overview:a7:start',now()-interval '2 days 23 hours 58 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000014','90000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000007','e1000000-0000-4000-8000-000000000014','a1000000-0000-4000-8000-000000000007',repeat('e',64),'purchase-auth-account.v2','checkout_submit','settled','failed','overview:a7:failed',now()-interval '2 days 23 hours 57 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000015','90000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000015','b1000000-0000-4000-8000-000000000001',repeat('f',64),'purchase-auth-account.v2','account_refresh','refresh_started','observed','overview:refresh:start',now()-interval '2 days 23 hours 56 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000016','90000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000016','b1000000-0000-4000-8000-000000000001',repeat('0',64),'purchase-auth-account.v2','account_refresh','refresh_settled','refresh_failed','overview:refresh:failed',now()-interval '2 days 23 hours 55 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000017','90000000-0000-4000-8000-000000000001',NULL,'e1000000-0000-4000-8000-000000000017',NULL,repeat('1',64),'purchase-auth-account.v2','entry_boot','entered','observed','overview:entry',now()-interval '2 days 23 hours 54 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000018','90000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000018','c1000000-0000-4000-8000-000000000001',repeat('2',64),'purchase-auth-account.v2','payment_confirm','settled','failed','overview:payment:failed',now()-interval '2 days 23 hours 53 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000019','90000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000019','c1000000-0000-4000-8000-000000000001',repeat('3',64),'purchase-auth-account.v2','payment_confirm','settled','succeeded','overview:payment:succeeded',now()-interval '2 days 23 hours 52 minutes',now()+interval '3 days'),
  ('e1000000-0000-4000-8000-000000000020','90000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000020','c1000000-0000-4000-8000-000000000001',repeat('4',64),'purchase-auth-account.v2','payment_confirm','settled','failed','overview:payment:failed-again',now()-interval '2 days 23 hours 51 minutes',now()+interval '3 days');

CREATE TEMP TABLE overview_result AS SELECT public.customer_diagnostic_overview_v2(
  '10000000-0000-4000-8000-000000000001', now()-interval '4 days', now()-interval '2 days', 25, NULL, 7
) AS result;
SELECT is((SELECT result->>'contractVersion' FROM overview_result), 'customer-diagnostic-history.v2',
  'overview retains the explicit v2 contract');
SELECT is((SELECT result->'sourceHealth' FROM overview_result),
  '{"read":"available","delivery":"unknown"}'::jsonb,
  'overview reports database availability without claiming browser delivery');
SELECT is((SELECT result->'loss' FROM overview_result),
  '{"status":"unknown","reason":"browser_delivery_not_measurable"}'::jsonb,
  'overview keeps missing browser delivery unknowable');
SELECT is((SELECT result->>'windowCoverage' FROM overview_result), 'full',
  'a window inside configured retention is fully retained');
SELECT is((SELECT result->>'evidencePresence' FROM overview_result), 'observed',
  'stored rows are reported independently from retention coverage');
SELECT is((SELECT jsonb_array_length(result->'groups')::integer FROM overview_result), 4,
  'the window reports every retained coverage/action pair, including the settled-only payment lane');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_access_events WHERE operation='overview'), 1,
  'overview commits its own retained access audit');
SELECT is((SELECT group_row->>'attemptedActionCount' FROM overview_result,
  jsonb_array_elements(result->'groups') group_row WHERE group_row->>'action'='checkout_submit'), '6',
  'attempt denominator counts distinct started actions despite duplicate terminals');
SELECT is((SELECT bucket->>'actionCount' FROM overview_result,
  jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'terminalOutcomes') bucket
  WHERE group_row->>'action'='checkout_submit' AND bucket->>'classification'='failed'), '4',
  'same-code duplicates count once while distinct failed actions remain visible');
SELECT is((SELECT jsonb_array_length(bucket->'exampleSegmentIds') FROM overview_result,
  jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'terminalOutcomes') bucket
  WHERE group_row->>'action'='checkout_submit' AND bucket->>'classification'='failed'), 3,
  'each outcome bucket returns at most three deterministic example segments');
SELECT is((SELECT bucket->>'actionCount' FROM overview_result,
  jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'terminalOutcomes') bucket
  WHERE group_row->>'action'='checkout_submit' AND bucket->>'classification'='observation_gap'), '1',
  'a started action without terminal evidence is an observation gap');
SELECT is((SELECT bucket->>'actionCount' FROM overview_result,
  jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'terminalOutcomes') bucket
  WHERE group_row->>'action'='checkout_submit' AND bucket->>'classification'='conflicting_terminal'), '1',
  'different terminal codes for one action remain a visible conflict');
SELECT is((SELECT bucket->>'actionCount' FROM overview_result,
  jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'terminalOutcomes') bucket
  WHERE group_row->>'action'='checkout_submit' AND bucket->>'classification'='terminalWithoutStart'), '1',
  'a terminal without an in-window start stays outside the denominator');
SELECT is((SELECT group_row->>'attemptedActionCount' FROM overview_result,
  jsonb_array_elements(result->'groups') group_row WHERE group_row->>'action'='account_refresh'), '1',
  'account refresh uses refresh_started as its distinct action denominator');
SELECT is((SELECT bucket->>'actionCount' FROM overview_result,
  jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'terminalOutcomes') bucket
  WHERE group_row->>'action'='account_refresh' AND bucket->>'classification'='refresh_failed'), '1',
  'refresh failure remains separate from the preceding committed mutation');
SELECT ok((SELECT group_row->>'rateApplicability'='not_applicable'
  AND group_row->'attemptedActionCount'='null'::jsonb FROM overview_result,
  jsonb_array_elements(result->'groups') group_row WHERE group_row->>'action'='entry_boot'),
  'observation-only actions do not fabricate an attempt rate');
SELECT is((SELECT lifecycle->>'eventCount' FROM overview_result,
  jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'staticLifecycle') lifecycle
  WHERE group_row->>'action'='entry_boot' AND lifecycle->>'phase'='entered' AND lifecycle->>'code'='observed'), '1',
  'observation-only lifecycle is returned as static event evidence');
SELECT ok((SELECT lifecycle->'actionCount'='null'::jsonb FROM overview_result,
  jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'staticLifecycle') lifecycle
  WHERE group_row->>'action'='entry_boot' AND lifecycle->>'phase'='entered' AND lifecycle->>'code'='observed'),
  'a static bucket carrying no action ids reports a null action count rather than zero');
SELECT is((SELECT sum((bucket->>'actionCount')::integer)::integer FROM overview_result,
  jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'terminalOutcomes') bucket
  WHERE group_row->>'action'='checkout_submit' AND bucket->>'classification'<>'terminalWithoutStart'),
  (SELECT (group_row->>'attemptedActionCount')::integer FROM overview_result,
  jsonb_array_elements(result->'groups') group_row WHERE group_row->>'action'='checkout_submit'),
  'every attempted checkout action lands in exactly one bucket inside the denominator');
SELECT ok((SELECT group_row->>'rateApplicability'='not_applicable'
  AND group_row->'attemptedActionCount'='null'::jsonb
  AND group_row->'terminalOutcomes'='[]'::jsonb FROM overview_result,
  jsonb_array_elements(result->'groups') group_row WHERE group_row->>'action'='payment_confirm'),
  'a settled-only payment observation carries no fabricated attempt denominator or outcome rate');
SELECT is((SELECT jsonb_agg(jsonb_build_object(
    'phase', lifecycle->>'phase', 'code', lifecycle->>'code',
    'eventCount', lifecycle->'eventCount', 'actionCount', lifecycle->'actionCount')
    ORDER BY lifecycle->>'code')
  FROM overview_result, jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'staticLifecycle') lifecycle
  WHERE group_row->>'action'='payment_confirm'),
  '[{"code":"failed","phase":"settled","eventCount":2,"actionCount":1},
    {"code":"succeeded","phase":"settled","eventCount":1,"actionCount":1}]'::jsonb,
  'a repeated payment terminal counts two events but one distinct action in its static bucket');
SELECT is((SELECT count(*)::integer FROM overview_result,
  jsonb_array_elements(result->'groups') group_row,
  jsonb_array_elements(group_row->'terminalOutcomes') bucket
  WHERE group_row->>'action'='payment_confirm' AND bucket->>'classification'='terminalWithoutStart'), 0,
  'a settled-only payment group never reports a terminal without an in-window start');

ANALYZE public.customer_diagnostic_events;
SET LOCAL enable_seqscan = off;
CREATE TEMP TABLE overview_window_plan(line text);
DO $overview_plan$
DECLARE v_line text;
BEGIN
  FOR v_line IN EXECUTE $plan_sql$
    EXPLAIN (FORMAT TEXT)
    SELECT e.segment_id, e.action_id, e.coverage_version, e.action, e.phase, e.code, e.received_at
      FROM public.customer_diagnostic_events e
      JOIN public.customer_diagnostic_segments s ON s.id = e.segment_id
     WHERE e.received_at >= now()-interval '4 days'
       AND e.received_at < now()-interval '2 days'
       AND e.expires_at > now()
       AND s.expires_at > now()
     ORDER BY e.received_at, e.coverage_version, e.action
  $plan_sql$ LOOP
    INSERT INTO overview_window_plan(line) VALUES (v_line);
  END LOOP;
END
$overview_plan$;
SELECT ok((SELECT count(*) > 0 FROM overview_window_plan
  WHERE line LIKE '%customer_diagnostic_events_overview_idx%'),
  'the overview window read plans through its own index when a sequential scan is disabled');
RESET enable_seqscan;

CREATE TEMP TABLE overview_page_one AS SELECT public.customer_diagnostic_overview_v2(
  '10000000-0000-4000-8000-000000000001', now()-interval '4 days', now()-interval '2 days', 1, NULL, 7
) AS result;
SELECT ok((SELECT (result->>'truncated')::boolean AND result->>'nextCursor'='1'
  AND result #>> '{groups,0,action}'='account_refresh' FROM overview_page_one),
  'overview paginates deterministic coverage/action groups');
CREATE TEMP TABLE overview_page_two AS SELECT public.customer_diagnostic_overview_v2(
  '10000000-0000-4000-8000-000000000001', now()-interval '4 days', now()-interval '2 days', 1, '1', 7
) AS result;
SELECT is((SELECT result #>> '{groups,0,action}' FROM overview_page_two), 'checkout_submit',
  'overview cursor resumes at the next coverage/action group');
CREATE TEMP TABLE overview_exhausted AS SELECT public.customer_diagnostic_overview_v2(
  '10000000-0000-4000-8000-000000000001', now()-interval '4 days', now()-interval '2 days', 1, '9999999', 7
) AS result;
SELECT ok((SELECT result->>'evidencePresence'='observed' AND result->'groups'='[]'::jsonb
  AND NOT (result->>'truncated')::boolean AND result->'nextCursor'='null'::jsonb FROM overview_exhausted),
  'an exhausted page preserves global evidence state while returning no page groups');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_access_events WHERE operation='overview'), 4,
  'each overview page, including an exhausted page, commits its own access audit');

CREATE TEMP TABLE overview_empty AS SELECT public.customer_diagnostic_overview_v2(
  '10000000-0000-4000-8000-000000000001', now()+interval '1 day', now()+interval '2 days', 25, NULL, 7
) AS result;
SELECT ok((SELECT result->>'evidencePresence'='empty' AND result->'groups'='[]'::jsonb
  AND result->>'windowCoverage'='full' FROM overview_empty),
  'empty evidence remains distinct from an unavailable or expired read');
CREATE TEMP TABLE overview_expired AS SELECT public.customer_diagnostic_overview_v2(
  '10000000-0000-4000-8000-000000000001', now()-interval '10 days', now()-interval '9 days', 25, NULL, 7
) AS result;
SELECT is((SELECT result->>'windowCoverage' FROM overview_expired), 'expired',
  'a window before the configured retention boundary is explicitly expired');
CREATE TEMP TABLE overview_partial AS SELECT public.customer_diagnostic_overview_v2(
  '10000000-0000-4000-8000-000000000001', now()-interval '8 days', now()-interval '6 days', 25, NULL, 7
) AS result;
SELECT is((SELECT result->>'windowCoverage' FROM overview_partial), 'partial',
  'a window crossing the configured retention boundary is explicitly partial');
SELECT throws_ok($$SELECT public.customer_diagnostic_overview_v2(
  '10000000-0000-4000-8000-000000000002'::uuid, now()-interval '1 hour', now(), 25, NULL, 7)$$,
  '42501', 'communications_operator_inactive',
  'inactive operators learn nothing from overview');

CREATE TRIGGER reject_diagnostic_audit BEFORE INSERT ON public.customer_diagnostic_access_events
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_diagnostic_audit();
SELECT throws_ok($$SELECT public.customer_diagnostic_overview_v2(
  '10000000-0000-4000-8000-000000000001'::uuid, now()-interval '4 days', now()-interval '2 days', 25, NULL, 7)$$,
  '55000', 'diagnostic_audit_unavailable',
  'overview returns no aggregate when its audit cannot commit');
DROP TRIGGER reject_diagnostic_audit ON public.customer_diagnostic_access_events;

-- Retention boundaries the governed prune caller depends on. The block below
-- already proves that an all-expired corpus drains in one bounded call; what a
-- scheduled drain additionally needs is that it keeps what has not expired.
SELECT throws_ok($$SELECT public.customer_diagnostic_prune_v1(0)$$,
  '22023', 'customer_diagnostic_prune_invalid',
  'a batch size below the supported floor is refused rather than silently clamped');
SELECT throws_ok($$SELECT public.customer_diagnostic_prune_v1(501)$$,
  '22023', 'customer_diagnostic_prune_invalid',
  'a batch size above the 500-row ceiling is refused rather than silently clamped');

INSERT INTO diagnostic_results VALUES ('retention-fourteen', public.customer_diagnostic_ingest_v2(
  NULL, repeat('f',63)||'e', NULL,NULL, '20000000-0000-4000-8000-000000000031',NULL,
  'entry_boot','settled','failed',NULL,NULL,'request:retention-14',repeat('f',64),repeat('6',63)||'e',14,
  'purchase-auth-account.v2'));
SELECT is((SELECT expires_at = received_at + interval '14 days' FROM public.customer_diagnostic_events
  WHERE client_event_key='20000000-0000-4000-8000-000000000031'), true,
  'the configured fourteen-day retention is stamped on the row at ingest, not applied on read');

CREATE TEMP TABLE prune_boundary_before AS
  SELECT (SELECT count(*)::integer FROM public.customer_diagnostic_ingress_attempts) AS attempts;
UPDATE public.customer_diagnostic_ingress_attempts SET occurred_at=now()-interval '3 minutes'
 WHERE id=(SELECT id FROM public.customer_diagnostic_ingress_attempts ORDER BY occurred_at, id LIMIT 1);
UPDATE public.customer_diagnostic_segments SET expires_at=now()-interval '1 second'
 WHERE credential_hash=repeat('f',63)||'e';
CREATE TEMP TABLE prune_boundary AS SELECT public.customer_diagnostic_prune_v1(500) result;
SELECT is((SELECT (result->>'eventsDeleted')::integer FROM prune_boundary), 0,
  'a prune running today removes no event that has not yet reached its own expiry');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_events
  WHERE client_event_key='20000000-0000-4000-8000-000000000031'), 1,
  'the event stamped fourteen days out survives the same bounded prune');
SELECT is((SELECT (result->>'limitsDeleted')::integer FROM prune_boundary), 1,
  'the admission bucket is aged on its own two-minute window, independently of any retention expiry');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_ingress_attempts),
  (SELECT attempts - 1 FROM prune_boundary_before),
  'admission rows still inside the two-minute window are left in place by the same call');
SELECT is((SELECT (result->>'segmentsDeleted')::integer FROM prune_boundary), 0,
  'an expired segment is not collected while it still owns a live event');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_segments
  WHERE credential_hash=repeat('f',63)||'e'), 1,
  'that segment and the retained event it owns both remain readable after the prune');

UPDATE public.customer_diagnostic_events SET expires_at=now()-interval '1 second';
UPDATE public.customer_diagnostic_segments SET expires_at=now()-interval '1 second';
UPDATE public.customer_diagnostic_access_events SET expires_at=now()-interval '1 second';
UPDATE public.customer_diagnostic_ingress_attempts SET occurred_at=now()-interval '3 minutes';
CREATE TEMP TABLE prune_result AS SELECT public.customer_diagnostic_prune_v1(500) result;
SELECT ok((SELECT (result->>'eventsDeleted')::integer > 0 AND (result->>'segmentsDeleted')::integer > 0
  AND (result->>'limitsDeleted')::integer > 0 AND (result->>'accessDeleted')::integer > 0 FROM prune_result),
  'bounded prune removes expired history, access audit, limits and empty segments');
SELECT is((SELECT count(*)::integer FROM public.customer_diagnostic_events), 0,
  'expired diagnostic events are physically deleted');

SELECT * FROM finish();
ROLLBACK;
