### Report upgrade conflicts once and name the repair

- `openlup upgrade plan` and `openlup upgrade apply` report one top-level JSON
  `conflicts` array, including on completion, replay and errors after successful
  argument parsing. Schema-range and managed-file refusals include named
  findings with repair and recheck instructions.
- The neutral starter refuses a missing or misbound `StoreConfig` before
  creating a pool. `openlup verify --app` includes the exact public
  `OPENLUP_E_STARTER_STORE_CONFIG_REQUIRED` diagnostic in the assembly failure's
  cause when recognized.

Migration:

- Upgrade tooling should read top-level `conflicts` instead of `plan.conflicts`
  and update strict report and text assertions to expect the named findings.
  The first-party adopter featured in the repository README uses neither upgrade
  command, so its CLI migration cost is zero.
- Starter observers should pass the selected `StoreConfig` third and the optional
  keyring fourth to `composeNativeBindings`. Update exact verify-output assertions
  for the allowlisted case. The first-party adopter has zero cost for package
  adoption. Its use of custom observers or copied starter source is unknown.
