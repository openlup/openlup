### Add a bounded owner lock hook to the native admission fence

The catalogue testing fence accepts an optional `prelock` callback for owner
locks before receipt and catalogue acquisition. Read and authenticate replay
after the visibility probe. Confirmed contention, visibility changes and budget
expiry direct callers to retry with the same key. Infrastructure failures
direct callers to the native binding, connection, privileges and migrations.

On hook expiry, the fence discards the writer connection. The fence key is
released within the hook budget plus the wall margin plus two writer round
trips, allowing for writer connection latency before PostgreSQL starts the
statement's timeout.
