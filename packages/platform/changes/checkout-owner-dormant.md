---
type: feat
---

Qualified PostgreSQL installations can record an issued checkout-owner grant while the login is absent. The experimental `applyPlatformCheckoutOwnerGrant` operation lets the definition owner apply it later. Verified checkout permissions are local to the database and leave its canonical inventory unchanged for connected-store restore.

Migration: Ordinary qualified upgrades need no checkout login. Use the [database upgrade handoff](../../core/docs/guide/upgrade/database-migrations.md#prepare-the-optional-checkout-owner) to prepare the role, preserve TEMP access and verify the grants on a supported opt-in installation.
