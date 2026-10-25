# Reviewed M12 support authority fixtures

These are inert approval fixtures, not an installation chain or a runtime migration source.
The native fixture is 20261026120000_account_support_operator_authority.sql; the managed
fixture is 20261026120100_account_support_current_authority.sql. Their bytes must equal
the approved native/managed canonical files when introduced; the native packed SQL twin
must equal the native file too. CTL installs neither canonical file nor a manifest row.

Replay complete ordered committed prefixes, preserving unpinned interleavings. Append
only missing selected fixture suffixes; a later canonical pin cannot hide an earlier hole.
The [registry](../../../../../../config/reviewed-platform-forwards.json) and the real
[native](../../../../../../db/platform/migrations/) and
[managed](../../../../../../supabase/migrations/) rails own current inventory and order.
Do not edit or re-version M11 fixtures or sibling pins. Never install these fixtures in
production. The account-support migration export is a sparse catalog, not an installer.

Real PostgreSQL/pgTAP must prove exact function headers/bodies/ACLs, CHECK preimages,
claim columns, sequence state/ACL, deferred auth.users trigger, unaffected catalog/rows,
transaction rollback and no-op/replay tuple stability. Missing infrastructure fails the
prerequisite. Sequence allocation may leave gaps after command rollback. Source hashes
and bounded lexical admission checks are not catalog or behavioral proof. No custom SQL
parser is a proof oracle. Regroup after two unresolved attempts without resetting history.
