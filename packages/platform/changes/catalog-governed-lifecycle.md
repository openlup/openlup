- Add opt-in native catalogue drafts v4 and governed publication readback v3. Withdrawal closes both fresh-sale channels while retaining SKU facts and offer memberships. A parent-only restore leaves its SKUs unavailable for fresh sales.
- Select governed drafts at genesis. A predecessor without certified lifecycle state needs explicit adoption. Archive is refused until the commerce barrier is available.

Migration: Install the complete native migration catalogue before composing the
v4 draft handler and store. Keep existing v3 compositions for previously
issued lineages. Consumers of the experimental publication result can branch on
`schemaVersion` to recover original v2 or governed v3 receipts.
Hosts should stop sending the removed experimental `CatalogPublicationEvidence.lifecycle.skus[].demandPolicyRef` field.
