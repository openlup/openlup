### Starter catalogue unit factor

- For a pristine starter, take the target extraction's `owned/catalogue.ts`.
  It declares one `openlup:piece` per `starter:each`. The existing
  `owned/catalogue.json` already declares this factor.
- For a customized starter, reconcile corresponding units in
  `owned/catalogue.ts` and `owned/catalogue.json`. Keep your local type and
  unit identities, actual conversion ratios, and content validator. Use the
  TypeScript definitions as the source for metadata also declared in JSON.
  Keep or add the `catalogDraftTypeRefs` export for the starter's parity test.
  Derive one `{ key, version }` per authored type from the same `types` array
  you pass to create the registry.
- Apply the managed-file upgrade and run the starter's test suite to check for
  drift. A missing factor is allowed at startup, while an invalid declared
  factor can cause registry construction to refuse. No database or
  installed-policy operation is required.
