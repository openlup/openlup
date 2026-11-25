### Let the runtime evaluate the checkout abandonment predicate

A forward adds `public.commerce_checkout_abandonment_safe_runtime(uuid)`, which
returns the unchanged `public.commerce_initial_checkout_abandonment_safe(uuid)`
predicate and is executable by `service_role` where that role exists. A
qualified runtime login can then check whether an unpaid initial checkout is
safe to cancel before it asks for the cancellation. The predicate itself keeps
its definition and ACL; PUBLIC, `anon` and `authenticated` cannot execute
either function. Apply the forward with the rest of the catalogue; it needs no
operator action.
