export function renewalEmailDedupeKey(subscriptionId: string, renewalAt: string): string {
  const parsed = new Date(renewalAt);
  const day = Number.isNaN(parsed.getTime()) ? renewalAt : parsed.toISOString().slice(0, 10);
  return `${subscriptionId}:${day}`;
}

export function renewalOutboxIdempotencyKey(subscriptionId: string, renewalAt: string): string {
  return `subscription_renewal_upcoming:${renewalEmailDedupeKey(subscriptionId, renewalAt)}`;
}
