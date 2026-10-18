CREATE UNIQUE INDEX platform_human_principals_normalized_email_key
  ON public.platform_human_principals (lower(btrim(email)));

CREATE TABLE public.operator_identity_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL
    REFERENCES public.platform_human_principals(principal_id),
  email_fingerprint text NOT NULL,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,

  CONSTRAINT operator_identity_challenges_email_fingerprint_check
    CHECK (
      length(email_fingerprint) = 64
      AND translate(
        email_fingerprint,
        '0123456789abcdef',
        ''
      ) = ''
    ),

  CONSTRAINT operator_identity_challenges_token_hash_check
    CHECK (
      length(token_hash) = 64
      AND translate(
        token_hash,
        '0123456789abcdef',
        ''
      ) = ''
    ),

  CONSTRAINT operator_identity_challenges_token_hash_key
    UNIQUE (token_hash),

  CONSTRAINT operator_identity_challenges_expiry_check
    CHECK (
      expires_at BETWEEN
        created_at + INTERVAL '1 second'
        AND created_at + INTERVAL '10 minutes'
    ),

  CONSTRAINT operator_identity_challenges_used_at_check
    CHECK (
      used_at IS NULL
      OR used_at BETWEEN created_at AND expires_at
    )
);

CREATE INDEX operator_identity_challenges_principal_created_idx
  ON public.operator_identity_challenges
    (principal_id, created_at DESC);

CREATE INDEX operator_identity_challenges_expiry_idx
  ON public.operator_identity_challenges (expires_at, id);
