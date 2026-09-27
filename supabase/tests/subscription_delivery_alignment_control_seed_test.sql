-- pgTAP: run after the frozen managed baseline and its alignment seed forward.
-- The initial assertions read the installed row without supplying a test seed.
-- Replay must not duplicate the singleton or reset an operator's existing mode.
-- Run via: supabase test db
BEGIN;
SELECT plan(5);

SELECT is((SELECT count(*) FROM public.subscription_delivery_alignment_control),
          1::bigint, 'the managed forward installs exactly one control row');
SELECT is((SELECT mode FROM public.subscription_delivery_alignment_control WHERE singleton = true),
          'auto_align'::text, 'a fresh managed install enables late-delivery alignment');

INSERT INTO public.subscription_delivery_alignment_control (singleton, mode)
VALUES (true, 'auto_align')
ON CONFLICT (singleton) DO NOTHING;

SELECT is((SELECT count(*) FROM public.subscription_delivery_alignment_control),
          1::bigint, 'replaying the forward does not duplicate the singleton');

UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton = true;
INSERT INTO public.subscription_delivery_alignment_control (singleton, mode)
VALUES (true, 'auto_align')
ON CONFLICT (singleton) DO NOTHING;

SELECT is((SELECT mode FROM public.subscription_delivery_alignment_control WHERE singleton = true),
          'off'::text, 'replay preserves an operator mode choice');
SELECT is((SELECT count(*) FROM public.subscription_delivery_alignment_control),
          1::bigint, 'operator-mode replay still leaves exactly one row');

SELECT * FROM finish();
ROLLBACK;
