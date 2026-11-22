### Decode exact physical quantities

The experimental catalogue decoder validates typed read payloads with Core's
unit and factor rules. The numeric mass helper returns grams when the
transport can carry the exact decimal.

### Upgrade sized subscription and renewal mail readers

The managed upgrade replaces pristine `host/editor-ports.ts` and
`host/editor-mail.ts` with the target starter files. If either file has local
edits, move adopter policy into an owned file or reconcile its edits against
the target. Replan and apply before starting the upgraded app. The starter
refuses startup during an incomplete upgrade. Existing gram-only installs
need no new setting or SQL step for these readers.

### Upgrade typed SKU refusals in the starter

The managed upgrade also replaces pristine `host/quote-composition.ts`,
`host/purchase-composition.ts`, and `shared/api.ts`. The quote and checkout
actions expose the affected SKU code with the V1 typed-quantity refusal.
Reconcile local customizations through the same managed upgrade before
startup. The starter needs no additional install setting.
