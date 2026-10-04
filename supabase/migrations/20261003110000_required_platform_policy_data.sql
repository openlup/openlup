-- Required platform policy data; existing operator choices survive replay.
INSERT INTO public.client_absorption_policy (table_name, disposition) VALUES
  ('addresses', 'block'),
  ('channel_order_ingests', 'block'),
  ('client_consents', 'carry'),
  ('client_source_links', 'carry'),
  ('commerce_carts', 'block'),
  ('commerce_checkout_recovery_tokens', 'block'),
  ('commerce_checkout_resume_drafts', 'block'),
  ('commerce_checkout_sessions', 'block'),
  ('commerce_fulfillment_orders', 'block'),
  ('commerce_orders', 'block'),
  ('commerce_payment_method_refs', 'block'),
  ('communication_email_deliveries', 'carry'),
  ('customer_account_events', 'retain'),
  ('customer_delivery_preferences', 'block'),
  ('customer_external_refs', 'block'),
  ('customer_orderer_profiles', 'block'),
  ('customer_payment_preferences', 'block'),
  ('customer_personalization', 'carry'),
  ('pets', 'block'),
  ('promotion_code_claims', 'block'),
  ('promotion_redemptions', 'block'),
  ('risk_assessments', 'block'),
  ('risk_manual_review_cases', 'block'),
  ('subscription_dunning_cases', 'block'),
  ('subscription_payment_recovery_tokens', 'block'),
  ('subscription_quote_previews', 'block'),
  ('subscriptions', 'block')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO public.platform_job_controls
  (job_name, enabled, active_driver, allowed_trigger_kinds, metadata) VALUES
  ('accounting-invoice-issue', false, 'vercel_cron', '{worker,scheduler}', '{}'),
  ('accounting-invoice-delivery', false, 'vercel_cron', '{worker,scheduler}', '{}'),
  ('accounting-invoice-correction', false, 'vercel_cron', '{worker,scheduler}', '{}'),
  ('accounting-ksef-status', false, 'vercel_cron', '{scheduler}', '{}'),
  ('abandoned-cart-reminder', false, 'vercel_cron', '{scheduler}', '{"requiresFlag":"COMMERCE_ABANDONED_CART_ENABLED"}'),
  ('outbox-prune', false, 'vercel_cron', '{scheduler}', '{"requiresFlag":"COMMERCE_OUTBOX_PRUNE_ENABLED"}'),
  ('promotion-claim-sweep', false, 'vercel_cron', '{scheduler}', '{"requiresFlag":"COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED"}')
ON CONFLICT (job_name) DO NOTHING;

-- Frozen baseline column order: event_type, owner, reason, created_at, updated_at.
-- Literal timestamps avoid function expressions; OWNER as a column identifier is
-- outside the existing bounded admission token vocabulary.
INSERT INTO public.outbox_dormant_event_types VALUES
  ('commerce.subscription_payment.requested', 'commerce/payments', 'PSP subscription payment command has no production-ready outbox handler yet.', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z'),
  ('commerce.payment_attempt.requested', 'commerce/payments', 'One-time payment-attempt command remains owned by the payment control plane.', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z'),
  ('commerce.subscription_payment.retry_requested', 'commerce/recovery', 'Payment-recovery retry command has no dispatcher handler yet.', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z'),
  ('commerce.subscription.resume_requested', 'commerce/recovery', 'Historical expired-recovery resume command has no dispatcher handler; current generic setup/redeem fails closed until snapshot-aware resume is wired.', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z')
ON CONFLICT (event_type) DO NOTHING;

INSERT INTO public.comms_notification_controls (slug, enabled) VALUES
  ('subscription-payment-recovered', true),
  ('subscription-payment-expired', true),
  ('subscription-payment-failed-*', true),
  ('subscription-renewal-at-risk', true)
ON CONFLICT (slug) DO NOTHING;
