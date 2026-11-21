### Upgrade the starter account cancellation flow

Active and paused subscription cards now submit cancellation directly with
optional feedback. When `subscriptionCare.retention.offerPresentation` is
omitted or set to `ask_permission_first`, the card asks before presenting one
available save offer. Use `off` to omit the question and offer. Startup refuses
any other value and names the setting and both choices.

Replace pristine `client/pages/account.ts`, `owned/copy.ts` and
`owned/settings-host.ts` with the target starter versions along with the other
managed starter updates.

If `upgrade apply` reports a conflict because a customized file matches
neither snapshot, keep the customized file and get that file from the
predecessor and target starter extractions. Set `predecessor` and `target` to
the roots of those extractions. From the application root, reconcile each
affected path against those two versions. For example,

```sh
git merge-file -p client/pages/account.ts \
  "$predecessor/client/pages/account.ts" \
  "$target/client/pages/account.ts" > account.reconciled.ts
```

Resolve any conflict markers in the output and replace the live account page
with the reconciled file. Retain the application's edits and bring over the target direct
submit, the one-off prompt and separate offer acceptance. Repeat for customized
`owned/copy.ts` and `owned/settings-host.ts`. In each locale, remove the old
`careGuidance` and `confirmCancel` keys and add `careOfferPermission`,
`careOfferYes`, `careOfferNo` and `careDismissOffer`. In settings bindings,
report the effective presentation mode and update the actions and retention
descriptions.

For this upgrade, remove only the manually reconciled paths from the `files`
objects in both snapshots. Rerun `upgrade apply` with those snapshots to apply the remaining
managed updates. Install the target dependencies and run the starter's `typecheck` npm script
on the reconciled application. Missing required copy refuses startup with the
missing key and locale. Existing retention maps and action lists still load.
This upgrade requires no installed-policy step.
