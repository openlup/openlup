---
type: feat
---

Qualified PostgreSQL installations can record an issued checkout-owner grant while the login is absent. The experimental `applyPlatformCheckoutOwnerGrant` operation lets the definition owner apply it later. Verified checkout permissions are local to the database and leave its canonical inventory unchanged for connected-store restore.

Migration: Ordinary qualified upgrades need no checkout login. Use the [database upgrade handoff](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/docs/platform/DATA_AND_MIGRATIONS.md#closed-native-store-forwards) to prepare the role, preserve TEMP access and verify the grants on a supported opt-in installation.
