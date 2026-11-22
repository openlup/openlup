---
type: fix
---

Tax verifiers report oversized canonical JSON as `tax_invalid_input` with a
size remedy at the document's JSON Pointer. Missing and explicitly undefined
required calculation evidence both point to `/evidenceDigest`.
