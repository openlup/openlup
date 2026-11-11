- Add service-only checkout recovery snapshots, nullable order lineage, capability-gated expired inspection and an adopter-owned content validation fence. Inspection grants no payment authority and creates no replacement; renewal orders refuse.

Migration: Apply the additive native-store forward before composing the new readers. Existing lineage remains null. The self-FKs restrict deletion, and each immediate predecessor can have one replacement.

- @openlup/platform size growth: Inspection, lineage readers and the validation policy fit the inherited package limits; no cap adjustment is required.
