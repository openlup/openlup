-- Customer identity read catalog forward.
--
-- This append-only delta adds only an optional neutral principal link to the
-- existing client profile. Authenticated callers can select their own bounded
-- response columns through the existing invoker-rights actor lane. It does not
-- add a customer mutation, privileged role, auth table, routine, or trigger.
--
-- openlup:allow-unique-index: a non-null principal maps to at most one client; the fresh-database proof verifies the exact partial index.
-- openlup:allow-rls: the one authenticated SELECT policy is proven through the shipped actor transaction with two principals.
-- openlup:allow-grant: PUBLIC and anon remain denied; authenticated receives only the five profile response columns, proven by catalog ACL checks.

ALTER TABLE public.clients ADD COLUMN principal_id uuid;

-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX clients_principal_id_unique
  ON public.clients (principal_id)
  WHERE principal_id IS NOT NULL;

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY clients_select_own_principal
  ON public.clients
  FOR SELECT
  TO authenticated
  USING (principal_id = auth.uid());

REVOKE ALL ON TABLE public.clients FROM PUBLIC;
REVOKE ALL ON TABLE public.clients FROM anon;
REVOKE ALL ON TABLE public.clients FROM authenticated;
GRANT SELECT (id, email, first_name, last_name, lifecycle_stage)
  ON TABLE public.clients TO authenticated;
