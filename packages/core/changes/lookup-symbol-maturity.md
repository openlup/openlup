### Report maturity and deprecation in `openlup-context` symbol hits

- `openlup-context` export hits for a symbol now carry `maturity` (`stable`, `experimental` or `testing`) in `--json` output and in the MCP tool's structured hits, and `deprecated: true` for a symbol tagged `@deprecated`. Text output ends the hit with `; maturity <value>` and `; deprecated`.
- A symbol tagged `@experimental` in its own declaration comment, or under a tagged re-export statement, reports `experimental`. Any other symbol reports its subpath's maturity from `release-gates.json`. A hit has no `maturity` when the declaration was not found inside the package, or when no subpath maturity is known and no `@experimental` tag applies; in either case, read the declaration.
- The maturity reference lists, for each package, the symbols whose maturity differs from their subpath's or that are deprecated.
