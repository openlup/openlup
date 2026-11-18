Adds the experimental catalogue subscription profile declaration and its
shared, browser-safe validator. The validator checks structural policy binding,
cadence bounds, quantity ranges, substitution groups and add-on declarations.

Migration: Existing catalogue quantity contracts keep their shape. The accepted
reference can carry the optional experimental subscription profile key, version
and digest. Upgrade the OpenLup packages together before binding admission.
