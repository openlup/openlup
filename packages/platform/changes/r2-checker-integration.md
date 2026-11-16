Wire separate attribute/projection and V2 combination fixtures into the existing
offline checker using their owner validators and unchanged issue codes. Supplied
references and retained facts remain trusted offline evidence. Later validators
and requested checks without fixtures return required-evidence-unavailable.

Migration: For the unreleased 0.44.0 set, await the single
`runCatalogExtensionConformance(subject): Promise<CatalogConformanceReport>` entry.
The CLI awaits it automatically. Add optional `attributes` and `combinations`
fixtures separately from unchanged v1 drafts; the installed recipe guide describes
their shape. Report fields, exit codes, sorting and released imports are unchanged.
No database migration, installation, publication or activation occurs.

Reference issues retain their owner code/path while absent or unavailable resolver
evidence reports exit 2; only a single positive dangling/private answer is a
violation (exit 1). Combination owner paths are retained in full under the fixture
input, including option locations and SKU identities. No report fields are added.

Attribute validation and reference classification now share the attribute owner's
canonical snapshot, retaining non-enumerable own data and its rejection of getters,
symbols and unsupported prototypes. CLI subject descriptors and explicit combination
owner fields preserve non-enumerable data; closed fixture envelopes check all own
keys rather than silently dropping hidden or symbol keys.
