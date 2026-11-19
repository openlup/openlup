### Preview renewal stock protection in the starter

- Take the target extraction's `host/settings.ts`
  through the managed upgrade plan and apply. If local edits cause a conflict,
  move them to an application-owned file outside both snapshots and restore the
  exact predecessor bytes in `host/settings.ts`. Replan and apply with the
  same snapshots. Keep the app stopped until the managed snapshot and installed
  OpenLup package versions match.
- For a pristine starter, take the target extraction's `AGENTS.md`. If you
  customized that file, carry the preview paragraph and example from the
  target's **Change a business setting** section into your guide and preserve
  your local instructions.
- Verify the command with
  `node --experimental-strip-types host/settings.ts preview --help`. Follow
  the target guide to preview a proposed value against your installation.
  Preview uses a read-only transaction. The installer applies policy changes
  at deployment.
