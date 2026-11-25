### Change a live base price in the demonstration starter

After Activation, an active administrator can edit `basePrices` in
`owned/catalogue.ts` and run the starter's `catalogue:apply` script with
`--reprice`.
Approval covers gross base amounts. Each receipt reports the effective
subscription figure and policy revision after the write. Default apply verifies
the publication receipts and live prices after Activation.

Upgrade replaces the pristine managed lifecycle, refusal and operator files
together. If upgrade reports a conflict, save your changes, restore the
predecessor files, apply the upgrade and reconcile your changes with the updated
files before startup. If a starter command refuses after applying only some
managed changes, compare the managed files with the target upgrade and complete
the upgrade before retrying. Keep declarations in `owned/catalogue.ts`.
The upgrade requires no price write or installed policy step.
