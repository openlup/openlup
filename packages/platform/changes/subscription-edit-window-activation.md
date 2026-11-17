- Unreleased, for the next release after 1.1.0: native purchase activation accepts
  optional `editWindowHours` (integer 1–720), validated with
  `subscription_activation_edit_window_invalid` before database access. Omission
  retains the installed 72-hour default. The value freezes on the created
  subscription; configuration changes and completed replay preserve existing rows.
- Existing native activation/repair signatures and ACLs remain unchanged. New
  separately named invoker SQL functions avoid ambiguous defaulted overloads and
  expose execution only to the service role. Managed checkout activation remains
  a separate unchanged boundary.

Migration: Apply the complete packaged native chain including
`20261123120000_subscription_edit_window_activation.sql` before supplying the new
input. Old callers that omit it keep their existing path. The starter owns
`subscriptionCreation.editWindowHours` (default 72) and validates it at startup
with `starter_subscription_creation_invalid`; all initial activation routes pass it.
