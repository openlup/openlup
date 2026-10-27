# Qualified installation approval fixtures

These four inert files retain the exact whole bytes approved in
[`qualifiedInstallations`](../../../../../../config/reviewed-platform-forwards.json).
They are not an installation chain, a package SQL export or a migration source.
This control change keeps the canonical legacy v1 manifest unchanged and installs
no qualified SQL. A later feature must introduce these exact approved files
through the separately landed controls; observed installation hashes cannot
replace their prior source approval.

The [migration owner](../../../../../../docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories)
explains generation selection and ledger identity. These fixtures do not prove
installation, runtime completeness, managed-host qualification or activation.
