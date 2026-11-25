### Let the runtime evaluate the checkout abandonment predicate

A forward grants EXECUTE on `public.commerce_initial_checkout_abandonment_safe(uuid)`
to `service_role` where that role exists, so a qualified runtime login can check
whether an unpaid initial checkout is safe to cancel before it asks for the
cancellation. The predicate's definition is unchanged; PUBLIC, `anon` and
`authenticated` still cannot execute it. Apply the forward with the rest of the
catalogue; it needs no operator action.
