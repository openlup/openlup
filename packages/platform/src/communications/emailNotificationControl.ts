export interface EmailNotificationControlPort {
  isEnabled(slug: string, signal: AbortSignal): Promise<boolean>;
}

export interface EmailNotificationControlClient {
  from(table: string): EmailNotificationControlQueryBuilder;
}

interface EmailNotificationControlQueryBuilder {
  select(columns: string): EmailNotificationControlQueryBuilder;
  eq(column: string, value: unknown): EmailNotificationControlQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export function createEmailNotificationControlPort(
  client: EmailNotificationControlClient,
  createPolicy: (client: EmailNotificationControlClient) => { shouldDeliver(input: { slug: string; signal: AbortSignal }): Promise<{ allow: boolean }> },
): EmailNotificationControlPort {
  const policy = createPolicy(client);
  return {
    isEnabled(slug: string, signal: AbortSignal): Promise<boolean> {
      return policy.shouldDeliver({ slug, signal }).then((decision) => decision.allow);
    },
  };
}

// Compatibility alias for the pre-neutralization lifecycle consumer.
export const createSupabaseEmailNotificationControlPort = createEmailNotificationControlPort;
