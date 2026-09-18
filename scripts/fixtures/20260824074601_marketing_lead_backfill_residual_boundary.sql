-- Test-only pre-backfill row. Its malformed address makes the namespace rehome
-- refuse without exposing a real endpoint, leaving one exact residual candidate.

INSERT INTO public.clients (
  id,
  email,
  first_name,
  acquisition_source
) VALUES (
  '08f00000-0000-4000-8000-000000000001',
  'boundary-residual-invalid',
  'Boundary',
  'hidden_configurator'
);
