### Starter catalogue unit factor

- For a pristine starter, take the target extraction's `owned/catalogue.ts`.
  It declares one `openlup:piece` per `starter:each`.
- For a customized starter, add the exact factors from `owned/catalogue.json`
  to the corresponding count units in `owned/catalogue.ts`. For a unit that
  represents one piece, use `{ canonicalUnit: 'openlup:piece', unscaled: '1', scale: 0 }`.

No database step is required.
