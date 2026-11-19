- Read native stock availability for a batch of SKUs using the installed
  renewal protection horizon through `createPostgresStockAvailability(...).readInstalled(skus)`.
  The read uses one PostgreSQL statement for stock and the installed horizon.

Migration: Apply the complete native catalogue through
`20261123142000_inventory_renewal_protection_validation.sql`. The existing
horizon reader calls the extracted validator with its existing privileges.
The explicit-horizon TypeScript port and the 14-day fallback keep their
established behavior.
