Adds the experimental catalogue subscription profile declaration and its
shared, browser-safe validator. The validator checks structural policy binding,
cadence bounds, quantity ranges, substitution groups and add-on declarations.

Migration: Existing catalogue quantity and accepted-reference contracts keep
their shapes. Use the versioned profile declarations explicitly and upgrade the
OpenLup packages together before binding runtime admission.
