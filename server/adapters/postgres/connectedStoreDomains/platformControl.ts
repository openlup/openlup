export const platformControlDomain = {
  owned: {
    controlsAndSettings: [
      "platform_communication_operators",
      "platform_control_operators",
      "platform_operational_controls",
      "platform_control_operations",
      "platform_alerts",
      "platform_alert_notifications",
      "platform_job_controls",
      "platform_job_runs",
      "sales_channels",
      "commerce_settings",
    ],
  },
  restore: {
    controlOperators: [
      "platform_control_operators",
    ],
    communicationOperators: [
      "platform_communication_operators",
    ],
    controlsAlertsAndJobs: [
      "platform_operational_controls",
      "platform_control_operations",
      "platform_alerts",
      "platform_alert_notifications",
      "platform_job_runs",
    ],
  },
  settings: {
    salesAndCommerce: [
      "sales_channels",
      "commerce_settings",
    ],
    jobControls: [
      "platform_job_controls",
    ],
  },
  allowedInsertTriggers: {},
} as const;
