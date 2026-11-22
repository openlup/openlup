---
type: feat
---

Add the experimental `@openlup/platform/tax/stripe` adapter for exclusive tax
quotes and qualified fee-free reporting. Applications supply an account-bound
client, a versioned market pack and read-only callbacks for reporting evidence.
Use `tax.adapter` and `tax.classMap` to discover composition and class mapping.
The tax port also adds a recalculation-probe capability and a comparison helper.
