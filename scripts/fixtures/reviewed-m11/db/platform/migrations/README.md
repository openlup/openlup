# CTL-M11 native disposition

This directory records native disposition; it is not an install chain.
The native return command in
`db/platform/migrations/20260813230000_post_order_control.sql` binds the principal
through `clients.principal_id`, checks the owned order, and fingerprints replay.
Its invoker header and native ACLs must not acquire managed `auth_user_id`,
SECURITY DEFINER, managed status vocabulary or service_role grants.
The managed fixtures do not define native counterparts.

`managedCommerceForwards` in `config/reviewed-platform-forwards.json` pins the
managed SQL fixtures. The registry and real migration rails are authoritative.
M11 versions follow every earlier same-rail pin; each pin requires all earlier
same-rail pins present with exact bytes. The metadata decoder and terms reader
precede the admission helper and finalize replacement. Later feature changes may
introduce those bytes on the managed rail. Tests use the complete real managed
prefix, include each earlier same-rail pin once, and append only absent M11
fixtures. This proves admission/refusals and catalog/ACL/CHECK changes with
rollback; it does not establish native parity, handler behavior or installation
authority.

The class fixes eight entries: the seven checkout, return and acquisition entries
retain their pinned slots, and the eighth is a single new-purchase stock reader.
It composes ATP with renewal exemption fixed false, caps requests at 200 array
items and refuses a NULL as-of timestamp as `inventory_stock_as_of_invalid`
(SQLSTATE `22023`). Its service-only ACL additionally revokes `openlup_mcp_reader`;
its conservative stale flag covers any stale provider row for the SKU, while the
allocator retains its own stale refusal.
