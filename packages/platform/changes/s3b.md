Add the unbound catalogue attribute owner validator, injected allowlisted batch
reference resolution and pure preparation for the single SKU-keyed projection.
Supplied malformed values refuse; required values/locales are publication
readiness issues. Each product/SKU attribute object independently fits the 1 MiB
PostgreSQL-rendered text storage ceiling, including separator spaces and UTF-8
string bytes. Numeric exponent expansion is conservatively bounded; admitted
attribute shapes are counted exactly. Oversized objects refuse with
`attribute_storage_too_large` and the product/SKU owner path. The aggregate
canonical JSON safety bound remains separate. Signed decimals remain strings, and Core quantity conversion
refuses inexact or overflowing canonical numeric values before SQL.

Migration: additive server exports and shared conformance codes only. Existing
V1 drafts, DTOs, canonical bytes and readers are unchanged. Compose the new owner
with installed definitions explicitly; do not pass attribute values to V1 drafts.
Old readers ignore the nullable storage introduced separately. Future V2 readers
must consume publication evidence. Shared conformance guidance and installed
recipe links include all new attribute codes beside the offline checker's codes.
The checker still checks definitions, exact quantities and v1 drafts only;
attribute-value/projection checker integration remains pending. No SQL, data backfill, runtime writer or
serving switch is included; rolling back this helper cannot rebuild or publish
stored values. LC1/LC2 still own validation/digest/atomic publication integration,
and later serving/restore work owns shadow generations and rebuilding.

The L1 required-locale witness proves readiness and the admission predicate;
it does not prove an actual publish has zero effects. Managed storage enablement
remains absent: the managed rail does not supply this feature. All capabilities
remain unbound; subscription agreements are unaffected.
