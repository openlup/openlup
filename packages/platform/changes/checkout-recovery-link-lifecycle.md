# Checkout recovery link lifecycle

Checkout recovery links for one admitted purchase now coexist until expiry or
payment. Identical-hash replay and cross-order refusal remain unchanged. Pending
renewal-cycle orders refuse checkout issuance. Payment-case links still rotate,
with issuance serialized on the pending order; the separate actor issuer also
retains rotation. Install the complete native migration chain before using the
updated checkout issuer.
