export type AlertIncidentClass =
  | "customer_communication_failure"
  | "scheduled_job_failed"
  | "scheduled_job_missed"
  | "fulfillment_tracking_stalled"
  | "configuration_drift"
  | "data_integrity"
  | "queue_backlog"
  | "recipient_configuration_failure"
  | "platform_watchdog";

export type AlertHumanContext = {
  incidentClass: AlertIncidentClass;
  impact: string;
  firstAction: string;
  urgency: string;
};
