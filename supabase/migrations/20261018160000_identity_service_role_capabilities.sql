-- Managed identity capabilities. Baseline and prior forwards remain immutable.
-- Exact security admission must precede this forward. Column grants are service-only.

-- Reconcile creation writes exactly these columns; every other column keeps its default.
GRANT INSERT (email, auth_user_id, acquisition_source, lifecycle_stage) ON public.clients TO service_role;
-- Reconcile and checkout soft-account links set only a still-unset principal reference.
GRANT UPDATE (auth_user_id) ON public.clients TO service_role;
-- Operator activation inserts exactly these membership columns; is_machine_actor keeps its false default.
GRANT INSERT (id, email, role, membership_state, membership_provenance, membership_accepted_at) ON public.admin_users TO service_role;
-- Invitation eligibility and conflict checks read the operator address.
GRANT SELECT (email) ON public.admin_users TO service_role;
