### Declare fixed-day subscription profiles

`@openlup/core/catalog` adds versioned subscription profile declarations and
`@openlup/core/subscription` adds `CadenceChoiceV1`. A v1 install accepts unique
fixed-day choices from 1 to 3660 and an optional profile cap. The calendar-month
discriminator is reserved.

Catalogue readiness can report `catalog_profile_binding_invalid` with the
affected profile key and version while retaining the product type digests.

Migration: With opt-in profile checks, handle `catalog_profile_binding_invalid`
as a profile binding issue. The existing `registry_missing_referenced_version`
code still reports type registry mismatches or incomplete type observations.
