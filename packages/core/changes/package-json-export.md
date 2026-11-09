- Export `./package.json`, so tooling and agents can read the installed
  version and metadata with `import.meta.resolve("@openlup/core/package.json")` or
  a JSON import. It adds no code entry point.
