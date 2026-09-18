-- Validate the customer subscription-control constraints added by the preceding
-- forward after their non-blocking installation transaction has committed.

ALTER TABLE public.subscriptions
  VALIDATE CONSTRAINT subscriptions_price_list_id_fkey;
ALTER TABLE public.subscriptions
  VALIDATE CONSTRAINT subscriptions_template_version_check;
ALTER TABLE public.subscriptions
  VALIDATE CONSTRAINT subscriptions_edit_window_hours_check;
ALTER TABLE public.subscriptions
  VALIDATE CONSTRAINT subscriptions_currency_code_check;
ALTER TABLE public.subscriptions
  VALIDATE CONSTRAINT subscriptions_price_context_check;
