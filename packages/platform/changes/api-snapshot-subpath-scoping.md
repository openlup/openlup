- Scope `@openlup/platform` `.api.md` declaration snapshots to each subpath's own directory, unowned internal helpers, and explicit re-exports (including local `import`/`export` re-exports) instead of duplicating pure type/value imports from sibling declared subpaths.

  Migration: No runtime or type API change; every exported symbol across all 71 `@openlup/platform` subpaths is unchanged. Snapshot files now omit transitive import-only declarations owned by sibling subpaths, which remain tracked in each sibling subpath's own `.api.md` report.
