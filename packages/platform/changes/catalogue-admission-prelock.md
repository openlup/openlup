### Add a bounded owner lock hook to the native admission fence

The catalogue testing fence accepts an optional `prelock` callback for owner
locks before receipt and catalogue acquisition. Read and authenticate replay
after the visibility probe. Confirmed contention, visibility changes and budget
expiry direct callers to retry with the same key. Infrastructure failures
direct callers to the native binding, connection, privileges and migrations.

On fence expiry the writer is discarded. The fence key is released within the
fence budget plus 50 ms plus two writer round trips. Writer latency delays
delivery of the timeout settings and the lock request. In the no-injected-latency
witness the bound is budget plus 50 ms.

When upgrading a call without a hook, pass an integer budget of 1 to
2147483647 milliseconds covering the whole pre-read phase. The fence snapshots
its input and options at entry. Update fake drivers and trace assertions for
guarded writer queries, timeout capture and restoration, and the probe's
remaining allowance. Handle the existing same-key retry and checklist hints
and the `40001` visibility refusal.
