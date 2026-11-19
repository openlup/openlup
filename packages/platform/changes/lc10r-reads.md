Adds experimental stock-wait reads for operator pagination and complete totals,
operational evidence and owned customer accounts. Native reads identify legacy
and successor generations explicitly. Operators can distinguish a known order
without an intent from a case without an order. Incomplete authoritative reads
fail visibly.

Migration: no new SQL. Install the complete native successor chain before
binding the native reader. Existing case and command readers are unchanged.
Bind a request-authorized server executor with a read-only repeatable-read
snapshot. The managed binding reads only the existing legacy tables under the
host's service authority. The managed rail does not supply successor reads.
