# Intent: prove the managed SQL contract on plain PostgreSQL

Status: proposal awaiting owner decisions; no CI behaviour changes. The
[execution plan](neutral-postgres-pgtap.md) holds the inventory, stages, parity
proof, risks and budget.
Audience: the maintainer deciding the CI database lane, and agents implementing it.

## Outcome

The managed pgTAP lane proves that the shipped managed baseline, its ordered
forwards and every shipped SQL test pass on one digest-pinned stock
PostgreSQL 17 server. Supabase is a named managed-environment adapter: one
reviewed compatibility file supplies the roles, `auth` helpers, `extensions`
schema and scheduler that the managed host would provide. Hosted CI no longer
needs the Supabase CLI, its derived container images or its image-mirror
planning to run this proof.

## Why

The database is PostgreSQL. Hosted CI now depends on a CLI release, five
CLI-derived images from external registries and mirror logic only to obtain a
PostgreSQL server with pgTAP. The 2.122.0 CLI bump
([openlup/openlup#443](https://github.com/openlup/openlup/pull/443)) failed on
registry rate limits, missing mirror tags and the CLI action's launcher; none of
those failures concerned the SQL under test. A stock server with an explicit
adapter removes those causes instead of adding further workarounds around them.

## Boundaries

- The same committed migration bytes and the same `supabase/tests` files run
  unchanged. A required test edit is a finding for the owner, not a repair.
- The old lane is removed only after both lanes give identical per-assertion
  results over an agreed shadow window. The compatibility file must not weaken
  any assertion, grant or refusal.
- The compatibility file is test infrastructure for CI. It is not a runtime
  bootstrap, an installation path or a claim that stock PostgreSQL is a
  supported managed host. It does not replace the portable
  `db/platform/migrations` chain or its native lanes.
- The opt-in subscription reference and the identity acceptance's
  `node-supabase` bundle start a real Supabase stack locally on purpose. They
  are adapter evidence and stay out of scope.
- [openlup/openlup#443](https://github.com/openlup/openlup/pull/443) finishes
  independently. This programme starts from whatever it lands.

## Non-goals

Changing the required context names or making `pgtap` required, changing any
migration or test, certifying stock PostgreSQL as a production target, and
building a general database-environment framework.

## Decisions requested

The owner decides direction, scope (pgTAP lane only, or the managed-image
consumers in required `test` too), the extension supply route, the shadow
window and whether a non-blocking managed-image fidelity lane stays. The plan's
[owner decisions](neutral-postgres-pgtap.md#owner-decisions) section lists each
decision with a recommendation.
