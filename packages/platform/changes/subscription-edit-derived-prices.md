---
kind: fix
---

Native bundle edits can now add derived-only subscription SKUs and apply the
accepted price to future renewal terms. In Platform 1.3.x and 1.4.0, these edits were
refused with `subscription_edit_catalog_unavailable`.

Migration: Apply the subscription-edit derived prices forward through the
selected native migration catalogue.
