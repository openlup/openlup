Adds experimental stock-wait reads for operators, operational evidence, and
owned customer accounts. Operators can page through cases, see complete shortage
totals, and distinguish recorded payments from missing intent evidence. The
health check uses current shortage, check time, and persisted notice progress.

Migration: No database changes are required. Bind the server-side reader to
the native or managed subscription graph with a request-authorized executor
that opens one read-only repeatable-read transaction per invocation.
