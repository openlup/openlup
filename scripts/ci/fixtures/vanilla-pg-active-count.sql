-- Synthetic legacy-shaped source for the private CP2-A import bridge.
-- The bridge may read this TEMP table but must never modify it.
CREATE TEMP TABLE legacy_testers (
  id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  source text NOT NULL,
  status text NOT NULL,
  pet_type text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  street text NOT NULL,
  postal_code text NOT NULL,
  city text NOT NULL,
  country text NOT NULL,
  gdpr_consent boolean NOT NULL,
  verification_consent boolean NOT NULL
);

INSERT INTO legacy_testers (
  id, created_at, source, status, pet_type, first_name, last_name, email,
  phone, street, postal_code, city, country, gdpr_consent,
  verification_consent
)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  '2026-08-01T10:00:00.000Z',
  'synthetic',
  'approved',
  'dog',
  'Vanilla',
  'Smoke',
  :'smoke_email',
  '000000000',
  'Smoke Street 1',
  '00-000',
  'Warsaw',
  'Polska',
  true,
  true
);
