- Updated `OMS_OPERATIONAL_LADDER` `missing_shipping_address` `sqlPredicate` to `shipping_address_id IS NULL` to match the optimized managed `commerce_oms_admin_list_queue` forward migration.
  If you mirror or byte-seal the `missing_shipping_address` predicate, refresh your copy to `shipping_address_id IS NULL` when you apply the matching managed `commerce_oms_admin_list_queue` forward.
