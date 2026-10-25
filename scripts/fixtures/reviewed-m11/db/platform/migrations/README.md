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

The class fixes nine entries: slots 1–8 each retain one function exactly as pinned;
slot 9 is the starter pair. The seven checkout, return and acquisition entries
retain their pinned slots, and the eighth is a single new-purchase stock reader.
It composes ATP with renewal exemption fixed false, caps requests at 200 array
items and refuses a NULL as-of timestamp as `inventory_stock_as_of_invalid`
(SQLSTATE `22023`). Its service-only ACL additionally revokes `openlup_mcp_reader`;
its conservative stale flag covers any stale provider row for the SKU, while the
allocator retains its own stale refusal.

The ninth file, `20261025110000_starter_graduation_cadence.sql`, replaces
`subscription_create_provisional_for_checkout(uuid,uuid,uuid,uuid,jsonb)` and
`subscription_apply_starter_graduation(uuid,text,text)`. The native chain has
neither starter routine nor the managed acquisition marker; no native twin is
defined. Native positive-cadence validation is a different contract.

Migration: the managed starter routines admit a graduation cadence of 14, 21 or
28 days (previously 14 or 28); nothing else about them changes except provisional
creation takes the subscription column default for the timezone. Native has no
twin. Rolling back below this forward once a 21-day marker exists is unsupported;
roll forward. Neutral comments replace inherited prose; signatures, SECURITY
DEFINER, search_path and service-only execution stay fixed.

PARITY GAP — the adopter-owned opt-in `full_unedited` graduation mode, which
graduates only unedited starter terms, is not contributed. It belongs to the
subscription domain (M10 area) and is unreachable from M11 code; the adopter
keeps its own managed SQL.
