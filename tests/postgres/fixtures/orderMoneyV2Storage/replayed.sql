SELECT plan(10);

CREATE OR REPLACE TEMP VIEW private_order_money AS
SELECT c.* FROM pg_class c
WHERE c.relnamespace='public'::regnamespace AND c.relname IN (
  'commerce_order_tax_snapshots','commerce_order_line_sources','commerce_order_delivery_buckets',
  'commerce_order_line_allocations','commerce_order_tax_positions','commerce_order_fee_lines');

SELECT ok((SELECT count(*)=6 AND bool_and(relkind='r' AND pg_get_userbyid(relowner)=current_user) FROM private_order_money),
  'the migration owner owns six ordinary relations');
SELECT ok((SELECT bool_and(relrowsecurity AND NOT relforcerowsecurity) FROM private_order_money)
  AND NOT EXISTS (SELECT FROM pg_policy JOIN private_order_money c ON polrelid=c.oid),
  'the private tables have enabled non-FORCE RLS and zero policies');
SELECT ok(NOT EXISTS (SELECT FROM private_order_money c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner)
  AND NOT EXISTS (SELECT FROM pg_attribute a JOIN private_order_money c ON a.attrelid=c.oid WHERE a.attacl IS NOT NULL),
  'table and column ACLs are owner-only');
SELECT ok(NOT EXISTS (SELECT FROM pg_roles r CROSS JOIN private_order_money c
  WHERE r.rolname IN ('anon','authenticated','service_role')
    AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))),
  'every installed optional role has zero table and column access');

-- Each declaration names every column and its installed PostgreSQL type.
WITH expected(table_name, columns) AS (VALUES
  ('commerce_order_tax_snapshots',
    'order_id:uuid calculation_id:uuid accepted_quote_id:uuid cycle_binding_ref:uuid destination_snapshot_ref:uuid accepted_quote_digest:text token_digest:text accepted_money_digest:text evidence_digest:text coverage_digest:text destination_digest:text destination_policy_revision:text delivery_selection_ref:text destination_erased:boolean acceptance_ref:text price_list_ref:text price_context_digest:text price_evidence_ref:text class_map_revision:text catalogue_evidence_ref:text limit_profile_ref:text limit_channel_key:text money_version:text amount_basis:text currency:text mode:text promotion_engine:text tax_date:timestamptz evaluation_expires_at:timestamptz cadence_days:integer limit_revision:integer limit_min_minor:bigint limit_max_minor:bigint net_total:bigint tax_total:bigint fee_total:bigint payable_minor:bigint'),
  ('commerce_order_line_sources',
    'order_id:uuid sku_id:uuid line_key:text tax_class_key:text assignment_ref:text sku_code:text mode:text source_ordinal:integer source_rank:integer quantity:integer unit_basis_minor:bigint pre_discount_minor:bigint effective_minor:bigint net_minor:bigint tax_minor:bigint'),
  ('commerce_order_delivery_buckets',
    'order_id:uuid bucket_key:text tax_class_key:text assignment_ref:text cost_ref:text carrier_ref:text service_ref:text destination_erased:boolean kind:text cost_currency:text bucket_rank:integer part_no:integer header_part_no:integer source_ordinal:integer separately_stated:boolean cost_amount_minor:bigint pre_discount_minor:bigint effective_minor:bigint net_minor:bigint tax_minor:bigint'),
  ('commerce_order_line_allocations',
    'order_id:uuid allocation_id:uuid adjustment_id:uuid line_key:text bucket_key:text adjustment_ref:text evidence_ref:text part_no:integer sequence:integer basis_reduction_minor:bigint net_reduction_minor:bigint tax_reduction_minor:bigint before_basis_minor:bigint before_net_minor:bigint before_tax_minor:bigint after_basis_minor:bigint after_net_minor:bigint after_tax_minor:bigint'),
  ('commerce_order_tax_positions',
    'order_id:uuid allocation_id:uuid position_ref:text line_key:text bucket_key:text rule_ref:text assignment_ref:text policy_revision:text resolution_source_ref:text resolution_source_digest:text resolution_digest:text jurisdiction_ref:text taxability_reason:text provider_line_ref:text state_side:text level:text tax_kind:text rate_decimal:text part_no:integer allocation_slot:integer position_rank:integer effective_from:timestamptz effective_until:timestamptz taxable_minor:bigint tax_minor:bigint'),
  ('commerce_order_fee_lines',
    'order_id:uuid fee_key:text bucket_key:text refund_rule_ref:text refund_rule_revision:text jurisdiction_ref:text provider_position_ref:text fee_kind:text scope_kind:text fee_rank:integer bucket_part_no:integer amount_minor:bigint')
), actual AS (
  SELECT c.relname::text AS table_name,string_agg(a.attname||':'||
    replace(format_type(a.atttypid,a.atttypmod),'timestamp with time zone','timestamptz'),' ' ORDER BY a.attnum) AS columns
  FROM private_order_money c JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE a.attnum>0 AND NOT a.attisdropped GROUP BY c.relname
)
SELECT ok(NOT EXISTS (SELECT FROM expected e FULL JOIN actual a USING (table_name) WHERE e.columns IS DISTINCT FROM a.columns),
  'the complete scalar column census matches in installation order');

SELECT ok((SELECT count(*)=2 AND bool_and(NOT attnotnull AND NOT atthasdef AND atttypid='text'::regtype)
  FROM pg_attribute WHERE (attrelid,attname) IN (
    ('public.commerce_orders'::regclass,'money_version'),('public.commerce_order_items'::regclass,'line_key'))),
  'both incumbent additions are nullable text without defaults');

SELECT set_eq($keys$
  SELECT c.relname::text,pg_get_constraintdef(k.oid)
  FROM pg_constraint k JOIN private_order_money c ON k.conrelid=c.oid WHERE k.contype IN ('p','u')
$keys$, $expected$ VALUES
  ('commerce_order_tax_snapshots','PRIMARY KEY (order_id)'),
  ('commerce_order_tax_snapshots','UNIQUE (order_id, money_version)'),
  ('commerce_order_tax_snapshots','UNIQUE (accepted_quote_id)'),
  ('commerce_order_tax_snapshots','UNIQUE (calculation_id)'),
  ('commerce_order_line_sources','PRIMARY KEY (order_id, line_key)'),
  ('commerce_order_line_sources','UNIQUE (order_id, source_ordinal)'),
  ('commerce_order_delivery_buckets','PRIMARY KEY (order_id, bucket_key, part_no)'),
  ('commerce_order_line_allocations','PRIMARY KEY (allocation_id)'),
  ('commerce_order_line_allocations','UNIQUE (order_id, line_key, sequence)'),
  ('commerce_order_line_allocations','UNIQUE (order_id, bucket_key, part_no, sequence)'),
  ('commerce_order_line_allocations','UNIQUE (order_id, allocation_id, sequence, line_key)'),
  ('commerce_order_line_allocations','UNIQUE (order_id, allocation_id, sequence, bucket_key, part_no)'),
  ('commerce_order_tax_positions','PRIMARY KEY (order_id, position_ref, state_side, allocation_slot)'),
  ('commerce_order_fee_lines','PRIMARY KEY (order_id, fee_key)')
$expected$, 'primary and unique keys use exactly their declared columns');

SELECT ok((SELECT count(*)=2 AND bool_and(contype='u') FROM pg_constraint
    WHERE conrelid='public.commerce_order_tax_snapshots'::regclass AND conname IN (
      'commerce_order_money_v2_snapshots_accepted_quote_key','commerce_order_money_v2_snapshots_calculation_key'))
  AND EXISTS (SELECT FROM pg_index WHERE indexrelid=to_regclass('public.commerce_order_tax_positions_final_key')
    AND indisunique AND indrelid='public.commerce_order_tax_positions'::regclass
    AND pg_get_indexdef(indexrelid,1,false)='order_id' AND pg_get_indexdef(indexrelid,2,false)='position_ref'
    AND indnkeyatts=2 AND pg_get_expr(indpred,indrelid)='(allocation_slot = 0)'),
  'the named consumption keys and final-only unique index are installed');

SELECT set_eq($keys$
  SELECT conrelid::regclass::text,regexp_replace(pg_get_constraintdef(k.oid),' DEFERRABLE INITIALLY DEFERRED$','')
  FROM pg_constraint k WHERE k.contype='f' AND (k.conrelid IN (SELECT oid FROM private_order_money)
    OR k.conname IN ('commerce_orders_money_snapshot_fkey','commerce_order_items_money_source_fkey'))
$keys$, $expected$ VALUES
  ('commerce_orders','FOREIGN KEY (id, money_version) REFERENCES commerce_order_tax_snapshots(order_id, money_version)'),
  ('commerce_order_items','FOREIGN KEY (order_id, line_key) REFERENCES commerce_order_line_sources(order_id, line_key)'),
  ('commerce_order_tax_snapshots','FOREIGN KEY (order_id) REFERENCES commerce_orders(id)'),
  ('commerce_order_tax_snapshots','FOREIGN KEY (calculation_id) REFERENCES tax_calculations(calculation_id)'),
  ('commerce_order_line_sources','FOREIGN KEY (order_id) REFERENCES commerce_order_tax_snapshots(order_id)'),
  ('commerce_order_line_sources','FOREIGN KEY (sku_id) REFERENCES catalog_skus(id)'),
  ('commerce_order_delivery_buckets','FOREIGN KEY (order_id) REFERENCES commerce_order_tax_snapshots(order_id)'),
  ('commerce_order_delivery_buckets','FOREIGN KEY (order_id, bucket_key, header_part_no) REFERENCES commerce_order_delivery_buckets(order_id, bucket_key, part_no)'),
  ('commerce_order_line_allocations','FOREIGN KEY (adjustment_id) REFERENCES commerce_order_adjustments(id)'),
  ('commerce_order_line_allocations','FOREIGN KEY (order_id, line_key) REFERENCES commerce_order_line_sources(order_id, line_key)'),
  ('commerce_order_line_allocations','FOREIGN KEY (order_id, bucket_key, part_no) REFERENCES commerce_order_delivery_buckets(order_id, bucket_key, part_no)'),
  ('commerce_order_tax_positions','FOREIGN KEY (order_id, line_key) REFERENCES commerce_order_line_sources(order_id, line_key)'),
  ('commerce_order_tax_positions','FOREIGN KEY (order_id, bucket_key, part_no) REFERENCES commerce_order_delivery_buckets(order_id, bucket_key, part_no)'),
  ('commerce_order_tax_positions','FOREIGN KEY (order_id, allocation_id, allocation_slot, line_key) REFERENCES commerce_order_line_allocations(order_id, allocation_id, sequence, line_key)'),
  ('commerce_order_tax_positions','FOREIGN KEY (order_id, allocation_id, allocation_slot, bucket_key, part_no) REFERENCES commerce_order_line_allocations(order_id, allocation_id, sequence, bucket_key, part_no)'),
  ('commerce_order_fee_lines','FOREIGN KEY (order_id) REFERENCES commerce_order_tax_snapshots(order_id)'),
  ('commerce_order_fee_lines','FOREIGN KEY (order_id, bucket_key, bucket_part_no) REFERENCES commerce_order_delivery_buckets(order_id, bucket_key, part_no)')
$expected$, 'foreign keys link each exact target, including the same-order coordinates');

SELECT ok((SELECT count(*)=17 AND bool_and(condeferrable AND condeferred AND convalidated
    AND confdeltype='a' AND confupdtype='a' AND confmatchtype='s')
  FROM pg_constraint WHERE contype='f' AND (conrelid IN (SELECT oid FROM private_order_money)
    OR conname IN ('commerce_orders_money_snapshot_fkey','commerce_order_items_money_source_fkey'))),
  'all seventeen foreign keys start deferred with NO ACTION');

SELECT * FROM finish();
