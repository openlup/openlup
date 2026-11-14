BEGIN;
SELECT plan(8);
SELECT is(public.fulfillment_dispatch_outcome('{"kind":"not_dispatched","error":{"code":"bad_request","status":400,"retryable":false,"submissionAttempted":true,"responseBodyRead":true,"message":"private diagnostic"}}'),
 '{"classification":"failed","code":"bad_request","status":400,"retryable":false,"mayHaveSucceeded":false,"submissionAttempted":true,"responseBodyRead":true}'::jsonb,
 'definite rejection retains only neutral diagnostics');
SELECT is(public.fulfillment_dispatch_outcome('{"kind":"unknown","error":{"code":"network_error","status":null,"retryable":false,"submissionAttempted":true,"responseBodyRead":false}}'),
 '{"classification":"uncertain","code":"network_error","status":null,"retryable":false,"mayHaveSucceeded":true,"submissionAttempted":true,"responseBodyRead":false}'::jsonb,
 'unreadable rejection remains uncertain');
SELECT is(public.fulfillment_dispatch_outcome('{"kind":"unknown","error":{"code":"https://private.invalid/path","status":999}}')->>'code','operation_failed','arbitrary diagnostic prose is not a machine code');
SELECT is(public.fulfillment_dispatch_outcome('{"kind":"unknown","error":{"code":"timeout","status":400.5}}')->'status','null'::jsonb,'nonintegral status is omitted');
SELECT ok(NOT (public.fulfillment_dispatch_outcome('{"kind":"unknown"}') ? 'submissionAttempted'),'unknown submission fact remains absent');
SELECT is(public.fulfillment_dispatch_outcome('{"kind":"accepted"}')->>'classification','uncertain','uncommitted accepted proof remains uncertain');
SELECT ok(NOT has_function_privilege('anon','public.fulfillment_record_operator_attempt(text,uuid,text,text,jsonb,jsonb,text,uuid,jsonb)','EXECUTE'),'anonymous role cannot record operator attempts');
SELECT ok(NOT has_function_privilege('authenticated','public.fulfillment_native_dispatch_begin(uuid,text)','EXECUTE'),'customer role cannot begin dispatch');
SELECT * FROM finish();
ROLLBACK;
