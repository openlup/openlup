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
