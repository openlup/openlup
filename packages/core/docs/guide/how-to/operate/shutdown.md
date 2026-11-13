# Shut down a host cleanly

Drain admitted background callbacks before disposing the resources they use.
Await the `stop()` promise returned by `serveNode` from
`@openlup/platform/composition` in your host's shutdown handler.

## Drain before disposal

1. Prevent your application from registering new work and stop external
   admission while preserving access needed by already-admitted callbacks.
2. Call and await the host's `stop()`. Repeated calls return the same cached
   promise.
3. After that promise settles, dispose application-owned database pools,
   transports and other callback dependencies. Handle a rejected stop as a
   shutdown failure.

The scheduler synchronously fences its current registrations and stops every
supplied timer with its original method receiver. It waits for all admitted
callbacks, including callbacks still waiting to acquire their lock, through
lock release. A stopped registration cannot admit a later callback.

The host keeps its local HTTP listener available during that drain: an admitted
job may still need its HTTP compatibility request after acquiring a lock. Do not
close the listener or its dependencies ahead of `stop()`.

## Handle failures and custom schedulers

After the drain settles, the host attempts both listener closure and dedicated
advisory-lock session cleanup, even when the drain failed. Rejections from the
drain or either cleanup attempt are collected in an `AggregateError` with message
`node_host_shutdown_failed`. Inspect those failures before restarting or claiming
a clean stop; another call to the cached `stop()` does not retry cleanup.

If you use `createNodeScheduler` from `@openlup/platform/scheduler` directly,
await `stopAll(): Promise<void>`. A custom scheduler must preserve that asynchronous
drain contract. The adapter permits new registrations after `stopAll()`, so your
host must prevent registration during shutdown; stopping current timers is not
a permanent admission barrier.
