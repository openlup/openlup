- Add `commerce/server/native-checkout` for restricted-runtime native draft
  persistence. It preserves quote and draft money snapshots, replays one durable
  receipt and refuses changed input without superseding or paying the order.
  Existing native money-shape limits remain; no SQL or managed behavior changes.
