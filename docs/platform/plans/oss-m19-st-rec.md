# PostgreSQL checkout recovery token port

## Outcome and scope

Add `createPostgresCheckoutRecoveryTokenPort` to the existing commerce server
entry, implementing the checkout recovery token port over installed PostgreSQL
storage and routines. A trusted host may issue a token only for an order it has
already admitted. Preserve initial subscription mode and cadence from persisted
order facts. Issuing a new link ends the previous link of the same order.

## Authority and delivery boundary

Code comparison base: `4d78e855cf8bbd57704f9503cd7bae28f96453a5`.
Current instruction revision at handoff: `5054c53dc81b246b81fb77122aeb71f92cfbdd75`.
The changed review/documentation instructions were read separately from the code
base. All package sources and build/pack inputs are byte-identical between those
main revisions; no merge was made solely for freshness. Work is confined to this dedicated task worktree. This run may edit and run
focused local proof, create scanned local WIP snapshots, and prepare a stabilized
public API packet for a maintainer decision. It stops before DCO sign-off,
submission, native review, merge or release. The package leaf lands before the
starter recovery entry. No adopter repository changes are authorized.

## Exclusions

No SQL, grants, controls, new package subpath, multiple live links, reminders,
mail delivery, settlement wrapper, arbitrary order reader or starter changes.
If existing privileges or persisted facts cannot support the outcome, stop for
a maintainer decision rather than extending this boundary.

## Acceptance and sufficient evidence

Issue uses one transaction, locks the order and client, accepts principal-less
contacts, requires pending payment and an exact creation-plus-24-hour expiry,
stores only a hash, rotates prior links, and preserves identical-hash replay.
Inspection uses the native routine, normalizes consumed states, refuses unknown
states, and validates only active pending orders. Initial subscription facts
come from persisted declarations rather than caller input.

Real PostgreSQL regression witnesses cover guests, replay, rotation, conflicting
hashes, refused orders, expiry, concurrent terminal transitions, state priority,
paid confirmation, subscription facts, effective runtime grants and unchanged
actor/dunning behavior. Existing affected contract tests, lint, strict types,
build, structural rules, publication policy, neutrality and real package size
measurements provide the remaining local evidence.

## Risk and proof plan

The material risks are concurrent payment/cancellation, mistaken authority,
credential disclosure and lost subscription declaration facts. First inspect
native ownership and grants; then add the smallest adapter and tests. Run cheap
checks before gated focused stages. Record exact source identities, measured
package delta and any missing evidence in the private decision packet. No
canonical verification is authorized in this run.

## Run summary

Implemented the opt-in factory and extended inspection type, with no SQL, grant,
subpath or runtime composition change. The executor accepts the existing
transaction lane structurally; its declaration does not import optional driver
types. The shared expiry field is retained but the database chooses the exact
deadline. There is no separate order reader or payment operation.

The 13-case real PostgreSQL witness passed using the actual installer-managed
runtime, including guest/actor separation, replay, rotation, terminal-transition
locks, native states, quote/declaration facts and existing dunning behavior. Its
owned named container and volume were removed. Eleven focused state/error cases,
strict package builds, lint, public typecheck and a driver-free declaration
check pass. All 69 selected test files passed: 4,381 cases, no skips, with
599.216 seconds of summed test command execution. The existing import-map,
package-boundary, cold-consumer and source-preview witnesses pass. Final full
lint and the API report check pass. No canonical verification, native review,
DCO sign-off or delivery is claimed.

On exact base main, a real pack measures 2,444,144 packed bytes and 1,957,339
code-class bytes: +4,689 and +4,448 respectively, with three additional files.
The refreshed main changes only review/documentation controls and leaves every
package/pack input byte-identical, so these totals also apply after that landed
change. No additional unmerged row is assumed ahead of this leaf; a changed
landing position needs a fresh combined measurement.

Self-retro: the first database fixture omitted matching money lines and failed
before adapter execution. Reusing the native order-and-item transaction fixed
that setup defect. A structural transaction signature also removed unnecessary
optional-driver declaration coupling without changing emitted runtime bytes.
The exact cold-consumer export inventory was checked late and needed its one
new factory row; its rerun cost 40.827 seconds plus 92.312 seconds awaiting the
gate. Updating that inventory alongside the export follows the existing cheap
contract-first rule. No separate process change or successor work is needed.
