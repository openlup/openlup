Add `memoizeCommerceQuoteCatalogReads` to share one catalog authority read across an offer projection and its quotes.

Migration: Existing callers can retain their current composition. To opt in, create one wrapper per request and pass it to the projection and its quote ports.
