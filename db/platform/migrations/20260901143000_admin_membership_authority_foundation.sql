-- Dormant direct human membership authority.
--
-- This forward introduces a provider-neutral human principal and its separate
-- current-panel membership for the direct bundle. It mirrors the managed role,
-- active/revoked state, provenance, acceptance, revocation, retained identity,
-- last-human-administrator refusal, and one-row revoke audit semantics. It does
-- not verify a login, grant browser access, seed a person, or link to the
-- existing platform_control_operators machine authority. The direct host owns
-- activation of a future human-login adapter; until then these relations are
-- deliberately dormant and default-deny for the actor roles.

CREATE TABLE public.platform_human_principals (
  principal_id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.platform_human_memberships (
  principal_id uuid PRIMARY KEY REFERENCES public.platform_human_principals(principal_id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('admin', 'distributor')),
  membership_state text NOT NULL CHECK (membership_state IN ('active', 'revoked')),
  membership_provenance text NOT NULL CHECK (membership_provenance IN ('legacy', 'invitation')),
  membership_accepted_at timestamptz NOT NULL,
  membership_revoked_at timestamptz,
  membership_revoked_by uuid REFERENCES public.platform_human_principals(principal_id) ON DELETE RESTRICT,
  membership_revocation_reason text,
  CONSTRAINT platform_human_memberships_lifecycle_check CHECK (
    (membership_state = 'active'
      AND membership_revoked_at IS NULL
      AND membership_revoked_by IS NULL
      AND membership_revocation_reason IS NULL)
    OR
    (membership_state = 'revoked'
      AND membership_revoked_at IS NOT NULL
      AND membership_revoked_by IS NOT NULL)
  ),
  CONSTRAINT platform_human_memberships_distinct_revoker_check
    CHECK (membership_revoked_by IS NULL OR membership_revoked_by <> principal_id),
  CONSTRAINT platform_human_memberships_reason_length_check
    CHECK (membership_revocation_reason IS NULL OR char_length(membership_revocation_reason) <= 1000)
);

CREATE TABLE public.platform_human_membership_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_principal_id uuid NOT NULL REFERENCES public.platform_human_principals(principal_id) ON DELETE RESTRICT,
  target_principal_id uuid NOT NULL REFERENCES public.platform_human_principals(principal_id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action = 'revoke'),
  old_value jsonb NOT NULL,
  new_value jsonb NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_human_membership_audit_target_idx
  ON public.platform_human_membership_audit_events(target_principal_id, occurred_at DESC);

REVOKE ALL ON TABLE
  public.platform_human_principals,
  public.platform_human_memberships,
  public.platform_human_membership_audit_events
FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.platform_human_membership_is_active(p_principal_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.platform_human_memberships AS membership_row
    WHERE membership_row.principal_id = p_principal_id
      AND membership_row.membership_state = 'active'
  );
$$;

CREATE FUNCTION public.platform_human_membership_is_administrator(p_principal_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.platform_human_memberships AS membership_row
    WHERE membership_row.principal_id = p_principal_id
      AND membership_row.membership_state = 'active'
      AND membership_row.role = 'admin'
  );
$$;

CREATE FUNCTION public.platform_human_memberships_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_removes_active_human_admin boolean := false;
  v_other_active_human_admins integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_removes_active_human_admin := OLD.membership_state = 'active' AND OLD.role = 'admin';
  ELSE
    IF (OLD.membership_state, OLD.membership_provenance, OLD.membership_accepted_at,
        OLD.membership_revoked_at, OLD.membership_revoked_by,
        OLD.membership_revocation_reason)
       IS DISTINCT FROM
       (NEW.membership_state, NEW.membership_provenance, NEW.membership_accepted_at,
        NEW.membership_revoked_at, NEW.membership_revoked_by,
        NEW.membership_revocation_reason)
      AND current_setting('app.platform_human_membership_revoke', true) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'platform_human_membership_lifecycle_update_forbidden' USING ERRCODE = '42501';
    END IF;

    IF OLD.membership_state <> 'active' AND NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'platform_human_target_membership_inactive' USING ERRCODE = 'P0001';
    END IF;

    v_removes_active_human_admin := OLD.membership_state = 'active'
      AND OLD.role = 'admin'
      AND (NEW.membership_state <> 'active' OR NEW.role <> 'admin');
  END IF;

  IF v_removes_active_human_admin THEN
    PERFORM pg_advisory_xact_lock(hashtext('platform_human_memberships_active_admin')::bigint);
    SELECT count(*)
      INTO v_other_active_human_admins
    FROM public.platform_human_memberships
    WHERE principal_id <> OLD.principal_id
      AND membership_state = 'active'
      AND role = 'admin';

    IF v_other_active_human_admins < 1 THEN
      RAISE EXCEPTION 'platform_human_last_admin_lockout' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform_human_membership_delete_forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_platform_human_memberships_guard
  BEFORE UPDATE OR DELETE ON public.platform_human_memberships
  FOR EACH ROW EXECUTE FUNCTION public.platform_human_memberships_guard();

CREATE FUNCTION public.platform_revoke_human_membership(
  p_actor_principal_id uuid,
  p_target_principal_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS public.platform_human_memberships
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_target public.platform_human_memberships;
  v_reason text := NULLIF(btrim(p_reason), '');
  v_revoked_at timestamptz := clock_timestamp();
BEGIN
  IF NOT public.platform_human_membership_is_administrator(p_actor_principal_id) THEN
    RAISE EXCEPTION 'platform_human_revoke_forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_target_principal_id IS NULL THEN
    RAISE EXCEPTION 'platform_human_target_required' USING ERRCODE = '22023';
  END IF;

  IF p_target_principal_id = p_actor_principal_id THEN
    RAISE EXCEPTION 'platform_human_self_revoke_forbidden' USING ERRCODE = 'P0001';
  END IF;

  IF v_reason IS NOT NULL AND char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'platform_human_revocation_reason_too_long' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_target
  FROM public.platform_human_memberships
  WHERE principal_id = p_target_principal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform_human_target_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_target.membership_state = 'revoked' THEN
    RETURN v_target;
  END IF;

  PERFORM set_config('app.platform_human_membership_revoke', 'true', true);

  UPDATE public.platform_human_memberships
  SET membership_state = 'revoked',
      membership_revoked_at = v_revoked_at,
      membership_revoked_by = p_actor_principal_id,
      membership_revocation_reason = v_reason
  WHERE principal_id = p_target_principal_id
  RETURNING * INTO v_target;

  INSERT INTO public.platform_human_membership_audit_events
    (actor_principal_id, target_principal_id, action, old_value, new_value, reason, occurred_at)
  VALUES (
    p_actor_principal_id,
    p_target_principal_id,
    'revoke',
    jsonb_build_object('membershipState', 'active', 'role', v_target.role),
    jsonb_build_object(
      'membershipState', 'revoked',
      'revokedAt', v_revoked_at,
      'revokedBy', p_actor_principal_id,
      'revocationReason', v_reason
    ),
    v_reason,
    v_revoked_at
  );

  RETURN v_target;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_human_membership_is_active(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_human_membership_is_administrator(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_human_memberships_guard()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_revoke_human_membership(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.platform_revoke_human_membership(uuid, uuid, text) IS
  'Dormant direct-bundle revoke command. Requires an active human administrator, retains the target principal/membership, refuses self and last-admin removal, and records one atomic revoke event.';
