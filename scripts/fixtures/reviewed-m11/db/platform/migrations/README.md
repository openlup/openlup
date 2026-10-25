# CTL-M11 native disposition

No native SQL pin is proposed. The native return command in
`db/platform/migrations/20260813230000_post_order_control.sql` already binds the
principal through `clients.principal_id`, checks the owned order, and fingerprints
replay. It is an invoker with the native header and ACLs; it must not acquire the
managed `auth_user_id`, SECURITY DEFINER, managed status vocabulary or service_role
grants. The inventory records the graph differences and retained native behavior.
The managed configurator/finalize functions and acquisition policy helper have no
same-contract native twins. Creating a no-op native forward would conceal that gap.
The CTL inventory delivered with the task handoff also dispositions the OMS
bigint offset, review delay (14 versus 21 days), fixture cleanup fence, and
retained source-ledger differences. Channel control is M17, out of scope, as
recorded in the compact inventory groups.
The managed draft registry contains exactly seven SQL files, in order:
`20261025000000`, `20261025003000`, `20261025004000`, `20261025005000`,
`20261025006000`, `20261025007000` and `20261025008000`. The metadata decoder
and terms reader precede the admission helper and finalize replacement.

Re-pinning against main `2b33ca13` leaves all seven managed drafts and their exact
pins unchanged. The committed managed tail is `20261024185100` and native tail
is `20261024184600`; no M10 migration reaches `20261025000000`. All 16 retained
M10 fixtures match their landed migration bytes and live registry pins. M11 proof
uses the complete real managed chain, with each landed file applied once.
All future M11 native numbers must be at least `20261025000000` and follow M10's
final rail tail. This directory is inert draft evidence, not an install chain.
