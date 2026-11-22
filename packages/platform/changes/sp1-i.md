- Opt into immutable native subscription profile installation with `subscriptionProfileDefinitions`. Manifests and offline checks use Core's declaration validator. The owner can read the exact installed profile and policy pins with `readInstalledCatalogSubscriptionProfile`.
- Connected-store capture refuses stores with profile receipts until connected-store restore supports them (RS-1).

Migration: Handle `subscription_profile_receipts_unsupported` in exhaustive
switches over `PostgresTransferFailure`.
