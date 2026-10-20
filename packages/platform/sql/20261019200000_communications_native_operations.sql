-- Native communications facts only. The existing outbox owns all sync claims.
-- CREATE-only: runtime capabilities refuse unsafe effective browser/PUBLIC ACLs.
CREATE TABLE public.communication_native_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding text NOT NULL CHECK (length(binding) BETWEEN 1 AND 256),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  message_id text NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
  recipient_fingerprint text NOT NULL CHECK (length(recipient_fingerprint) = 64),
  template_reference text NOT NULL CHECK (length(template_reference) BETWEEN 1 AND 256),
  accepted_at timestamptz NOT NULL,
  observed_state text CHECK (observed_state IN ('sent','delayed','delivered','bounced','complained','failed')),
  observed_at timestamptz,
  last_poll_at timestamptz,
  not_found_count integer NOT NULL DEFAULT 0 CHECK (not_found_count BETWEEN 0 AND 2147483647),
  abandoned_at timestamptz,
  CONSTRAINT communication_native_sends_source_key UNIQUE (binding, source_key),
  CONSTRAINT communication_native_sends_message_key UNIQUE (binding, message_id)
);
CREATE INDEX communication_native_sends_poll ON public.communication_native_sends (binding, last_poll_at, accepted_at, id);
CREATE TABLE public.communication_native_observations (
  binding text NOT NULL,
  observation_key text NOT NULL CHECK (length(observation_key) BETWEEN 1 AND 256),
  send_id uuid NOT NULL REFERENCES public.communication_native_sends(id),
  kind text NOT NULL CHECK (kind IN ('sent','delayed','delivered','bounced','complained','failed')),
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('poll','callback')),
  fact_fingerprint text NOT NULL CHECK (length(fact_fingerprint) = 64),
  CONSTRAINT communication_native_observations_pkey PRIMARY KEY (binding, observation_key)
);
CREATE INDEX communication_native_observations_send ON public.communication_native_observations (send_id, occurred_at, observation_key);
CREATE TABLE public.communication_native_sync_state (
  work_id uuid PRIMARY KEY REFERENCES public.outbox_events(id),
  binding text NOT NULL CHECK (length(binding) BETWEEN 1 AND 256),
  provider_kind text NOT NULL CHECK (length(provider_kind) BETWEEN 1 AND 256),
  contact_id text NOT NULL CHECK (length(contact_id) BETWEEN 1 AND 256),
  normalized_email text NOT NULL CHECK (length(normalized_email) BETWEEN 3 AND 320),
  purpose text NOT NULL CHECK (purpose IN ('marketing_launch_offer','marketing_newsletter')),
  event_kind text NOT NULL CHECK (event_kind IN ('subscribe','update','unsubscribe','suppress')),
  origin_provider_kind text,
  origin_provider_event_id text,
  remote_profile_id text,
  remote_list_id text,
  response_summary jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(response_summary) = 'object'),
  command_fingerprint text NOT NULL CHECK (length(command_fingerprint) = 64),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20)
);
CREATE TABLE public.notification_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(btrim(email))),
  name text,
  active boolean NOT NULL DEFAULT true,
  notification_type text NOT NULL CHECK (notification_type IN ('packaging_digest','new_signup','commerce_payment_critical')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_recipients_type_email_key UNIQUE (notification_type, email)
);
CREATE INDEX notification_recipients_order ON public.notification_recipients (notification_type, created_at, id);
CREATE TABLE public.communication_native_policy_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_fingerprint text NOT NULL CHECK (length(recipient_fingerprint) = 64),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 256),
  allowed boolean NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 256),
  permission_snapshot jsonb NOT NULL CHECK (jsonb_typeof(permission_snapshot) = 'object'),
  source_table text,
  source_id text,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
