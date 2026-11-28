---
kind: feature
---

- Native privacy exports can include evidence about the subject's renewal occurrences.

Migration: The new field, callback, and argument are optional, so existing
source compiles unchanged. Native installations must apply the platform SQL
migrations before deploying this runtime. A runtime-only upgrade against an
installation that has the renewal occurrence storage but not the new privacy
reader refuses native privacy export and erasure with a 503 until the SQL is
applied.

- The `identity-contracts`, `identity`, `marketing-server`, and `risk-server`
  snapshots gain two declarations, `RenewalOccurrencePrivacyEvidence` and
  `renewalOccurrencePrivacyEvidenceSchema: OperatorSchema<RenewalOccurrencePrivacyEvidence[]>`.
- In those snapshots, `PersonalDataDocument` previously went from `data: PrivacyJson;`
  directly to `coverage`. It now includes `renewalOccurrences?: RenewalOccurrencePrivacyEvidence[];`
  between those fields.
- In `identity`, `PrivacyUseCaseDependencies<Context>` previously went from `store`
  directly to `now(): Date;`. It now includes
  `verifyMissingSubject?(context: Context, subject: PrivacySubjectRef): Promise<void>;`
  between those declarations.
- In `identity`, `nativePrivacyUnavailable(cause: unknown): PrivacyRefusal` becomes
  `nativePrivacyUnavailable(cause: unknown, facts?: PrivacyRefusalFacts): PrivacyRefusal`.
