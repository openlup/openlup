- Improve `openlup-context search` to resolve exact exported symbols directly to their declared public package subpath via installed `package.json#exports` declaration entrypoints while keeping non-entrypoint declaration occurrences clearly marked unverified.
- Scope `@openlup/core` `.api.md` declaration snapshots to each subpath's own directory and explicit re-exports without changing any exported runtime or type symbol.

Migration: No application changes required. All `@openlup/core` public exports remain unchanged; only cross-subpath duplicate sections in generated `.api.md` snapshots were removed.
