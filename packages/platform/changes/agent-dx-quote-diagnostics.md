- Clarify the offline fulfillment conformance failure for missing provider
  selection: `prepare(providerRef:null)` must return `selection_required` before
  I/O. The expected refusal and zero-I/O requirement are unchanged.
