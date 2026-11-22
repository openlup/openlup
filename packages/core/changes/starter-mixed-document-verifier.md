### Upgrade the starter catalogue document verifiers

The starter shares verification of the selected gram SKU across quote and
sized servicing. This upgrade prepares verification of mixed documents once
the installed reader can supply authenticated sibling evidence.

Upgrade replaces pristine copies of `host/editor-catalogue.ts`,
`host/editor-ports.ts` and `host/quote-composition.ts` together. If apply
reports a conflict, save the customized code, restore the predecessor files
and rerun apply. Reconcile the saved changes against the replacement group
before startup. A partial upgrade refuses startup with
`incomplete_application_upgrade`. This change requires no installed-policy
step.
