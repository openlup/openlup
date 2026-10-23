Close the scheduled native stock-evidence refresh/reopen gap with forward
`20261022165000_fulfillment_stock_evidence_replay_reopen.sql` and its byte-identical
fulfillment package projection. Matching fingerprints refresh severity and nullable
quantities, reopen status, and clear `resolved_at`; identity, first-seen time and
historical resolver metadata survive. Existing-row replays and resolution serialize
on the row lock. Fingerprint mismatches still raise `23505`.

Migration: install the complete canonical native catalogue through `20261022165000`
before stock adoption, preserving its immutable ledger prefix. Sparse package SQL
is not a standalone install chain. The managed baseline already has this behavior.
Legacy 0.22.0 whole-input fingerprints are not rewritten and still conflict with
PR1 identity fingerprints, including after resolution.
