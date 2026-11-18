Add experimental native catalogue membership paging and activation-readiness
reads. Pages carry exact publication, SKU revision and document references.
The readiness batch checks requested SKUs against an expected head.

Migration: Apply the additive native publication reads forward through the
complete package catalogue before using the experimental methods. Existing
readers can continue to use the same rows and functions. The forward requires
no backfill or transfer data changes.

Managed divergence design: A managed twin could read the matching publication,
SKU revision and document tables under RLS, using the trusted server role for
the bounded projections. Keep helper functions private to the read authority.
The managed rail does not supply this feature.
