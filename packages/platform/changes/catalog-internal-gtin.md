Use the experimental `catalogInternalGtin` export from `@openlup/platform/catalog`
to assign a store-local trade identifier to a SKU without a globally assigned GTIN.
Product JSON-LD omits 13-digit restricted-circulation numbers with prefixes
`02`, `04` and `20`–`29` from `gtin13`.
