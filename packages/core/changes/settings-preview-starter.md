### Preview renewal stock protection in the starter

- Take the target extraction's `host/settings.ts` and `host/editor-ports.ts`
  through the managed upgrade plan and apply. Reconcile local managed-file
  edits against the predecessor and target before applying. A divergent
  managed file refuses; keep the app stopped until the managed snapshot and
  installed OpenLup package versions match.
- For a pristine starter, take the target extraction's `AGENTS.md`. If you
  customized that file, carry the preview paragraph and example from the
  target's **Change a business setting** section into your guide and preserve
  your local instructions.
- Verify the command with
  `node --experimental-strip-types host/settings.ts preview --help`. Follow
  the target guide to preview a proposed value against your installation.
  Preview uses a read-only transaction. The editor now reads the installed
  horizon and picks up installer changes on the next stock read. No separate
  installed-policy write is needed to upgrade these files.
