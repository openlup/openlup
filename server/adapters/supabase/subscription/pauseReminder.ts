export type RpcError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

export type PauseReminderJobResult = {
  ok: boolean;
  scanned: number;
  queued: number;
  sent: number;
  skippedRows: number;
  failed: number;
  reason?: string;
  skipped?: boolean;
};

type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

const RPC_NAME = "subscription_dispatch_pause_reminders";

export function createSupabaseSubscriptionPauseReminderPort(client: RpcClient) {
  return {
    async dispatch(limit: number): Promise<PauseReminderJobResult> {
      const { data, error } = await client.rpc(RPC_NAME, { p_limit: limit });
      if (error) return resultFromError(error);
      return toResult(data);
    },
  };
}

function resultFromError(error: RpcError): PauseReminderJobResult {
  if (isMissingRpc(error)) {
    return {
      ok: true,
      skipped: true,
      reason: "subscription_pause_reminder_rpc_missing",
      scanned: 0,
      queued: 0,
      sent: 0,
      skippedRows: 0,
      failed: 0,
    };
  }
  return {
    ok: false,
    skipped: false,
    reason: safeMessage(error.message ?? "subscription_pause_reminder_rpc_failed"),
    scanned: 0,
    queued: 0,
    sent: 0,
    skippedRows: 0,
    failed: 1,
  };
}

function isMissingRpc(error: RpcError): boolean {
  const combined = `${error.code ?? ""} ${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`;
  return /\bPGRST202\b|\b42883\b|could not find.*function|function .* does not exist|schema cache/i.test(combined);
}

function toResult(data: unknown): PauseReminderJobResult {
  const row = Array.isArray(data) ? data[0] : data;
  const value = row && typeof row === "object" ? row as Record<string, unknown> : {};
  return {
    ok: value.ok !== false,
    scanned: numberValue(value.scanned),
    queued: numberValue(value.queued),
    sent: numberValue(value.sent),
    skippedRows: numberValue(value.skipped),
    failed: numberValue(value.failed),
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}
