### Fulfillment HTTP transport hardening

- `@openlup/platform/fulfillment/omnipack` keeps the per-attempt request timeout active while streaming response bodies, enforces a 5 MiB response body byte limit with stream cancellation on overflow or abort, validates product SKUs in `productSync.addProductPack` before URL construction, and applies bounded backoff honoring `Retry-After` on retryable `GET` responses.

Migration: No action required; public signatures and wire contracts are unchanged.
