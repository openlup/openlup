Node host shutdown now fences its stopped scheduler registrations and waits for
admitted callbacks, including pending lock acquisition and asynchronous unlock,
before closing the dedicated advisory-lock session. Other hosts remain excluded
until the running job releases ownership. Shutdown still attempts the listener
and lock cleanup, caches its promise and aggregates failures in the existing order.
PostgreSQL advisory locks now refuse locally pending or held numeric keys,
including colliding job IDs, so a dedicated session cannot reenter a job lock.
Failed acquisition permits a later attempt; failed unlock remains reserved until
the session closes.

Migration: `NodeSchedulerAdapter.stopAll()` explicitly returns `Promise<void>`
instead of `void`. Await it before disposing resources used by admitted callbacks.
It fences/stops current timers synchronously and supports later registrations.
The only in-tree production caller, `createNodeHost`, awaits that drain before
closing the lock; its public `stop(): Promise<void>` signature remains unchanged.
Custom implementations of `NodeSchedulerAdapter` must return the drain promise.
