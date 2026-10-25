- Managed commerce migrations preserve the exact reviewed fixture bytes and ordered prerequisite chain.
Migration: Guest configurator destinations do not rewrite saved delivery or payment preferences; preference writes require a server-proved matching account.
Migration: Legacy omitted-country fallback uses `platform_region_code()` for address identity and insertion; configure the adopter's settlement region. Neutral commands require explicit country.
Migration: Return creation and replay require the server-supplied principal's owned order and identical normalized command; foreign or changed commands refuse atomically.
Migration: Checkout payment-link receipts use the service-only operator entry point and the `checkout_payment_link_mint` audit action.
Migration: Subscription finalize validates retained acquisition terms under the shared policy lock; policy writers require its exclusive counterpart. Completed finalize replay preserves its response after policy changes; one-time checkout is exempt.
Migration: The acquisition terms reader refuses absent effective terms; the no-policy finalize compatibility branch remains available.
Migration: New-purchase stock reads use ATP with renewal exemption fixed false, bounded SKU arrays and conservative stale reporting. The service-only reader uses owner privileges with `SECURITY DEFINER` and `search_path = pg_catalog, pg_temp`.
Migration: Starter graduation admits 14, 21 or 28 days, while provisional creation uses the retained starter interval and subscription timezone default. Rolling back below the forward with a 21-day marker is unsupported; roll forward.
