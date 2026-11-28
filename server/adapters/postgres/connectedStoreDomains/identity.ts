export const identityDomain = {
  owned: {
    humanPrincipals: [
      "platform_human_principals",
      "platform_human_memberships",
      "platform_human_membership_audit_events",
    ],
    customerConsents: [
      "customer_account_consent_events",
      "customer_account_consent_sync_targets",
    ],
    invitationsPrivacyAndCustomer: [
      "identity_operator_invitations",
      "identity_operator_invitation_events",
      "identity_privacy_erasures",
      "identity_privacy_erasure_reconciliations",
      "customer_subject_lifecycle_events",
      "customer_communication_preferences",
      "customer_communication_preference_events",
      "customer_account_events",
      "customer_saved_addresses",
      "customer_payment_preferences",
      "customer_delivery_preferences",
      "customer_orderer_profiles",
    ],
    settings: [
      "client_absorption_policy",
    ],
  },
  restore: {
    humanPrincipals: [
      "platform_human_principals",
    ],
    clientsAndMemberships: [
      "clients",
      "platform_human_memberships",
      "platform_human_membership_audit_events",
    ],
    invitationsPrivacyAndCustomer: [
      "identity_operator_invitations",
      "identity_operator_invitation_events",
      "identity_privacy_erasures",
      "identity_privacy_erasure_reconciliations",
      "customer_subject_lifecycle_events",
      "customer_communication_preferences",
      "customer_communication_preference_events",
      "customer_account_events",
      "customer_saved_addresses",
      "customer_payment_preferences",
      "customer_delivery_preferences",
      "customer_orderer_profiles",
    ],
    customerConsents: [
      "customer_account_consent_events",
      "customer_account_consent_sync_targets",
    ],
  },
  settings: [
    "client_absorption_policy",
  ],
  allowedInsertTriggers: {
    identity_privacy_erasures: ["tax_calculation_privacy_guard"],
    clients: ["customer_subject_capture_lifecycle_trigger"],
  },
} as const;
