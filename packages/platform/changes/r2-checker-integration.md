Wire separate attribute/projection and V2 combination fixtures into the existing
offline checker using their owner validators and unchanged owner codes/paths.
Later validators and requested checks without fixtures return required evidence
unavailable; missing/unavailable plain reference evidence returns 2, and unique
positive dangling/private answers return 1.

Migration: For the unreleased 0.44.0 set, await the single
`runCatalogExtensionConformance(subject): Promise<CatalogConformanceReport>` entry.
The CLI awaits it automatically. Supply plain data recursively: finite primitives,
dense arrays with Array.prototype, and Object.prototype/null-prototype objects
with string-keyed own data descriptors. Frozen/non-enumerable data remains valid;
omit optional fields rather than supplying undefined. Accessors, symbols, other
prototypes, typed arrays, functions in data, non-finite values, holes, cycles and
throwing inspection traps return `conformance_input_not_plain_data` at the exact
JSON pointer, exit 1. Getters are never invoked. Existing explicit callback slots
remain trusted code; their results use the same descriptor snapshot and identity
cache as the subject. Owners consume only frozen captured data. Native binary
retained identities require the server owner directly; the checker never converts
them. Report fields, exit-code vocabulary, ordering and v1 bytes remain unchanged.
No database migration, installation, publication or activation occurs.
