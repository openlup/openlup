- Add opt-in `createPostgresCommerceQuoteCatalogReadPort` in the existing catalog
  entry. It reuses strict envelopes, guards current payload revision facts and
  requires host schema, semantic identity and digest verification. Bounded
  scans refuse incomplete authority without partial success; current-direct
  consistency does not qualify a publication head or publication-wide snapshot.
