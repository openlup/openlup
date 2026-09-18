-- pgTAP: no SECURITY DEFINER function in `public` that decides the acting principal from a
-- caller-supplied identity parameter may be executable by a browser role.
--
-- This is the durable net for the renamed-carrier class. 20260817091500 closed nine
-- functions by name and browser_role_execute_revocation_test.sql pins those nine. But that
-- proof is a fixed list, and the class recurs precisely because a rename carries an ACL past
-- a REVOKE that only named the old identity. So the central assertion here is not a name
-- list: it reads the live catalog for every SECURITY DEFINER `public` function whose
-- parameter names include an identity (auth_user_id / client_id / actor_id / operator_id /
-- principal_id / subject_id, with or without the `p_` convention prefix) and fails, naming
-- the offenders, if any of them is executable by `anon` or `authenticated`. The next renamed
-- carrier trips it the moment it exists, with no edit to this file.
--
-- The three carriers 20260824170000 revokes are also pinned by name, so a regression that
-- re-opens exactly one of them is reported as itself rather than folded into the invariant.
--
-- A second whole-catalog invariant was added by 20260830160000, for the class the first one
-- deliberately excludes. `subscription_current_template_snapshot(p_subscription_id)` showed
-- that the exclusion of resource ids is only safe while the body checks *something*: that
-- function locked the subscription row `FOR UPDATE` and consulted no principal at all, so a
-- caller-supplied resource UUID was the entire credential. Widening the identity list to
-- include `subscription_id`/`order_id` would flood -- measured against the live catalog it
-- matches many legitimately public functions -- so the second invariant is predicated on
-- the dangerous shape instead: definer, takes a resource id, locks or writes, consults
-- neither `auth.uid()` nor `current_client_id()`, and is browser-executable. That predicate
-- matched exactly one function before 20260830160000 and none after it.
BEGIN;
SELECT plan(8);

-- The identity-parameter surface, spelled once. A definer function that lets the caller name
-- the principal is the whole hazard; a resource id (order_id, subscription_id) is a different
-- class and is intentionally not matched here.
CREATE TEMP TABLE identity_param (name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO identity_param (name) VALUES
  ('auth_user_id'), ('client_id'), ('actor_id'), ('operator_id'), ('principal_id'), ('subject_id');

-- The whole-catalog invariant: offending identities are the ones this proof exists to forbid.
SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM (
       SELECT format('%s(%s)', p.oid::regproc::text, pg_get_function_identity_arguments(p.oid)) AS ident
         FROM pg_proc AS p
         JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosecdef
          AND p.proargnames IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM unnest(p.proargnames) AS an(argname)
              JOIN identity_param AS ip ON ip.name = regexp_replace(an.argname, '^p_', '')
          )
          AND (
            has_function_privilege('anon', p.oid, 'execute')
            OR has_function_privilege('authenticated', p.oid, 'execute')
          )
     ) AS offenders),
  '',
  'no SECURITY DEFINER public function taking an identity parameter is executable by anon or authenticated'
);

-- The second whole-catalog invariant: a resource id may stand in for an identity whenever
-- the body never checks a principal. Restricted to functions that lock or write, because a
-- pure reader with no side effect is a disclosure question the first invariant and the
-- by-name cohorts already cover, and because that restriction is what keeps this from
-- flooding on the legitimately public surface (rate limiters, hash-token endpoints).
CREATE TEMP TABLE resource_param (name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO resource_param (name) VALUES
  ('subscription_id'), ('order_id'), ('fulfillment_order_id'), ('cycle_id'), ('address_id');

SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM (
       SELECT format('%s(%s)', p.oid::regproc::text, pg_get_function_identity_arguments(p.oid)) AS ident
         FROM pg_proc AS p
         JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosecdef
          AND p.prorettype <> 'trigger'::regtype::oid
          AND p.proargnames IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM unnest(p.proargnames) AS an(argname)
              JOIN resource_param AS rp ON rp.name = regexp_replace(an.argname, '^p_', '')
          )
          AND (p.prosrc ILIKE '%for update%' OR p.prosrc ~* '(insert into|update public|delete from)')
          AND p.prosrc NOT ILIKE '%auth.uid()%'
          AND p.prosrc NOT ILIKE '%current_client_id()%'
          AND (
            has_function_privilege('anon', p.oid, 'execute')
            OR has_function_privilege('authenticated', p.oid, 'execute')
          )
     ) AS offenders),
  '',
  'no SECURITY DEFINER public function that locks or writes on a resource id without checking a principal is executable by anon or authenticated'
);

-- The three carriers 20260824170000 closes, pinned by full signature.
CREATE TEMP TABLE revoked_carrier (ident text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO revoked_carrier (ident) VALUES
  ('public.customer_self_service_apply_subscription_action_pre_cadence(uuid, text, uuid, text, jsonb, timestamp with time zone)'),
  ('public.customer_self_service_accept_subscription_quote_preview(uuid, uuid, text, text, integer, text, timestamp with time zone, jsonb)'),
  ('public.personalization_enqueue_declension(uuid, text)');

-- Resolution first: has_function_privilege yields NULL, not an error, for an unresolvable
-- identity, so a renamed or dropped carrier would let the privilege assertions pass vacuously.
SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM revoked_carrier WHERE to_regprocedure(ident) IS NULL),
  '',
  'every pinned carrier resolves to a live function'
);

SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM revoked_carrier
    WHERE has_function_privilege('anon', to_regprocedure(ident)::oid, 'execute')),
  '',
  'anon holds no execute privilege on any pinned carrier'
);

SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM revoked_carrier
    WHERE has_function_privilege('authenticated', to_regprocedure(ident)::oid, 'execute')),
  '',
  'authenticated holds no execute privilege on any pinned carrier'
);

-- The revoke must not have cost the only role that actually calls these.
SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM revoked_carrier
    WHERE has_function_privilege('service_role', to_regprocedure(ident)::oid, 'execute') IS NOT TRUE),
  '',
  'service_role retains execute on every pinned carrier'
);

SELECT is(
  (SELECT coalesce(string_agg(DISTINCT r.ident, E'\n' ORDER BY r.ident), '')
     FROM revoked_carrier AS r
     JOIN pg_proc AS p ON p.oid = to_regprocedure(r.ident)::oid
     CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'),
  '',
  'PUBLIC holds no execute grant on any pinned carrier'
);

-- Guards the fixture itself: dropping a row would silently shrink the by-name proof.
SELECT is(
  (SELECT count(*)::integer FROM revoked_carrier),
  3,
  'the fixture pins all three carriers this revocation covers'
);

SELECT * FROM finish();
ROLLBACK;
