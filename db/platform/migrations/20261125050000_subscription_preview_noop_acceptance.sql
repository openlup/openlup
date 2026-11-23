ALTER TABLE public.subscription_quote_previews ADD COLUMN accepted_noop_receipt_id uuid REFERENCES public.subscription_command_receipts(id);
ALTER TABLE public.subscription_quote_previews DROP CONSTRAINT subscription_quote_previews_acceptance_check;
ALTER TABLE public.subscription_quote_previews ADD CONSTRAINT subscription_quote_previews_acceptance_check CHECK (
  (status = 'previewed' AND accepted_at IS NULL AND accepted_idempotency_key IS NULL AND accepted_event_id IS NULL AND accepted_noop_receipt_id IS NULL)
  OR (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_idempotency_key IS NOT NULL AND accepted_event_id IS NOT NULL AND accepted_noop_receipt_id IS NULL)
  OR (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_idempotency_key IS NOT NULL AND accepted_event_id IS NULL AND accepted_noop_receipt_id IS NOT NULL)
);
