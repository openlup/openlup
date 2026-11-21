For the next 1.x release. Native catalogue publication accepts exact authored
mass, volume and whole counts in installed units. Gross parcel mass remains
independent. Existing whole-gram rules can continue to use `validateSkuAmounts`.
Use `validateSkuQuantities` to accept typed content and gross mass.

Migration: Apply the complete catalogue through
`20261124190000_catalog_quantity_serving.sql` before deploying the new writer
or restoring a current native capture. The legacy gram column stays readable
and uses NULL for typed content without an exact positive integer gram
equivalent. Existing rows and sealed publication evidence retain their bytes.

The typed product binding in `@openlup/platform/fulfillment/omnipack` accepts
explicit gross parcel mass. The
`productLdV2` helper emits weight for a supplied mass. Both accept installed
conversion factors for custom units.
