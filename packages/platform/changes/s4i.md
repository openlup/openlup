Distinguish combination identity integrity failures from incoming SKU identity
changes in the unbound V2 combination owner for target package set 0.44.0.

Migration: handle the additive `combination_identity_integrity_failed` code for
inconsistent authoritative option identity evidence and colliding derived
digests. An incoming mapped identity change still reports
`sku_identity_change_requires_new_sku`. The earlier `combination_digest_collision`
code remains in the exported union and guidance record for compatibility;
`validateCatalogCombinationChangesV2` now reports the new integrity code for
that condition. Refusal conditions, validation order and all other behavior stay
unchanged. No SQL migration, writer activation or capability change is required.
