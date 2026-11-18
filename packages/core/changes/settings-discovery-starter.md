### Starter settings discovery

- From the extracted app, run
  `node --experimental-strip-types host/settings.ts list` to discover settings. The script also provides `show` and `explain`.
  Read `docs/guide/how-to/operate/configure-settings.md` in the installed Core
  package.
- For a pristine starter, take the target extraction's `AGENTS.md`. If you
  customized that file, add the target's **Change a business setting** section
  alongside your local instructions.
- Plan and apply the managed-file upgrade with `package.json`,
  `ownership.json` and the new `host/settings.ts` in the target snapshot.
  Reconcile any local script edits before applying. An upgrade plan refuses
  divergent managed files. Keep the app stopped until the managed snapshot and
  the installed OpenLup package versions match.
- Verify discovery with
  `node --experimental-strip-types host/settings.ts show inventory_renewal_protection --json`.
  This step needs no database or installed-policy operation.
