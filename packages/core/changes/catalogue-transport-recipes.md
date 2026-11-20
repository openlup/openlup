Ships a runnable TypeScript catalogue pack and nine installed recipes for checking
owned definitions and fixtures. The static JSON sample remains available.

Migration: Keep `owned/catalogue.json` for the existing wrapper. For a pristine
starter, take `owned/catalogue.ts` from a fresh extraction of the target set. For
a customized starter, reconcile the target registration and lazy registry around
your own types and validators. Preserve your validation behavior and retain
the unit factor migration. Run both starter scripts, `catalogue:check` and
`catalogue:check:source`. Correct invalid registry definitions
before starting the host. Follow the starter's existing installed-rules
procedure if you opt into rule installation. These wrappers require no database upgrade.
