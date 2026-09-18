-- pgTAP: the W3f-a admin document seam reads exactly what its role is granted.
--
-- The seam runs as `service_role` through `createServiceRoleClient`. A unit test
-- stubs that client, so a table the role cannot read looks identical to one it
-- can, and the only place the difference is observable is a real database. This
-- pins both directions:
--
--   * every table `server/adapters/supabase/adminCatalogDocument.ts` selects
--     from, plus `catalog_product_document_revisions` which it reaches through
--     the shared current-document port, is SELECTable by `service_role`. The
--     revisions table is the sharp one: 20260827220000 revokes it from every
--     role and then grants SELECT back, so only statement order decides the
--     answer;
--   * the three publication ledgers are NOT. 20260828220001 revokes them from
--     `PUBLIC, anon, authenticated, service_role`, and an earlier draft of this
--     seam read `catalog_publication_candidates` for an aggregate state digest -
--     unreachable code that every stubbed test passed. That negative control is
--     what makes this file more than a restatement of the migrations.
--
-- Resolution runs first, as in `browser_role_execute_revocation_test.sql`:
-- `has_table_privilege` and `has_function_privilege` yield NULL rather than an
-- error for an unresolvable identity, so a renamed or dropped object would let
-- every privilege assertion below pass vacuously.
BEGIN;
SELECT plan(5);

CREATE TEMP TABLE catalog_document_seam_relation (
  ident text PRIMARY KEY,
  readable boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO catalog_document_seam_relation (ident, readable) VALUES
  -- Read by the adapter directly.
  ('public.catalog_products', true),
  ('public.catalog_skus', true),
  ('public.catalog_sku_eans', true),
  -- Read through `createSupabaseCurrentDocumentPayloadReadPort`, the same port
  -- the public storefront detail route uses.
  ('public.catalog_product_document_revisions', true),
  -- The publication ledgers. Owned by the SECURITY DEFINER publication
  -- functions; no runtime role may read them, and this seam must never try.
  ('public.catalog_publication_candidates', false),
  ('public.catalog_publication_decisions', false),
  ('public.catalog_publication_events', false);

SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM catalog_document_seam_relation
    WHERE to_regclass(ident) IS NULL),
  '',
  'every pinned relation resolves to a live table'
);

SELECT is(
  to_regprocedure('public.catalog_submit_change_proposal(text,text)') IS NOT NULL,
  true,
  'the change-proposal submission RPC resolves to a live function'
);

SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM catalog_document_seam_relation
    WHERE readable
      AND has_table_privilege('service_role', to_regclass(ident), 'SELECT') IS DISTINCT FROM true),
  '',
  'service_role can SELECT every table the document seam reads'
);

-- Same call shape as catalog_change_proposal_inbox_test.sql, which already pins
-- this grant from the RPC's own side.
SELECT is(
  has_function_privilege('service_role', 'public.catalog_submit_change_proposal(text,text)', 'EXECUTE'),
  true,
  'service_role can EXECUTE the change-proposal submission RPC'
);

-- The negative control. If this ever passes as `true` the ledgers have been
-- opened to the seam's role, and the aggregate-state-digest read this wave
-- deleted would silently start working - which is the failure mode, not the fix.
SELECT is(
  (SELECT coalesce(string_agg(ident, E'\n' ORDER BY ident), '')
     FROM catalog_document_seam_relation
    WHERE NOT readable
      AND has_table_privilege('service_role', to_regclass(ident), 'SELECT') IS DISTINCT FROM false),
  '',
  'service_role cannot SELECT any catalog publication ledger'
);

SELECT * FROM finish();
ROLLBACK;
