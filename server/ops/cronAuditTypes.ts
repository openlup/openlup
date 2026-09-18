export type Env = {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

export type AuditResult = {
  status: number;
  body: Record<string, unknown>;
};

export type SupabaseClientLike = {
  from: (table: string) => unknown;
};

export type QueryResponse<T> = {
  data: T[] | null;
  error: { message?: string } | null;
  count?: number | null;
};

export type QueryBuilder<T> = PromiseLike<QueryResponse<T>> & {
  eq: (...args: unknown[]) => QueryBuilder<T>;
  gte: (...args: unknown[]) => QueryBuilder<T>;
  in: (...args: unknown[]) => QueryBuilder<T>;
  is: (...args: unknown[]) => QueryBuilder<T>;
  limit: (...args: unknown[]) => QueryBuilder<T>;
  neq: (...args: unknown[]) => QueryBuilder<T>;
  not: (...args: unknown[]) => QueryBuilder<T>;
  order: (...args: unknown[]) => QueryBuilder<T>;
  select: (...args: unknown[]) => QueryBuilder<T>;
};

export type EmailSendRow = {
  id: string;
  tester_id: string | null;
  template_slug: string | null;
  status: string | null;
  sent_at: string | null;
  resend_id: string | null;
};

export type TesterAuditRow = {
  id: string;
  status: string | null;
  delivered_at: string | null;
  email_sequence_paused: boolean | null;
  tracking_number?: string | null;
  dhl_last_checked_at?: string | null;
  dhl_last_codes?: string[] | null;
};

export type FeedbackAuditRow = {
  id?: string;
  tester_id: string;
  hash: string | null;
  submitted_at: string | null;
  section_c_submitted_at?: string | null;
};

export type RewardOutboxAuditRow = {
  id: string;
  aggregate_id: string;
  status: string;
  processed_at: string | null;
  metadata: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
};

export type RewardDeliveryAuditRow = {
  outbox_event_id: string | null;
  status: string;
  last_error_code: string | null;
  provider_kind: string | null;
  provider_message_id: string | null;
  email_send_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  metadata: Record<string, unknown> | null;
};

export const TRACKED_EMAIL_TEMPLATES = [
  "daily-report",
  "packaging-digest-daily",
  "feedback-mid",
  "feedback-final",
  "feedback-reminder",
];

export const FEEDBACK_TEMPLATES = ["feedback-mid", "feedback-final", "feedback-reminder"];
