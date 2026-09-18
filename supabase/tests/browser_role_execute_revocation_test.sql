-- pgTAP: the service-only functions this platform's default privileges would leave executable
-- by `anon` and `authenticated` are closed to both, and stay open to `service_role`.
--
-- The gap this pins is not a missing statement but a statement that does nothing:
-- `REVOKE ALL ... FROM PUBLIC` withdraws a grant `PUBLIC` never held, because this platform's
-- `ALTER DEFAULT PRIVILEGES` grants EXECUTE on each new `public` function directly to
-- `anon`, `authenticated` and `service_role`. Two cohorts reintroduced that gap after
-- `20260710140004` swept ~66 functions, so the assertions below read the real catalog
-- rather than trusting any migration's REVOKE line.
--
-- The identities are pinned in a fixture table so the signatures are spelled once, and
-- each assertion reports the offending identities in its own diff rather than a bare
-- count - a failure names the function that regressed.
BEGIN;
SELECT plan(6);

CREATE TEMP TABLE browser_closed_rpc (
  ident text PRIMARY KEY,
  cohort text NOT NULL
) ON COMMIT DROP;

INSERT INTO browser_closed_rpc (ident, cohort) VALUES
  -- Cohort A: promotion-code control plane (20260720220900, 20260724141000).
  -- `create`/`update` authorize on a caller-supplied `p_actor_id` and never on
  -- `auth.uid()`, so browser reachability is an authorization bypass, not defence depth.
  ('public.admin_promotion_code_create(uuid, text, text, text, text[], timestamptz, timestamptz, integer, integer, integer, text, jsonb, text, text, text)', 'promotion-code-control-plane'),
  ('public.admin_promotion_code_update(uuid, uuid, integer, jsonb, text, text, text)', 'promotion-code-control-plane'),
  ('public.admin_promotion_code_definition(uuid, uuid)', 'promotion-code-control-plane'),
  ('public.admin_promotion_codes_list(uuid, text, text, text, timestamptz, uuid, integer)', 'promotion-code-control-plane'),
  ('public.admin_promotion_codes_legacy_compatibility(uuid)', 'promotion-code-control-plane'),
  ('public.commerce_promotion_code_redeem(uuid, timestamptz)', 'promotion-code-control-plane'),
  ('public.commerce_promotion_code_release(uuid, text)', 'promotion-code-control-plane'),
  -- Cohort B: settlement-profile readers (20260816152909). RLS already reduces a browser
  -- caller to the fail-closed SQLSTATE 55000; this pins the grant so that protection
  -- stops depending on the body staying fail-closed.
  ('public.platform_settlement_currency()', 'settlement-profile-readers'),
  ('public.platform_region_code()', 'settlement-profile-readers'),
  -- Cohort C: delivery-alignment case exits (20260817130000). These two decide whether an
  -- autonomous renewal may be charged and can move a paid cycle's schedule, so browser
  -- reachability would hand any signed-in visitor the operator's lever. Revoked at birth
  -- rather than after an incident; this row is what keeps them that way.
  ('public.subscription_delivery_alignment_confirm_replacement(uuid, text)', 'delivery-alignment-case-exits'),
  ('public.subscription_delivery_alignment_resolve_case(uuid, text, text)', 'delivery-alignment-case-exits'),

  -- Cohort D: operator subscription commands (20260817140000). Both are definer-rights and
  -- authorize on a caller-supplied `p_operator_id` against the durable communications
  -- allowlist, never on `auth.uid()`. A browser-reachable EXECUTE would therefore let any
  -- signed-in visitor name an operator and act on somebody else's subscription or address.
  ('public.customer_support_apply_subscription_action_v1(uuid, uuid, text, jsonb, integer, text, timestamptz)', 'operator-subscription-commands'),
  ('public.customer_support_correct_subject_email_v1(uuid, uuid, text, text, text, timestamptz)', 'operator-subscription-commands'),

  -- Cohort E: server-only helpers created before any of this hardening existed
  -- (20260605144000, 20260605151000, 20260605152000, 20260701130001) and closed by
  -- 20260830160000. They take a *resource* id rather than a principal id, which is why the
  -- identity-parameter invariant never matched them. `subscription_current_template_snapshot`
  -- is the sharp one: it locks the subscription row `FOR UPDATE` and consults no principal
  -- at all, so the caller-supplied UUID was the only credential it asked for. The other
  -- three run only inside SECURITY DEFINER callers and triggers.
  ('public.subscription_current_template_snapshot(uuid)', 'server-only-resource-id-helpers'),
  ('public.commerce_guard_no_split_fulfillment_order(uuid)', 'server-only-resource-id-helpers'),
  ('public.commerce_validate_fulfillment_provider_kind(text, uuid)', 'server-only-resource-id-helpers'),
  ('public.commerce_fulfillment_order_reservation_location_count(uuid)', 'server-only-resource-id-helpers'),

  -- Cohort F: definers that authorize on nothing (20260830170000). Unlike cohort E these are
  -- reachable operations rather than internal helpers. Each was checked on the live catalog
  -- for auth.uid(), current_client_id(), request.jwt claims, current_user/session_user/
  -- current_role and an admin-table lookup: none is present, and neither gates on data
  -- either, so the EXECUTE grant was the whole gate. The stock upsert was anon-reachable and
  -- writes the levels that gate checkout.
  --
  -- The three catalog publication RPCs were considered for this cohort and deliberately left
  -- out: they authorize on *data* (a human-approved artifact) rather than on a principal, and
  -- catalog_document_publication_control_test.sql pins `authenticated` as their intended
  -- caller with `anon` excluded. Their grant is a designed boundary, not an inherited default.
  ('public.fulfillment_provider_upsert_stock_current(text, text, text, integer, integer, integer, timestamp with time zone, timestamp with time zone, text, jsonb, text)', 'unauthorized-definers'),
  ('public.subscription_self_service_line_set_matches(uuid, jsonb, boolean)', 'unauthorized-definers');

-- Resolution runs first: `has_function_privilege` yields NULL rather than an error for an
-- unresolvable identity, so a renamed or dropped function would let the privilege
-- assertions below pass vacuously.
SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM browser_closed_rpc
    WHERE to_regprocedure(ident) IS NULL),
  '',
  'every pinned identity resolves to a live function'
);

SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM browser_closed_rpc
    WHERE has_function_privilege('anon', to_regprocedure(ident)::oid, 'execute')),
  '',
  'anon holds no execute privilege on any pinned function'
);

SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM browser_closed_rpc
    WHERE has_function_privilege('authenticated', to_regprocedure(ident)::oid, 'execute')),
  '',
  'authenticated holds no execute privilege on any pinned function'
);

-- The revoke must not have cost the only role that actually calls these: cohort A is
-- reached through `context.serviceClient` in the promotion-code BFF, cohort B's callers
-- are SECURITY DEFINER RPCs owned by `postgres`, cohort C is called by a service-role
-- operator against the delivery-alignment ledger, cohort E is reached either from
-- SECURITY DEFINER callers running as `postgres` or, for the snapshot reader, from the
-- renewal cron on a client built with `.asService(...)`, and cohort F is reached from
-- service-role clients (the OmniPack stock sync and seed runner) or from a `postgres`-owned
-- definer caller.
SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM browser_closed_rpc
    WHERE has_function_privilege('service_role', to_regprocedure(ident)::oid, 'execute') IS NOT TRUE),
  '',
  'service_role retains execute on every pinned function'
);

SELECT is(
  (SELECT coalesce(string_agg(DISTINCT r.ident, E'\n' ORDER BY r.ident), '')
     FROM browser_closed_rpc AS r
     JOIN pg_proc AS p ON p.oid = to_regprocedure(r.ident)::oid
     CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'),
  '',
  'PUBLIC holds no execute grant on any pinned function'
);

-- Guards the fixture itself: dropping a row would silently shrink the proof to the
-- functions that still happen to be listed.
SELECT is(
  (SELECT count(*)::integer FROM browser_closed_rpc),
  19,
  'the fixture pins all nineteen functions this revocation covers'
);

SELECT * FROM finish();
ROLLBACK;
