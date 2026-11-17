- Add optional `CustomerSavedAddressValidationPolicy.local` callbacks through
  the existing stable `@openlup/platform/shipping` subpath. This additive stable
  API change requires the next minor release. No new subpath is introduced.
- Hosts may normalize and validate their local postal format and normalize or
  refuse their local phone format. Callbacks apply only to the selected local
  country (including aliases), must be effect-free and cannot perform I/O or
  authorization. A throw refuses the affected field with its existing policy
  message. Schema creation rejects missing or nonfunction local callbacks with
  `saved_address_policy_invalid`.
- Omitting `local` preserves the compatible five-digit postal and nine-digit /
  configured-prefix phone behavior. Platform length bounds, normalization order,
  aliases, foreign-country handling and message keys remain in force. Removing
  the compatible defaults is separate future work; no migration is required.
