- Unreleased, for the next release after 1.1.0: native purchase activation accepts
  optional `editWindowHours` (integer 1–720), validated with
  `subscription_activation_edit_window_invalid` before database access. Omission
  retains the installed 72-hour default. The value freezes on the created
  subscription; configuration changes and completed replay preserve existing rows.
- Existing native activation/repair signatures and ACLs remain unchanged. New
  separately named invoker SQL functions contain their predecessor bodies with
  the new input and pinned `public, pg_catalog` search paths. The forward never
  redefines or changes privileges on the predecessors. New functions revoke
  PUBLIC/anon/authenticated and grant EXECUTE to service_role where present.
  Managed checkout activation remains a separate unchanged boundary.

Migration: Apply the complete packaged native chain including
`20261123120000_subscription_edit_window_activation.sql` before supplying the new
input. Opting in requires EXECUTE on both new functions (granted to service_role
where present; owner-run self-host installations have it as owner). Old callers
that omit it call the unchanged predecessor with its existing privileges.
The starter owns
`subscriptionCreation.editWindowHours` (default 72) and validates it at startup
with `starter_subscription_creation_invalid`; all initial activation routes pass
it, including 72, and therefore opt in.
