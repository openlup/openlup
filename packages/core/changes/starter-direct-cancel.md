### Upgrade the starter account cancellation flow

Active and paused subscription cards now submit cancellation directly with
optional feedback. When `subscriptionCare.retention.offerPresentation` is
omitted or set to `ask_permission_first`, the card asks before presenting one
available save offer. Use `off` to omit the question and offer. Startup refuses
any other value and names the setting and both choices.

Replace pristine `client/pages/account.ts`, `owned/copy.ts` and
`owned/settings-host.ts` with the target starter versions along with the other
managed starter updates. For a customized portal, replace the cancellation
dialog with the direct submit and optional one-off prompt from the target account
page. Keep cancellation available through the prompt and offer and submit any
acceptance separately. In customized copy, bring over the question, answer and
dismiss labels for each configured locale. In customized settings bindings,
report the effective presentation mode and update the actions and retention
descriptions. Missing required copy refuses startup with the missing key and
locale. Existing retention maps and action lists still load. This upgrade
requires no installed-policy step.
