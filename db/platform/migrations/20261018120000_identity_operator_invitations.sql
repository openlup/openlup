-- Pending direct operator invitations. Lifecycle commands use the trusted
-- server transaction lane; this forward adds no function or actor privilege.
CREATE TABLE public.identity_operator_invitations (
  principal_id uuid PRIMARY KEY REFERENCES public.platform_human_principals(principal_id),
  invitation_id uuid NOT NULL UNIQUE,
  email_key text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('admin', 'distributor')),
  phase text NOT NULL CHECK (phase IN ('invited', 'accepted', 'expired', 'cancelled')),
  invited_by uuid NOT NULL REFERENCES public.platform_human_principals(principal_id),
  invited_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  closed_at timestamptz,
  CHECK (email_key = lower(btrim(email_key)) AND NOT email_key = ''),
  CHECK (expires_at BETWEEN invited_at + interval '60 seconds' AND invited_at + interval '30 days'),
  CHECK (
    (phase = 'invited' AND accepted_at IS NULL AND closed_at IS NULL)
    OR (phase = 'accepted' AND accepted_at IS NOT NULL
      AND accepted_at BETWEEN invited_at AND expires_at
      AND NOT accepted_at = expires_at AND closed_at = accepted_at)
    OR (phase = 'expired' AND accepted_at IS NULL AND closed_at = expires_at)
    OR (phase = 'cancelled' AND accepted_at IS NULL AND closed_at IS NOT NULL)
  )
);

CREATE TABLE public.identity_operator_invitation_events (
  event_id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES public.platform_human_principals(principal_id),
  action text NOT NULL CHECK (action IN ('issue', 'reissue', 'accept', 'expire', 'cancel')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'system')),
  actor_principal_id uuid REFERENCES public.platform_human_principals(principal_id),
  old_value jsonb NOT NULL,
  new_value jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (invitation_id, action),
  CHECK ((actor_kind = 'human' AND actor_principal_id IS NOT NULL)
    OR (actor_kind = 'system' AND actor_principal_id IS NULL))
);

CREATE INDEX identity_operator_invitation_events_target_idx
  ON public.identity_operator_invitation_events(principal_id, occurred_at DESC);
