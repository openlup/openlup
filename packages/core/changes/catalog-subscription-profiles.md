### Declare fixed-day subscription profiles

`@openlup/core/catalog` adds versioned subscription profile declarations and
`@openlup/core/subscription` adds `CadenceChoiceV1`. A v1 install accepts unique
fixed-day choices from 1 to 3660 and an optional profile cap. The calendar-month
discriminator is reserved.
