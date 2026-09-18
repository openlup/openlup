export const EMAIL_NOTIFICATION_ADMIN_DISABLED = "admin_disabled";

export const EMAIL_NOTIFICATION_CONTROL_FAMILY_KEYS = [
  "auth-*",
  "subscription-payment-failed-*",
  "survey_*_notification",
] as const;

export function emailNotificationControlKeys(slug: string): string[] {
  const keys = [slug];
  if (/^auth-[a-z_]+$/.test(slug)) keys.push("auth-*");
  if (/^subscription-payment-failed-\d+$/.test(slug)) keys.push("subscription-payment-failed-*");
  if (/^survey_(producer|consumer)_notification$/.test(slug)) keys.push("survey_*_notification");
  return keys;
}
