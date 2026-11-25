### Declare seeded product physical facts

The starter takes a typed mass and a primary GTIN through its owned product
configuration. It retains the existing seed documents and identifiers when
the original physical facts are preserved.

Migration: For a pristine `owned/store.config.ts`, copy the candidate file.
For a customized file, convert each `physical` entry in place. Move the old
`netWeightG` to `netContent` with `dimension: 'mass'`, `unit: 'openlup:g'`,
`scale: 0` and the original whole grams as the decimal string `unscaled`.
Move `issuer` and `unitGtin` into `primaryUnitIdentifier` as `issuer` and
`value`, with `scheme: 'gs1:gtin'`. Keep all the original GTIN digits and the
issuer for all six demonstration entries, or carry over each corresponding
custom value. Preserve unrelated owned edits and apply the managed upgrade.
Restart and recheck `/api/config`. An unchanged seed replay requires no
installed-policy step.

If startup reports `OPENLUP_E_STARTER_PRODUCT_PHYSICAL_INVALID`, correct the
named entry from verified facts. If an issuer correction changes its retained
digest, follow “Reset an interrupted first install” for an owner-approved
rebuild of the disposable demonstration in the same Compose project.
That procedure removes all data in the demo volume. If startup reports
`OPENLUP_E_STARTER_SYNTHETIC_PHYSICAL_SIZE_INVALID`, correct the named SKU's
numeric `physicalSize` in `owned/subscription-editing.ts` to a verified whole
gram value from 1 through 2147483647. Restart and recheck `/api/config`.
