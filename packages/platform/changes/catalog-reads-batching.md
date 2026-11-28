- `@openlup/platform/catalog` batches `createPostgresCatalogPublicationReads().reads.history` and `createPostgresCatalogDraftStoreV4().list` into constant-count PostgreSQL queries per page instead of per-row queries, preserving verification, ordering, cursor, byte-cap, and refusal semantics.

Migration: No action required; no public API or schema changes.
