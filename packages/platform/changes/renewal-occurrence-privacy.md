---
kind: feature
---

- Native privacy exports can include evidence about the subject's renewal occurrences.

Migration: Existing calls compile and behave as before when the new field,
callback, and argument are omitted.

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
