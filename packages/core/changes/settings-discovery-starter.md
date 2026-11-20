### Discover and preview settings with the package command

- Use the settings script from the extracted application root as shown in its `AGENTS.md`.
  The settings script calls the installed experimental `openlup settings`
  command. `show` and `explain` work offline. To preview, pass the proposal with
  `--value <json>` or `--value -` for stdin.
- Upgrade the managed `package.json` and `ownership.json` to the target
  extraction. Include `owned/settings-host.ts` as a creation in the target
  snapshot only if that file is absent in the application. Keep an existing
  owned file and its local bindings. Append the **Change a business setting**
  section from the target's `AGENTS.md` to the application's guide when absent.
- If the upgrade refuses because the planned host path became occupied, keep the
  local file and remove its creation from the target snapshot. Replan and apply
  the reconciled snapshots, then replay. The installed application upgrades with
  its local host bindings intact. Follow
  `show inventory_renewal_protection --json`
  to verify the command. Stock or reminder policy installation remains a separate
  deployment step.
