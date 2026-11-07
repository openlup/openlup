- Native lifecycle delivery now routes operator payment-repair notices through
  their latest customer failure template, requeues transient delivery failures
  and bounds recovered history by current case truth and configurable recency.
- Optional dispatch policy configures claim leases, attempts and retry backoff.
  Recovered policy configures the inclusive window. The run result includes
  requeued notices. Accepted receipts retain acknowledgement recovery.

Migration: Hosts may supply a failed delivery receipt with `retryable: false`
for a final rejection. An omitted disposition means transient. Exceptions retain
the sending lease. Read the lifecycle binding policy before selecting a host.

Native event and reminder policy refusals now terminally complete the original
source. Missing recipients, disabled controls and refused consent remain terminal
after policy changes, restart and connected store transfer. These records do not
assert delivery or change the dunning flow or transactional delivery receipts.
