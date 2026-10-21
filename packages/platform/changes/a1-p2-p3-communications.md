- Add a separately opt-in reference host binding for `communications/resend` and
  `communications/klaviyo`. Lazy host inputs and invocation-time admission guard
  sending, authenticated callbacks, native delivery polling and current marketing
  ports, including newsletter refusal. An explicit poll-kind table bridges the
  native writer without changing public ports. Routes, schedules and handlers
  default to empty; existing default wiring remains unchanged. Eight offline
  cases include actual host composition against locally packed entries without
  SDKs or optional peers. No provider activation or stable runtime claim is made.

- Add experimental opt-in Node `communications/klaviyo` with one marketing-sync
  factory, singleton profile projection, negative-only consent readback, deletion
  acknowledgement and authoritative consent push. Host identity/authority and
  atomic account storage fence replay, generation, cooling and ambiguous effects.
  Account-dependent capabilities remain verification pending; deletion status is
  unsupported and newsletter sync refuses. No SDK, default binding, flow control,
  historical import, suppression edits or automatic mutation retry is added.
  Migration: opt in through the new subpath and supply its private host wiring;
  existing neutral providers and communications entries remain unchanged.
