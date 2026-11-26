### Native tax evaluation privacy

Native stores can transfer evaluation rows and compose their privacy obligations.
PostgreSQL refuses a new erasure receipt that lacks `tax-calculations` with
the message `PRIVACY_CONTRIBUTOR_MISSING` and SQLSTATE `55000`. If a guarded
native handler reaches this insert refusal, it returns HTTP 503 with
`PRIVACY_ASSESSMENT_UNAVAILABLE` and the native prerequisite facts.

Migration: Apply the native catalogue that declares `tax-calculations`. Add
`createTaxCalculationPrivacyContributor()` from `@openlup/platform/identity`
to every serving native privacy registry as described in **Export and erasure**
in the **Personal data** guide. Retry the original erasure request after rollout.
