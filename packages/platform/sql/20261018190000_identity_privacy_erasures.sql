-- Direct identity erasure receipts. Audit and idempotency share one retained
-- pseudonymous record; no personal export snapshot or actor grants are stored.
CREATE TABLE public.identity_privacy_erasures (
  erasure_id uuid PRIMARY KEY,
  idempotency_key uuid NOT NULL UNIQUE,
  client_id uuid UNIQUE REFERENCES public.clients(id),
  principal_id uuid UNIQUE,
  actor_principal_id uuid NOT NULL REFERENCES public.platform_human_principals(principal_id),
  contract_version text NOT NULL CHECK (contract_version = 'identity.erasure.v1'),
  contributor_versions jsonb NOT NULL,
  dispositions jsonb NOT NULL,
  retained_obligations jsonb NOT NULL,
  completed_at timestamptz NOT NULL,
  CHECK (client_id IS NOT NULL OR principal_id IS NOT NULL)
);
